import { bootstrap, startServer, config, createLogger } from '@streaming/shared';
import { createSubscriptionApp } from './app.js';
import { sweepStalledSagas } from './saga/orchestrator.js';

const log = createLogger('subscription-service');
const { bus, cache, shutdown } = await bootstrap('subscription-service');
const app = createSubscriptionApp({ cache, bus });

// Background sweeper: fail any saga that has been waiting on payment too long,
// so a lost billing reply cannot leave a subscription pending forever.
const sweeper = setInterval(async () => {
  try {
    const swept = await sweepStalledSagas({
      repo: app.locals.repo,
      orchestrator: app.locals.orchestrator,
      timeoutMs: 60_000
    });
    if (swept) log.warn({ swept }, 'timed out stalled sagas');
  } catch (err) {
    log.error({ err: err.message }, 'saga sweeper failed');
  }
}, 30_000);
sweeper.unref();

startServer(app, config.ports.subscription, {
  onShutdown: async () => {
    clearInterval(sweeper);
    await shutdown();
  }
});
