/**
 * Boot the entire platform in ONE Node process.
 *
 * Each service still listens on its own port and still talks to the others over
 * real HTTP — the topology is unchanged. What is shared is the in-memory cache
 * and event bus, which is what makes `BUS_DRIVER=memory` work without Kafka.
 *
 *   npm run dev                       # everything in memory, zero infrastructure
 *   DATA_DRIVER=postgres CACHE_DRIVER=redis BUS_DRIVER=kafka npm run dev
 *
 * In Docker each service runs as its own container from its own src/server.js;
 * this runner exists so the project can be run and demoed on a laptop.
 */
import { setCache, setBus, createCache, createBus, config, createLogger } from '@streaming/shared';
import { TITLES } from '../db/seed/titles.js';

const log = createLogger('dev-all');

const cache = setCache(createCache());
const bus = setBus(createBus());
await bus.connect?.();

// ---- build each service -----------------------------------------------------
const { createUserApp } = await import('../services/user-service/src/app.js');
const { createCatalogApp } = await import('../services/catalog-service/src/app.js');
const { createPlaybackApp } = await import('../services/playback-service/src/app.js');
const { createWatchHistoryApp } = await import('../services/watch-history-service/src/app.js');
const { createSubscriptionApp } = await import('../services/subscription-service/src/app.js');
const { createBillingApp } = await import('../services/billing-service/src/app.js');
const { createNotificationApp } = await import('../services/notification-service/src/app.js');
const { createRecommendationApp } = await import('../services/recommendation-service/src/app.js');
const { createGatewayApp } = await import('../services/api-gateway/src/app.js');

const { createCatalogRepo } = await import('../services/catalog-service/src/repo/index.js');

const catalogRepo = createCatalogRepo();
if (config.drivers.data === 'memory') {
  await catalogRepo.upsertMany(TITLES);
  log.info({ titles: TITLES.length }, 'seeded in-memory catalog');
}

const services = [
  ['user-service', createUserApp({ bus }), config.ports.user],
  ['catalog-service', createCatalogApp({ repo: catalogRepo, cache, bus }), config.ports.catalog],
  ['playback-service', createPlaybackApp({ cache, bus }), config.ports.playback],
  ['watch-history-service', createWatchHistoryApp({ cache, bus }), config.ports.watchHistory],
  ['subscription-service', createSubscriptionApp({ cache, bus }), config.ports.subscription],
  ['billing-service', createBillingApp({ bus }), config.ports.billing],
  ['notification-service', createNotificationApp({ bus }), config.ports.notification],
  ['recommendation-service', createRecommendationApp({ cache }), config.ports.recommendation],
  ['api-gateway', createGatewayApp({ cache }), config.ports.gateway]
];

const servers = [];
for (const [name, app, port] of services) {
  await new Promise((resolve, reject) => {
    const server = app.listen(port, resolve).on('error', reject);
    servers.push({ name, server, port });
  });
}

log.info({ drivers: config.drivers }, 'platform started');
console.log('\n  Streaming platform is up\n');
for (const { name, port } of servers) {
  console.log(`    ${name.padEnd(24)} http://localhost:${port}`);
}
console.log(`\n  Frontend     http://localhost:${config.ports.gateway}`);
console.log(`  Public API   http://localhost:${config.ports.gateway}/api/v1`);
console.log(`  Health       http://localhost:${config.ports.gateway}/ops/services`);
console.log(`  Drivers      data=${config.drivers.data} cache=${config.drivers.cache} bus=${config.drivers.bus}\n`);
console.log('  Try:  npm run smoke     (full end-to-end walkthrough)');
console.log('        npm run bench     (cold vs cached latency)\n');

const shutdown = async () => {
  log.info('shutting down');
  await Promise.all(servers.map(({ server }) => new Promise((r) => server.close(r))));
  await bus.close?.();
  await cache.close?.();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { servers, bus, cache };
