import { config } from '@streaming/shared';
import { createMemoryPlaybackRepo } from './playback.repo.memory.js';
import { createPgPlaybackRepo } from './playback.repo.pg.js';

export function createPlaybackRepo(driver = config.drivers.data) {
  return driver === 'postgres' ? createPgPlaybackRepo() : createMemoryPlaybackRepo();
}
