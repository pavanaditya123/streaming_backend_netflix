import { config } from '@streaming/shared';
import { createMemoryNotificationRepo } from './notification.repo.memory.js';
import { createPgNotificationRepo } from './notification.repo.pg.js';

export function createNotificationRepo(driver = config.drivers.data) {
  return driver === 'postgres' ? createPgNotificationRepo() : createMemoryNotificationRepo();
}
