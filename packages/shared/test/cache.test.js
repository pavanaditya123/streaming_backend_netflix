import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCache } from '../src/cache/memory-cache.js';
import { withCache, cacheKeys, keyFamily } from '../src/cache/index.js';

describe('MemoryCache', () => {
  let cache;
  beforeEach(() => {
    cache = new MemoryCache();
  });

  test('stores and reads a value', async () => {
    await cache.set('a', { x: 1 });
    assert.deepEqual(await cache.get('a'), { x: 1 });
  });

  test('returns null for a missing key', async () => {
    assert.equal(await cache.get('nope'), null);
  });

  test('expires a value once its TTL has passed', async () => {
    await cache.set('short', 'v', 0.01); // 10ms
    assert.equal(await cache.get('short'), 'v');
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(await cache.get('short'), null);
  });

  test('deletes by prefix pattern', async () => {
    await cache.set('wh:list:u1:1', 'a');
    await cache.set('wh:list:u1:2', 'b');
    await cache.set('wh:list:u2:1', 'c');
    await cache.delByPattern('wh:list:u1:');
    assert.equal(await cache.get('wh:list:u1:1'), null);
    assert.equal(await cache.get('wh:list:u1:2'), null);
    assert.equal(await cache.get('wh:list:u2:1'), 'c');
  });

  test('incr counts and returns the new value', async () => {
    assert.equal(await cache.incr('hits'), 1);
    assert.equal(await cache.incr('hits'), 2);
  });
});

describe('withCache (cache-aside)', () => {
  let cache;
  beforeEach(() => {
    cache = new MemoryCache();
  });

  test('calls the origin on a miss and serves the cache on a hit', async () => {
    let calls = 0;
    const producer = async () => {
      calls += 1;
      return { value: calls };
    };

    const first = await withCache('k', 60, producer, { cache });
    const second = await withCache('k', 60, producer, { cache });

    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(calls, 1, 'origin should only be hit once');
    assert.deepEqual(second.value, first.value);
  });

  test('collapses concurrent misses into ONE origin call (stampede protection)', async () => {
    let calls = 0;
    const slowProducer = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return 'expensive';
    };

    // 20 callers ask for the same cold key at the same instant.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => withCache('hot', 60, slowProducer, { cache }))
    );

    assert.equal(calls, 1, 'a thundering herd must not hit the origin 20 times');
    assert.ok(results.every((r) => r.value === 'expensive'));
  });

  test('bypasses the cache entirely when disabled', async () => {
    let calls = 0;
    const producer = async () => { calls += 1; return 'v'; };
    await withCache('k', 60, producer, { cache, enabled: false });
    await withCache('k', 60, producer, { cache, enabled: false });
    assert.equal(calls, 2);
    assert.equal(await cache.get('k'), null, 'a bypassed read must not populate the cache');
  });

  test('does not cache a null result', async () => {
    const { value } = await withCache('missing', 60, async () => null, { cache });
    assert.equal(value, null);
    assert.equal(await cache.get('missing'), null);
  });
});

describe('cache keys', () => {
  test('are namespaced per domain', () => {
    assert.equal(cacheKeys.entitlement('u1'), 'entitlement:user:u1');
    assert.equal(cacheKeys.title('t1'), 'catalog:title:t1');
    assert.equal(cacheKeys.continueWatching('u1'), 'wh:continue:u1');
  });

  test('collapse to a low-cardinality family for metrics', () => {
    assert.equal(keyFamily('catalog:title:tt_inception'), 'catalog:title');
    assert.equal(keyFamily('entitlement:user:usr_123'), 'entitlement:user');
  });
});
