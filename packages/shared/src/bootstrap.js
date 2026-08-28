import { config } from './config.js';
import { createBus, setBus } from './bus/index.js';
import { createCache, setCache } from './cache/index.js';
import { createLogger } from './logger.js';
import { closePool } from './db/postgres.js';

/**
 * Standard startup for a standalone service process.
 *
 * Builds the cache + bus from the configured drivers, registers them as the
 * process singletons, and returns a `shutdown` that closes everything cleanly.
 */
export async function bootstrap(serviceName) {
  const logger = createLogger(serviceName);
  const cache = setCache(createCache());
  const bus = setBus(createBus());

  await bus.connect?.();

  logger.info({ drivers: config.drivers }, 'dependencies initialised');

  const shutdown = async () => {
    await bus.close?.().catch(() => {});
    await cache.close?.().catch(() => {});
    if (config.drivers.data === 'postgres') await closePool();
  };

  process.on('unhandledRejection', (err) => {
    logger.error({ err: err?.message, stack: err?.stack }, 'unhandled rejection');
  });

  return { cache, bus, logger, shutdown };
}
