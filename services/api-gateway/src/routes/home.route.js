import { Router } from 'express';
import { asyncHandler, withCache, cacheKeys, config, createLogger, serviceClient } from '@streaming/shared';

const log = createLogger('api-gateway:home');

/**
 * GET /api/v1/home — the Backend-for-Frontend endpoint.
 *
 * THIS IS THE ENDPOINT THE CACHING STORY IS ABOUT.
 *
 * One home screen needs data from four services. Done naively that is four
 * sequential network calls, each doing its own database work — which is how the
 * uncached path ends up around a second.
 *
 * Two things fix it:
 *   1. FAN OUT IN PARALLEL — the four calls are independent, so they run
 *      concurrently and the total is the slowest one, not the sum.
 *   2. CACHE THE COMPOSED RESULT — the whole assembled payload is cached under
 *      one key, so a warm request is a single Redis GET and no fan-out at all.
 *
 * `?fresh=1` bypasses the cache, which is what scripts/bench.js uses to measure
 * the cold path against the warm one.
 */
export function createHomeRouter({ cache, clients }) {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const started = process.hrtime.bigint();
      const ctx = { user: req.user, requestId: req.id, timeoutMs: 5000 };
      const bypass = req.query.fresh === '1';

      const { value, cached } = await withCache(
        cacheKeys.home(req.user.id),
        config.cacheTtl.home,
        () => composeHome(clients, ctx),
        { cache, enabled: config.cacheEnabled && !bypass }
      );

      const tookMs = Number(process.hrtime.bigint() - started) / 1e6;
      res.json({ ...value, cached, tookMs: Number(tookMs.toFixed(1)) });
    })
  );

  return router;
}

async function composeHome(clients, ctx) {
  // Every one of these is independent, so fan out rather than awaiting in turn.
  const [entitlement, trending, forYou, unread] = await Promise.all([
    clients.subscription.get('/subscriptions/entitlement', ctx).catch(degrade('entitlement')),
    clients.catalog.get('/titles/trending?limit=12', ctx).catch(degrade('trending')),
    clients.recommendation.get('/recommendations/for-you?limit=12', ctx).catch(degrade('for-you')),
    clients.notification.get('/notifications/unread-count', ctx).catch(degrade('notifications'))
  ]);

  // Every rail carries catalog titles in the same shape. The "continue watching"
  // rail comes from recommendation-service already hydrated (with resume
  // positions) rather than being rebuilt here from raw watch-history rows —
  // otherwise the client would get two different item shapes on one screen.
  const rails = [];
  for (const rail of forYou?.rails || []) {
    if (rail.items?.length) rails.push(rail);
  }
  if (trending?.items?.length && !rails.some((r) => r.title === 'Trending now')) {
    rails.push({ title: 'Trending now', items: trending.items });
  }

  return {
    user: { id: ctx.user.id, email: ctx.user.email },
    subscription: entitlement
      ? { entitled: entitlement.entitled, planId: entitlement.planId, maxQuality: entitlement.maxQuality }
      : { entitled: false, degraded: true },
    unreadNotifications: unread?.count ?? 0,
    rails
  };
}

/**
 * A single slow or broken service must not blank the whole home screen.
 * Each call degrades to null and the page renders with whatever arrived.
 */
function degrade(what) {
  return (err) => {
    log.warn({ err: err.message, dependency: what }, 'home dependency degraded');
    return null;
  };
}

export function createClients() {
  return {
    user: serviceClient(config.services.user, 'user-service'),
    catalog: serviceClient(config.services.catalog, 'catalog-service'),
    playback: serviceClient(config.services.playback, 'playback-service'),
    watchHistory: serviceClient(config.services.watchHistory, 'watch-history-service'),
    subscription: serviceClient(config.services.subscription, 'subscription-service'),
    billing: serviceClient(config.services.billing, 'billing-service'),
    notification: serviceClient(config.services.notification, 'notification-service'),
    recommendation: serviceClient(config.services.recommendation, 'recommendation-service')
  };
}
