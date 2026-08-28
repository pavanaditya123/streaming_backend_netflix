import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, validate, NotFoundError, withCache, cacheKeys,
  hashKey, config, internalOnly
} from '@streaming/shared';
import { SORTABLE } from '../domain/filters.js';

const searchSchema = z.object({
  q: z.string().max(120).optional(),
  genre: z.string().max(40).optional(),
  mood: z.string().max(40).optional(),
  award: z.string().max(40).optional(),
  language: z.string().max(8).optional(),
  type: z.enum(['movie', 'series']).optional(),
  plan: z.enum(['basic', 'standard', 'premium']).optional(),
  maturity: z.enum(['U', 'UA', 'A']).optional(),
  person: z.string().max(80).optional(),
  director: z.string().max(80).optional(),
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  yearFrom: z.coerce.number().int().min(1900).max(2100).optional(),
  yearTo: z.coerce.number().int().min(1900).max(2100).optional(),
  minRating: z.coerce.number().min(0).max(10).optional(),
  minDuration: z.coerce.number().int().min(0).optional(),
  maxDuration: z.coerce.number().int().min(0).optional(),
  sort: z.enum(SORTABLE).default('popularity'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0)
});

export function createCatalogRouter({ repo, cache }) {
  const router = Router();

  // Catalog is read by other services, never directly by the public internet.
  router.use(internalOnly);

  /**
   * GET /titles — filtered search.
   *
   * Cached on a hash of the *normalised* filter object, so `?genre=action&limit=20`
   * and `?limit=20&genre=action` share one cache entry.
   */
  router.get(
    '/',
    validate({ query: searchSchema }),
    asyncHandler(async (req, res) => {
      const { sort, limit, offset, ...filters } = req.validatedQuery;
      const key = cacheKeys.titleList(hashKey({ filters, sort, limit, offset }));

      const { value, cached } = await withCache(
        key,
        config.cacheTtl.title,
        () => repo.search(filters, { sort, limit, offset }),
        { cache }
      );

      res.json({ ...value, limit, offset, cached });
    })
  );

  /** GET /titles/trending — hottest titles, driven by playback events. */
  router.get(
    '/trending',
    validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }) }),
    asyncHandler(async (req, res) => {
      const { limit } = req.validatedQuery;
      const { value, cached } = await withCache(
        `${cacheKeys.trending()}:${limit}`,
        config.cacheTtl.trending,
        () => repo.trending(limit),
        { cache }
      );
      res.json({ items: value, cached });
    })
  );

  router.get(
    '/facets',
    asyncHandler(async (_req, res) => {
      const { value, cached } = await withCache('catalog:facets', config.cacheTtl.title, () => repo.facets(), { cache });
      res.json({ ...value, cached });
    })
  );

  /** POST /titles/batch — bulk fetch, so callers avoid an N+1 of single GETs. */
  router.post(
    '/batch',
    validate({ body: z.object({ ids: z.array(z.string()).max(100) }) }),
    asyncHandler(async (req, res) => {
      const items = await repo.findManyByIds(req.body.ids);
      res.json({ items });
    })
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const { value, cached } = await withCache(
        cacheKeys.title(req.params.id),
        config.cacheTtl.title,
        () => repo.findById(req.params.id),
        { cache }
      );
      if (!value) throw new NotFoundError(`Title not found: ${req.params.id}`);
      res.json({ title: value, cached });
    })
  );

  router.get(
    '/:id/similar',
    validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(30).default(8) }) }),
    asyncHandler(async (req, res) => {
      const { limit } = req.validatedQuery;
      const title = await repo.findById(req.params.id);
      if (!title) throw new NotFoundError(`Title not found: ${req.params.id}`);

      const { value, cached } = await withCache(
        `catalog:similar:${req.params.id}:${limit}`,
        config.cacheTtl.title,
        () => repo.similar(req.params.id, limit),
        { cache }
      );
      res.json({ items: value, cached });
    })
  );

  return router;
}
