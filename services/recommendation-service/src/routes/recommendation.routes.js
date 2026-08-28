import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, validate, internalOnly, internalUser,
  withCache, cacheKeys, hashKey, config, createLogger
} from '@streaming/shared';
import { parseIntent, INTENT_NAMES, INTENTS } from '../domain/intent-parser.js';
import { toCatalogQuery, explain, seededShuffle, excludeCompleted, PERSONALIZED_INTENTS } from '../domain/resolver.js';

const log = createLogger('recommendation-service');

const searchSchema = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(50).optional().default(12)
});

export function createRecommendationRouter({ cache, catalogClient, historyClient, vocabulary }) {
  const router = Router();
  router.use(internalOnly);

  /** Self-documenting: every intent the parser supports. */
  router.get('/intents', (_req, res) => {
    res.json({
      count: INTENT_NAMES.length,
      intents: INTENTS.map((i) => ({ name: i.name, describes: i.describe }))
    });
  });

  /**
   * POST /recommendations/search — natural-language search.
   *
   * Parse (sub-ms, in-process) -> fetch (cached catalog call) -> rank -> explain.
   * Cached per (user, query) so a repeated search is a single Redis GET.
   */
  router.post(
    '/search',
    internalUser,
    validate({ body: searchSchema }),
    asyncHandler(async (req, res) => {
      const started = process.hrtime.bigint();
      const { query, limit } = req.body;
      const userId = req.user.id;
      const ctx = { user: req.user, requestId: req.id };

      const parsed = parseIntent(query, await vocabulary.get(ctx));

      const cacheKey = cacheKeys.recommendation(
        PERSONALIZED_INTENTS.has(parsed.intent) ? userId : 'all',
        hashKey({ intent: parsed.intent, slots: parsed.slots, limit })
      );

      const { value, cached } = await withCache(
        cacheKey,
        config.cacheTtl.recommendation,
        () => resolve({ parsed, limit, ctx, catalogClient, historyClient }),
        { cache }
      );

      const tookMs = Number(process.hrtime.bigint() - started) / 1e6;

      log.info({ query, intent: parsed.intent, results: value.items.length, tookMs, cached }, 'recommendation');

      res.json({
        query,
        intent: parsed.intent,
        intentDescription: parsed.describe,
        slots: parsed.slots,
        confidence: parsed.confidence,
        fallback: Boolean(parsed.fallback),
        explanation: explain(parsed.intent, parsed.slots, value.items.length),
        items: value.items,
        source: value.source,
        cached,
        tookMs: Number(tookMs.toFixed(1))
      });
    })
  );

  /** GET /recommendations/for-you — the personalised home rail. */
  router.get(
    '/for-you',
    internalUser,
    validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(30).default(12) }) }),
    asyncHandler(async (req, res) => {
      const { limit } = req.validatedQuery;
      const ctx = { user: req.user, requestId: req.id };

      const { value, cached } = await withCache(
        cacheKeys.recommendation(req.user.id, `for-you:${limit}`),
        config.cacheTtl.recommendation,
        () => forYou({ userId: req.user.id, limit, ctx, catalogClient, historyClient }),
        { cache }
      );

      res.json({ ...value, cached });
    })
  );

  return router;
}

/** Execute a parsed intent. */
async function resolve({ parsed, limit, ctx, catalogClient, historyClient }) {
  const { intent, slots } = parsed;

  // ---- personalised intents: answer from the user's own history ----------
  if (PERSONALIZED_INTENTS.has(intent)) {
    const history = await safeHistory(historyClient, ctx);

    if (intent === 'continue_watching' || intent === 'unfinished') {
      const inProgress = history.filter((h) => !h.completed && h.positionSeconds >= 30).slice(0, limit);
      const titles = await hydrate(inProgress.map((h) => h.titleId), catalogClient, ctx);
      return {
        items: titles.map((t) => {
          const h = inProgress.find((x) => x.titleId === t.id);
          return { ...t, resumeAtSeconds: h?.positionSeconds, progressPercent: h?.progressPercent };
        }),
        source: 'watch-history'
      };
    }

    if (intent === 'most_watched_by_me') {
      const top = [...history].sort((a, b) => b.playCount - a.playCount).slice(0, limit);
      return { items: await hydrate(top.map((h) => h.titleId), catalogClient, ctx), source: 'watch-history' };
    }

    // because_you_watched: seed from an explicit title, else the most recent one.
    const seedId = parsed.slots.seedTitleId || history[0]?.titleId;
    if (!seedId) {
      const trending = await catalogClient.get(`/titles/trending?limit=${limit}`, ctx);
      return { items: trending.items, source: 'trending (cold start — no history yet)' };
    }
    const similar = await catalogClient.get(`/titles/${encodeURIComponent(seedId)}/similar?limit=${limit}`, ctx);
    return { items: excludeCompleted(similar.items, history), source: `similar to ${seedId}` };
  }

  // ---- similar_to: a specific title was named -----------------------------
  if (intent === 'similar_to' && slots.seedTitleId) {
    const similar = await catalogClient.get(`/titles/${encodeURIComponent(slots.seedTitleId)}/similar?limit=${limit}`, ctx);
    return { items: similar.items, source: `similar to ${slots.seedTitle}` };
  }

  // ---- trending -----------------------------------------------------------
  if (intent === 'trending_now' && !slots.genre && !slots.type) {
    const trending = await catalogClient.get(`/titles/trending?limit=${limit}`, ctx);
    return { items: trending.items, source: 'trending' };
  }

  // ---- random -------------------------------------------------------------
  if (intent === 'random_pick') {
    const pool = await catalogClient.get(`/titles?limit=60&sort=rating`, ctx);
    // Seed on the hour so "surprise me" changes over time but is stable per hour.
    const seed = Math.floor(Date.now() / 3_600_000);
    return { items: seededShuffle(pool.items, seed).slice(0, limit), source: 'random' };
  }

  // ---- everything else: a filtered catalog query --------------------------
  const qs = toCatalogQuery(slots, { limit });
  const result = await catalogClient.get(`/titles?${qs}`, ctx);

  // A very specific query can legitimately return nothing — fall back to the
  // same query minus its narrowest filter rather than showing an empty screen.
  if (!result.items.length) {
    const relaxed = { ...slots };
    delete relaxed.minRating;
    delete relaxed.maxDuration;
    delete relaxed.minDuration;
    delete relaxed.year;
    const fallback = await catalogClient.get(`/titles?${toCatalogQuery(relaxed, { limit })}`, ctx);
    return { items: fallback.items, source: 'relaxed filters (no exact match)' };
  }

  return { items: result.items, source: 'catalog' };
}

/** Home rail: continue watching first, then similar-to-recent, padded with trending. */
async function forYou({ userId, limit, ctx, catalogClient, historyClient }) {
  const history = await safeHistory(historyClient, ctx);

  const rails = [];
  const inProgress = history.filter((h) => !h.completed && h.positionSeconds >= 30).slice(0, 6);

  if (inProgress.length) {
    rails.push({
      title: 'Continue watching',
      items: await hydrate(inProgress.map((h) => h.titleId), catalogClient, ctx)
    });
  }

  if (history.length) {
    const seed = history[0];
    const similar = await catalogClient.get(`/titles/${encodeURIComponent(seed.titleId)}/similar?limit=${limit}`, ctx);
    rails.push({
      title: `Because you watched ${seed.titleName || seed.titleId}`,
      items: excludeCompleted(similar.items, history)
    });
  }

  const trending = await catalogClient.get(`/titles/trending?limit=${limit}`, ctx);
  rails.push({ title: 'Trending now', items: trending.items });

  return { userId, rails, coldStart: history.length === 0 };
}

async function hydrate(ids, catalogClient, ctx) {
  if (!ids.length) return [];
  // One batch call instead of N single lookups.
  const res = await catalogClient.post('/titles/batch', { ids }, ctx);
  const byId = new Map(res.items.map((t) => [t.id, t]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Watch history is a *nice-to-have* here. If that service is down, degrade to
 * non-personalised results rather than failing the whole search.
 */
async function safeHistory(historyClient, ctx) {
  try {
    const res = await historyClient.get('/watch-history?limit=50', ctx);
    return res.items || [];
  } catch (err) {
    log.warn({ err: err.message }, 'watch-history unavailable — degrading to non-personalised');
    return [];
  }
}
