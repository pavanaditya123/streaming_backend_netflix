import Redis from 'ioredis';

/** Redis-backed cache adapter (production driver). */
export class RedisCache {
  constructor({ url, prefix = '' } = {}) {
    this.prefix = prefix;
    this.client = new Redis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
      enableReadyCheck: true
    });
    this.client.on('error', () => {
      /* surfaced by health checks; avoids crashing the process on blips */
    });
  }

  #k(key) {
    return this.prefix + key;
  }

  async get(key) {
    const raw = await this.client.get(this.#k(key));
    return raw === null ? null : JSON.parse(raw);
  }

  async set(key, value, ttlSeconds) {
    const raw = JSON.stringify(value);
    if (ttlSeconds) await this.client.set(this.#k(key), raw, 'EX', ttlSeconds);
    else await this.client.set(this.#k(key), raw);
  }

  async del(...keys) {
    if (!keys.length) return;
    await this.client.del(...keys.map((k) => this.#k(k)));
  }

  /**
   * SCAN (never KEYS) so a large keyspace does not block the Redis event loop.
   */
  async delByPattern(pattern) {
    const match = this.#k(pattern.endsWith('*') ? pattern : `${pattern}*`);
    let cursor = '0';
    do {
      const [next, found] = await this.client.scan(cursor, 'MATCH', match, 'COUNT', 200);
      cursor = next;
      if (found.length) await this.client.del(...found);
    } while (cursor !== '0');
  }

  async incr(key, ttlSeconds) {
    const k = this.#k(key);
    const value = await this.client.incr(k);
    if (value === 1 && ttlSeconds) await this.client.expire(k, ttlSeconds);
    return value;
  }

  async ping() {
    return this.client.ping();
  }

  async flushAll() {
    await this.delByPattern('*');
  }

  async close() {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
