import { bootstrap, startServer, config, createLogger } from '@streaming/shared';
import { createPlaybackApp } from './app.js';
import { createPlaybackRepo } from './repo/index.js';

const log = createLogger('playback-service');
const { bus, cache, shutdown } = await bootstrap('playback-service');
const repo = createPlaybackRepo();
const app = createPlaybackApp({ repo, cache, bus });

// A client that crashes never sends "stop". Without this reaper those sessions
// would count against the concurrent-stream limit forever.
const reaper = setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 120_000).toISOString();
    const expired = await repo.expireStale(cutoff);
    if (expired.length) log.warn({ count: expired.length }, 'expired stale playback sessions');
  } catch (err) {
    log.error({ err: err.message }, 'session reaper failed');
  }
}, 60_000);
reaper.unref();

startServer(app, config.ports.playback, {
  onShutdown: async () => {
    clearInterval(reaper);
    await shutdown();
  }
});
