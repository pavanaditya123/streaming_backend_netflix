import { config } from '@streaming/shared';
import { createMemoryHistoryRepo } from './history.repo.memory.js';
import { createPgHistoryRepo } from './history.repo.pg.js';

export function createHistoryRepo(driver = config.drivers.data) {
  return driver === 'postgres' ? createPgHistoryRepo() : createMemoryHistoryRepo();
}
