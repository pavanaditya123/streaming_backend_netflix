import { config } from '../config.js';
import { MemoryCache } from './memory-cache.js';
import { RedisCache } from './redis-cache.js';
import { metrics } from '../metrics.js';

export { MemoryCache, RedisCache };

let singleton = null;

export function createCache({ driver = config.drivers.cache } = {}) {
  if (driver === 'redis') {
    return new RedisCache({ url: config.redis.url, prefix: config.redis.keyPrefix });
  }
  return new MemoryCache({ prefix: config.redis.keyPrefix });
}

export function getCache() {
  if (!singleton) singleton = createCache();
  return singleton;
}

/** Test/bootstrap hook so a process can share one cache instance. */
export function setCache(instance) {
  singleton = instance;
  return singleton;
}

// In-flight promises keyed by cache key -> collapses a thundering herd of
// identical misses into a single origin call ("cache stampede" protection).
const inFlight = new Map();

/**
 * Cache-aside read-through helper.
 *
 * This is the single place the read-heavy endpoints get their speed-up from:
 * on a hit we return immediately; on a miss exactly one caller computes the
 * value and every concurrent caller for the same key awaits that same promise.
 */
export async function withCache(key, ttlSeconds, producer, { cache = getCache(), enabled = config.cacheEnabled } = {}) {
  if (!enabled) {
    const value = await producer();
    return { value, cached: false };
  }

  const hit = await cache.get(key);
  if (hit !== null && hit !== undefined) {
    metrics.cacheHits.inc({ key: keyFamily(key) });
    return { value: hit, cached: true };
  }

  metrics.cacheMisses.inc({ key: keyFamily(key) });

  if (inFlight.has(key)) {
    return { value: await inFlight.get(key), cached: false, coalesced: true };
  }

  const promise = (async () => {
    const value = await producer();
    if (value !== undefined && value !== null) {
      await cache.set(key, value, ttlSeconds);
    }
    return value;
  })();

  inFlight.set(key, promise);
  try {
    const value = await promise;
    return { value, cached: false };
  } finally {
    inFlight.delete(key);
  }
}

/** `catalog:title:abc` -> `catalog:title` so metrics stay low-cardinality. */
export function keyFamily(key) {
  const parts = String(key).split(':');
  return parts.length <= 2 ? key : parts.slice(0, 2).join(':');
}

/** Namespaced cache-key builders — keeps key formats in one auditable place. */
export const cacheKeys = {
  title: (id) => `catalog:title:${id}`,
  titleList: (hash) => `catalog:list:${hash}`,
  trending: () => `catalog:trending:v1`,
  entitlement: (userId) => `entitlement:user:${userId}`,
  continueWatching: (userId) => `wh:continue:${userId}`,
  watchHistory: (userId, page) => `wh:list:${userId}:${page}`,
  recommendation: (userId, hash) => `reco:${userId}:${hash}`,
  home: (userId) => `home:${userId}`,
  idempotency: (scope, key) => `idem:${scope}:${key}`
};
