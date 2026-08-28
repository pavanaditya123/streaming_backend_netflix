import { createApp, config, postgres, getCache } from '@streaming/shared';
import { createHistoryRouter } from './routes/history.routes.js';
import { createHistoryRepo } from './repo/index.js';
import { registerPlaybackConsumer } from './consumers/playback.consumer.js';

/**
 * watch-history-service — event-sourced from playback. Owns "continue watching",
 * per-title progress, and viewing stats.
 */
export function createWatchHistoryApp({ repo = createHistoryRepo(), cache = getCache(), bus } = {}) {
  if (bus) registerPlaybackConsumer({ bus, repo, cache });

  const app = createApp({
    service: 'watch-history-service',
    checks: {
      database: () => (config.drivers.data === 'postgres' ? postgres.healthy() : true),
      cache: async () => Boolean(await cache.ping()),
      bus: () => bus?.healthy?.() ?? true
    },
    routes: [{ path: '/watch-history', router: createHistoryRouter({ repo, cache }) }]
  });

  app.locals.repo = repo;
  return app;
}
