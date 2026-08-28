import { config } from '@streaming/shared';
import { createMemoryBillingRepo } from './billing.repo.memory.js';
import { createPgBillingRepo } from './billing.repo.pg.js';

export function createBillingRepo(driver = config.drivers.data) {
  return driver === 'postgres' ? createPgBillingRepo() : createMemoryBillingRepo();
}
