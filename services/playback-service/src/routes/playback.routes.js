import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, validate, internalOnly, internalUser, prefixedId,
  NotFoundError, ForbiddenError, TOPICS, EVENTS, createEvent, createLogger
} from '@streaming/shared';
import { authorizePlayback, isCompleted } from '../domain/entitlement.js';

const log = createLogger('playback-service');

const startSchema = z.object({
  titleId: z.string().min(1),
  deviceId: z.string().min(1).max(64).default('web'),
  isKidsProfile: z.boolean().default(false)
});

const progressSchema = z.object({ positionSeconds: z.number().int().min(0) });

const toApi = (s) => ({
  id: s.id,
  titleId: s.title_id,
  deviceId: s.device_id,
  quality: s.quality,
  status: s.status,
  positionSeconds: s.position_seconds,
  startedAt: s.started_at,
  endedAt: s.ended_at
});

export function createPlaybackRouter({ repo, bus, catalogClient, subscriptionClient }) {
  const router = Router();
  router.use(internalOnly, internalUser);

  /**
   * POST /playback/sessions — the entitlement check + stream start.
   *
   * Two upstream calls (entitlement, title) run in parallel, and both are cached
   * on the other side, which is why this stays fast on the hot path.
   */
  router.post(
    '/sessions',
    validate({ body: startSchema }),
    asyncHandler(async (req, res) => {
      const { titleId, deviceId, isKidsProfile } = req.body;
      const userId = req.user.id;
      const ctx = { user: req.user, requestId: req.id };

      const [entitlementRes, titleRes] = await Promise.all([
        subscriptionClient.get('/subscriptions/entitlement', ctx),
        catalogClient.get(`/titles/${encodeURIComponent(titleId)}`, ctx)
      ]);

      const title = titleRes.title;
      if (!title) throw new NotFoundError(`Title not found: ${titleId}`);

      const active = await repo.activeSessionsForUser(userId);

      const decision = authorizePlayback({
        entitlement: entitlementRes,
        title,
        activeStreams: active.length,
        profile: { isKid: isKidsProfile }
      });

      if (!decision.allowed) {
        // 403 with a machine-readable reason so the client can show the right
        // upsell ("upgrade your plan") vs. error ("too many devices").
        throw new ForbiddenError(decision.message, {
          reason: decision.reason,
          upgradeTo: decision.upgradeTo,
          activeStreams: decision.activeStreams,
          maxStreams: decision.maxStreams
        });
      }

      const now = new Date().toISOString();
      const session = await repo.createSession({
        id: prefixedId('ses'),
        user_id: userId,
        title_id: titleId,
        device_id: deviceId,
        quality: decision.quality,
        status: 'playing',
        position_seconds: 0,
        started_at: now,
        last_heartbeat_at: now,
        created_at: now
      });

      // Publish a fact and await the broker acknowledgement. Playback does not
      // wait for watch-history, catalog, or notification consumers to run.
      await bus.publish(
        TOPICS.PLAYBACK_EVENTS,
        createEvent(
          EVENTS.PLAYBACK_STARTED,
          {
            sessionId: session.id,
            userId,
            titleId,
            titleName: title.title,
            deviceId,
            quality: decision.quality,
            durationSeconds: (title.durationMinutes || 0) * 60
          },
          { key: userId, correlationId: req.id }
        )
      );

      log.info({ sessionId: session.id, userId, titleId, quality: decision.quality }, 'playback started');

      res.status(201).json({
        session: toApi(session),
        // A real CDN would sign this URL; the shape is what matters here.
        manifestUrl: `https://cdn.example.com/${titleId}/${decision.quality}/master.m3u8`,
        availableQualities: decision.availableQualities,
        concurrentStreams: { used: active.length + 1, max: entitlementRes.maxStreams }
      });
    })
  );

  /** Heartbeat + progress. The client calls this every ~30s while playing. */
  router.post(
    '/sessions/:id/progress',
    validate({ body: progressSchema }),
    asyncHandler(async (req, res) => {
      const session = await ownedSession(repo, req);
      if (session.status !== 'playing') throw new ForbiddenError(`Session is ${session.status}`);

      const now = new Date().toISOString();
      const updated = await repo.updateSession(session.id, {
        position_seconds: req.body.positionSeconds,
        last_heartbeat_at: now
      });

      await bus.publish(
        TOPICS.PLAYBACK_EVENTS,
        createEvent(
          EVENTS.PLAYBACK_PROGRESS,
          {
            sessionId: session.id,
            userId: req.user.id,
            titleId: session.title_id,
            positionSeconds: req.body.positionSeconds
          },
          { key: req.user.id, correlationId: req.id }
        )
      );

      res.json({ session: toApi(updated) });
    })
  );

  /** Stop. This is what produces a watch-history row and the resume point. */
  router.post(
    '/sessions/:id/stop',
    validate({ body: progressSchema.partial() }),
    asyncHandler(async (req, res) => {
      const session = await ownedSession(repo, req);
      const now = new Date().toISOString();
      const position = req.body.positionSeconds ?? session.position_seconds;

      const updated = await repo.updateSession(session.id, {
        status: 'stopped',
        position_seconds: position,
        ended_at: now
      });

      const title = await catalogClient
        .get(`/titles/${encodeURIComponent(session.title_id)}`, { user: req.user, requestId: req.id })
        .catch(() => null);
      const durationSeconds = (title?.title?.durationMinutes || 0) * 60;

      await bus.publish(
        TOPICS.PLAYBACK_EVENTS,
        createEvent(
          EVENTS.PLAYBACK_STOPPED,
          {
            sessionId: session.id,
            userId: req.user.id,
            titleId: session.title_id,
            titleName: title?.title?.title,
            positionSeconds: position,
            durationSeconds,
            completed: isCompleted(position, durationSeconds),
            watchedSeconds: position
          },
          { key: req.user.id, correlationId: req.id }
        )
      );

      log.info({ sessionId: session.id, position }, 'playback stopped');
      res.json({ session: toApi(updated) });
    })
  );

  router.get(
    '/sessions',
    asyncHandler(async (req, res) => {
      const items = await repo.listByUser(req.user.id);
      res.json({ items: items.map(toApi) });
    })
  );

  router.get(
    '/sessions/active',
    asyncHandler(async (req, res) => {
      const items = await repo.activeSessionsForUser(req.user.id);
      res.json({ items: items.map(toApi), count: items.length });
    })
  );

  return router;
}

async function ownedSession(repo, req) {
  const session = await repo.findSession(req.params.id);
  if (!session) throw new NotFoundError('Session not found');
  if (session.user_id !== req.user.id) throw new ForbiddenError('Not your session');
  return session;
}
