import { createApp, config, postgres, getCache } from '@streaming/shared';
import { createCatalogRouter } from './routes/catalog.routes.js';
import { createCatalogRepo } from './repo/index.js';
import { registerPlaybackConsumer } from './consumers/playback.consumer.js';

/**
 * catalog-service — the read-heavy service. Owns title metadata and serves it
 * to the gateway, playback and recommendations. Everything here is cache-aside.
 */
export function createCatalogApp({ repo = createCatalogRepo(), cache = getCache(), bus } = {}) {
  if (bus) registerPlaybackConsumer({ bus, repo, cache });

  const app = createApp({
    service: 'catalog-service',
    checks: {
      database: () => (config.drivers.data === 'postgres' ? postgres.healthy() : true),
      cache: async () => Boolean(await cache.ping()),
      bus: () => bus?.healthy?.() ?? true
    },
    routes: [{ path: '/titles', router: createCatalogRouter({ repo, cache }) }]
  });

  app.locals.repo = repo;
  return app;
}
