/**
 * In-memory cache adapter. Implements the same surface as the Redis adapter so
 * tests (and `npm run dev`) need no Redis server.
 */
export class MemoryCache {
  constructor({ prefix = '' } = {}) {
    this.prefix = prefix;
    this.store = new Map(); // key -> { value, expiresAt|null }
  }

  #k(key) {
    return this.prefix + key;
  }

  #live(entry) {
    if (!entry) return false;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) return false;
    return true;
  }

  async get(key) {
    const entry = this.store.get(this.#k(key));
    if (!this.#live(entry)) {
      this.store.delete(this.#k(key));
      return null;
    }
    return entry.value;
  }

  async set(key, value, ttlSeconds) {
    this.store.set(this.#k(key), {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null
    });
  }

  async del(...keys) {
    for (const key of keys) this.store.delete(this.#k(key));
  }

  /** Delete every key matching a `prefix*` pattern. */
  async delByPattern(pattern) {
    const needle = this.#k(pattern.replace(/\*$/, ''));
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(needle)) this.store.delete(key);
    }
  }

  async incr(key, ttlSeconds) {
    const current = Number(await this.get(key)) || 0;
    const next = current + 1;
    await this.set(key, String(next), ttlSeconds);
    return next;
  }

  async ping() {
    return 'PONG';
  }

  async flushAll() {
    this.store.clear();
  }

  async close() {
    this.store.clear();
  }
}
