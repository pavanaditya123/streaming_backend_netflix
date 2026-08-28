import { config } from '@streaming/shared';
import { createMemoryUserRepo } from './user.repo.memory.js';
import { createPgUserRepo } from './user.repo.pg.js';

export function createUserRepo(driver = config.drivers.data) {
  return driver === 'postgres' ? createPgUserRepo() : createMemoryUserRepo();
}
