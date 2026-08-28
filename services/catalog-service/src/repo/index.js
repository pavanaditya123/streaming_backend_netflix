import { config } from '@streaming/shared';
import { createMemoryCatalogRepo } from './catalog.repo.memory.js';
import { createPgCatalogRepo } from './catalog.repo.pg.js';

export function createCatalogRepo(driver = config.drivers.data) {
  return driver === 'postgres' ? createPgCatalogRepo() : createMemoryCatalogRepo();
}
