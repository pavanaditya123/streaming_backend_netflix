import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { MemoryBus, MemoryCache, setCache, getMemoryDb, createEvent, TOPICS, EVENTS, cacheKeys } from '@streaming/shared';
import { createWatchHistoryApp } from '../src/app.js';

const asUser = (id) => ({ 'x-internal-secret': 'dev-only-internal-secret', 'x-user-id': id });

function build() {
  getMemoryDb().clear();
  const cache = setCache(new MemoryCache());
  const bus = new MemoryBus({ retryDelayMs: 1 });
  return { app: createWatchHistoryApp({ cache, bus }), bus, cache };
}

const started = (userId, titleId, extra = {}) =>
  createEvent(EVENTS.PLAYBACK_STARTED,
    { userId, titleId, titleName: titleId, durationSeconds: 6000, ...extra }, { key: userId });

const stopped = (userId, titleId, positionSeconds, extra = {}) =>
  createEvent(EVENTS.PLAYBACK_STOPPED,
    { userId, titleId, titleName: titleId, positionSeconds, durationSeconds: 6000, ...extra }, { key: userId });

describe('watch history is built from playback events', () => {
  let ctx;
  beforeEach(() => { ctx = build(); });

  test('a stop event creates a resumable history entry', async () => {
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, started('u1', 'tt_a'));
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, stopped('u1', 'tt_a', 1800));
    await ctx.bus.drain();

    const res = await request(ctx.app).get('/watch-history/continue').set(asUser('u1'));
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].titleId, 'tt_a');
    assert.equal(res.body.items[0].positionSeconds, 1800);
    assert.equal(res.body.items[0].progressPercent, 30);
  });

  test('a finished title drops out of continue-watching', async () => {
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, started('u1', 'tt_a'));
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, stopped('u1', 'tt_a', 5800, { completed: true }));
    await ctx.bus.drain();

    const cont = await request(ctx.app).get('/watch-history/continue').set(asUser('u1'));
    assert.equal(cont.body.items.length, 0, 'finished titles are not "continue watching"');

    const all = await request(ctx.app).get('/watch-history').set(asUser('u1'));
    assert.equal(all.body.items.length, 1, 'but it stays in the full history');
    assert.equal(all.body.items[0].completed, true);
  });

  test('a title barely started is not offered for resume', async () => {
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, stopped('u1', 'tt_a', 10));
    await ctx.bus.drain();
    const res = await request(ctx.app).get('/watch-history/continue').set(asUser('u1'));
    assert.equal(res.body.items.length, 0, 'under 30s does not count as started');
  });

  test('re-watching updates one row instead of creating another', async () => {
    for (let i = 0; i < 3; i += 1) {
      await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, started('u1', 'tt_a'));
    }
    await ctx.bus.drain();

    const res = await request(ctx.app).get('/watch-history').set(asUser('u1'));
    assert.equal(res.body.total, 1, 'one row per (user, title)');
    assert.equal(res.body.items[0].playCount, 3);
  });

  test('a duplicate event is ignored (at-least-once delivery safety)', async () => {
    const event = started('u1', 'tt_a');
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, event);
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, event); // exact redelivery
    await ctx.bus.drain();

    const res = await request(ctx.app).get('/watch-history').set(asUser('u1'));
    assert.equal(res.body.items[0].playCount, 1, 'a redelivered event must not double-count');
  });

  test('users only ever see their own history', async () => {
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, stopped('u1', 'tt_a', 1800));
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, stopped('u2', 'tt_b', 1800));
    await ctx.bus.drain();

    const u1 = await request(ctx.app).get('/watch-history').set(asUser('u1'));
    assert.equal(u1.body.items.length, 1);
    assert.equal(u1.body.items[0].titleId, 'tt_a');
  });

  test('an event invalidates the cached continue-watching list', async () => {
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, stopped('u1', 'tt_a', 1800));
    await ctx.bus.drain();

    const first = await request(ctx.app).get('/watch-history/continue').set(asUser('u1'));
    const second = await request(ctx.app).get('/watch-history/continue').set(asUser('u1'));
    assert.equal(first.body.cached, false);
    assert.equal(second.body.cached, true);

    // New activity must bust that cache rather than serve a stale list.
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, stopped('u1', 'tt_b', 900));
    await ctx.bus.drain();
    assert.equal(await ctx.cache.get(`${cacheKeys.continueWatching('u1')}:10`), null);

    const third = await request(ctx.app).get('/watch-history/continue').set(asUser('u1'));
    assert.equal(third.body.cached, false);
    assert.equal(third.body.items.length, 2);
  });

  test('continue-watching limits do not share a cache entry', async () => {
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, stopped('u1', 'tt_a', 1800));
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, stopped('u1', 'tt_b', 900));
    await ctx.bus.drain();
    const one = await request(ctx.app).get('/watch-history/continue?limit=1').set(asUser('u1'));
    const two = await request(ctx.app).get('/watch-history/continue?limit=2').set(asUser('u1'));
    assert.equal(one.body.items.length, 1);
    assert.equal(two.body.items.length, 2);
  });

  test('history updates invalidate personalized home and recommendation caches', async () => {
    await ctx.cache.set(cacheKeys.home('u1'), { rails: [] }, 60);
    await ctx.cache.set(cacheKeys.recommendation('u1', 'for-you:12'), { rails: [] }, 60);
    await ctx.cache.set(cacheKeys.home('u2'), { rails: [] }, 60);
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, stopped('u1', 'tt_a', 1800));
    await ctx.bus.drain();
    assert.equal(await ctx.cache.get(cacheKeys.home('u1')), null);
    assert.equal(await ctx.cache.get(cacheKeys.recommendation('u1', 'for-you:12')), null);
    assert.ok(await ctx.cache.get(cacheKeys.home('u2')), 'another user cache is preserved');
  });

  test('progress events keep the resume point moving', async () => {
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, started('u1', 'tt_a'));
    for (const pos of [600, 1200, 2400]) {
      await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS,
        createEvent(EVENTS.PLAYBACK_PROGRESS,
          { userId: 'u1', titleId: 'tt_a', positionSeconds: pos, durationSeconds: 6000 }, { key: 'u1' }));
    }
    await ctx.bus.drain();

    const res = await request(ctx.app).get('/watch-history/continue').set(asUser('u1'));
    assert.equal(res.body.items[0].positionSeconds, 2400, 'the latest position wins');
  });

  test('reports viewing stats', async () => {
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, stopped('u1', 'tt_a', 5800, { completed: true }));
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, stopped('u1', 'tt_b', 1800));
    await ctx.bus.drain();

    const res = await request(ctx.app).get('/watch-history/stats').set(asUser('u1'));
    assert.equal(res.body.titlesWatched, 2);
    assert.equal(res.body.completed, 1);
    assert.equal(res.body.inProgress, 1);
    assert.equal(res.body.totalWatchedSeconds, 7600);
  });

  test('a user can delete an entry from their history', async () => {
    await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS, stopped('u1', 'tt_a', 1800));
    await ctx.bus.drain();

    const del = await request(ctx.app).delete('/watch-history/tt_a').set(asUser('u1'));
    assert.equal(del.status, 204);

    const res = await request(ctx.app).get('/watch-history').set(asUser('u1'));
    assert.equal(res.body.items.length, 0);
  });
});
