import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, validate, internalOnly, internalUser,
  withCache, cacheKeys, config, NotFoundError
} from '@streaming/shared';

const toApi = (e) => ({
  titleId: e.title_id,
  titleName: e.title_name,
  positionSeconds: e.position_seconds,
  durationSeconds: e.duration_seconds,
  progressPercent: e.duration_seconds
    ? Math.min(100, Math.round((e.position_seconds / e.duration_seconds) * 100))
    : 0,
  completed: e.completed,
  playCount: e.play_count,
  lastWatchedAt: e.last_watched_at
});

export function createHistoryRouter({ repo, cache }) {
  const router = Router();
  router.use(internalOnly, internalUser);

  /** Full history, paginated and cached per page. */
  router.get(
    '/',
    validate({
      query: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0)
      })
    }),
    asyncHandler(async (req, res) => {
      const { limit, offset } = req.validatedQuery;
      const page = `${limit}:${offset}`;

      const { value, cached } = await withCache(
        cacheKeys.watchHistory(req.user.id, page),
        config.cacheTtl.continueWatching,
        () => repo.listByUser(req.user.id, { limit, offset }),
        { cache }
      );

      res.json({ items: value.items.map(toApi), total: value.total, limit, offset, cached });
    })
  );

  /**
   * GET /watch-history/continue — rendered on every home screen load, so this is
   * one of the hottest reads in the platform and is always served from cache
   * unless a playback event has invalidated it.
   */
  router.get(
    '/continue',
    validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(30).default(10) }) }),
    asyncHandler(async (req, res) => {
      const { limit } = req.validatedQuery;

      const { value, cached } = await withCache(
        `${cacheKeys.continueWatching(req.user.id)}:${limit}`,
        config.cacheTtl.continueWatching,
        () => repo.continueWatching(req.user.id, { limit }),
        { cache }
      );

      res.json({ items: value.map(toApi), cached });
    })
  );

  router.get(
    '/stats',
    asyncHandler(async (req, res) => {
      res.json(await repo.stats(req.user.id));
    })
  );

  router.get(
    '/:titleId',
    asyncHandler(async (req, res) => {
      const entry = await repo.findEntry(req.user.id, req.params.titleId);
      if (!entry) throw new NotFoundError('No history for this title');
      res.json({ entry: toApi(entry) });
    })
  );

  router.delete(
    '/:titleId',
    asyncHandler(async (req, res) => {
      const deleted = await repo.deleteEntry(req.user.id, req.params.titleId);
      if (!deleted) throw new NotFoundError('No history for this title');
      await cache.delByPattern(`${cacheKeys.continueWatching(req.user.id)}:`);
      await cache.delByPattern(`wh:list:${req.user.id}:`);
      await cache.delByPattern(`reco:${req.user.id}:`);
      await cache.del(cacheKeys.home(req.user.id));
      res.status(204).end();
    })
  );

  return router;
}
