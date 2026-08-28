import { config } from '@streaming/shared';
import { createMemorySubscriptionRepo } from './subscription.repo.memory.js';
import { createPgSubscriptionRepo } from './subscription.repo.pg.js';

export function createSubscriptionRepo(driver = config.drivers.data) {
  return driver === 'postgres' ? createPgSubscriptionRepo() : createMemorySubscriptionRepo();
}
