import { createApp, config, postgres, getCache, serviceClient } from '@streaming/shared';
import { createPlaybackRouter } from './routes/playback.routes.js';
import { createPlaybackRepo } from './repo/index.js';

/**
 * playback-service — the write-heavy hot path. Decides whether a stream may
 * start, tracks the session, and publishes playback facts for everyone else.
 *
 * Its two synchronous dependencies (entitlement, title metadata) are injectable
 * so tests can run the real authorisation logic against stub upstreams.
 */
export function createPlaybackApp({
  repo = createPlaybackRepo(),
  cache = getCache(),
  bus,
  catalogClient = serviceClient(config.services.catalog, 'catalog-service'),
  subscriptionClient = serviceClient(config.services.subscription, 'subscription-service')
} = {}) {
  return createApp({
    service: 'playback-service',
    checks: {
      database: () => (config.drivers.data === 'postgres' ? postgres.healthy() : true),
      cache: async () => Boolean(await cache.ping()),
      bus: () => bus?.healthy?.() ?? true
    },
    routes: [
      { path: '/playback', router: createPlaybackRouter({ repo, bus, catalogClient, subscriptionClient }) }
    ]
  });
}
