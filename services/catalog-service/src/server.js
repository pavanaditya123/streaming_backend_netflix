import { bootstrap, startServer, config, createLogger } from '@streaming/shared';
import { createCatalogApp } from './app.js';
import { createCatalogRepo } from './repo/index.js';
import { TITLES } from '../../../db/seed/titles.js';

const log = createLogger('catalog-service');
const { bus, cache, shutdown } = await bootstrap('catalog-service');

const repo = createCatalogRepo();

// In memory mode there is no migration step, so load the seed catalog on boot.
if (config.drivers.data === 'memory') {
  const n = await repo.upsertMany(TITLES);
  log.info({ titles: n }, 'seeded in-memory catalog');
}

const app = createCatalogApp({ repo, cache, bus });
startServer(app, config.ports.catalog, { onShutdown: shutdown });
