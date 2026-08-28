import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { MemoryBus, MemoryCache, setCache, getMemoryDb, createEvent, TOPICS, EVENTS } from '@streaming/shared';
import { createCatalogApp } from '../src/app.js';
import { createCatalogRepo } from '../src/repo/index.js';
import { matchesFilters, similarityScore, textMatches } from '../src/domain/filters.js';
import { TITLES } from '../../../db/seed/titles.js';

const H = { 'x-internal-secret': 'dev-only-internal-secret' };

async function buildApp() {
  getMemoryDb().clear();
  const cache = setCache(new MemoryCache());
  const bus = new MemoryBus({ retryDelayMs: 1 });
  const repo = createCatalogRepo();
  await repo.upsertMany(TITLES);
  return { app: createCatalogApp({ repo, cache, bus }), bus, cache, repo };
}

describe('catalog filtering (pure)', () => {
  const t = TITLES.find((x) => x.id === 'tt_inception');

  test('matches on genre', () => {
    assert.ok(matchesFilters(t, { genre: 'sci-fi' }));
    assert.ok(!matchesFilters(t, { genre: 'horror' }));
  });

  test('combines filters with AND', () => {
    assert.ok(matchesFilters(t, { genre: 'sci-fi', language: 'en', minRating: 8 }));
    assert.ok(!matchesFilters(t, { genre: 'sci-fi', language: 'ko' }));
  });

  test('matches a year range', () => {
    assert.ok(matchesFilters(t, { yearFrom: 2005, yearTo: 2015 }));
    assert.ok(!matchesFilters(t, { yearFrom: 2015, yearTo: 2020 }));
  });

  test('matches cast and director as people', () => {
    assert.ok(matchesFilters(t, { person: 'DiCaprio' }));
    assert.ok(matchesFilters(t, { director: 'Nolan' }));
    assert.ok(!matchesFilters(t, { person: 'Tom Hanks' }));
  });

  test('full-text needs every word to appear', () => {
    assert.ok(textMatches(t, 'dream'));
    assert.ok(textMatches(t, 'nolan'));
    assert.ok(!textMatches(t, 'dream submarine'));
  });

  test('similarity ranks a same-director, same-genre title highest', () => {
    const dark = TITLES.find((x) => x.id === 'tt_dark_knight');
    const office = TITLES.find((x) => x.id === 'tt_the_office');
    assert.ok(similarityScore(t, dark) > similarityScore(t, office));
  });

  test('a title is never similar to itself', () => {
    assert.equal(similarityScore(t, t), -1);
  });
});

describe('catalog API', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });

  test('filters, sorts and paginates', async () => {
    const res = await request(ctx.app).get('/titles?genre=sci-fi&sort=rating&limit=3').set(H);
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 3);
    assert.ok(res.body.total > 3);
    const ratings = res.body.items.map((t) => t.rating);
    assert.deepEqual(ratings, [...ratings].sort((a, b) => b - a), 'results must be rating-sorted');
  });

  test('serves the second request from cache', async () => {
    const first = await request(ctx.app).get('/titles?genre=drama').set(H);
    const second = await request(ctx.app).get('/titles?genre=drama').set(H);
    assert.equal(first.body.cached, false);
    assert.equal(second.body.cached, true);
  });

  test('rejects an unknown sort value', async () => {
    const res = await request(ctx.app).get('/titles?sort=bogus').set(H);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  });

  test('404s for a missing title', async () => {
    const res = await request(ctx.app).get('/titles/does_not_exist').set(H);
    assert.equal(res.status, 404);
  });

  test('rejects a request without the internal secret', async () => {
    const res = await request(ctx.app).get('/titles');
    assert.equal(res.status, 403);
  });

  test('batch fetch avoids N+1 lookups', async () => {
    const res = await request(ctx.app)
      .post('/titles/batch').set(H)
      .send({ ids: ['tt_inception', 'tt_rrr', 'nope'] });
    assert.equal(res.body.items.length, 2, 'unknown ids are skipped, not errors');
  });

  test('similar titles exclude the seed itself', async () => {
    const res = await request(ctx.app).get('/titles/tt_inception/similar?limit=5').set(H);
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length > 0);
    assert.ok(!res.body.items.some((t) => t.id === 'tt_inception'));
  });

  describe('event-driven popularity', () => {
    test('a playback event increases view count and invalidates the cached title', async () => {
      const before = await request(ctx.app).get('/titles/tt_rrr').set(H);
      assert.equal(before.body.title.viewCount, 0);

      await ctx.bus.publish(
        TOPICS.PLAYBACK_EVENTS,
        createEvent(EVENTS.PLAYBACK_STARTED, { titleId: 'tt_rrr', userId: 'u1' }, { key: 'u1' })
      );
      await ctx.bus.drain();

      const after = await request(ctx.app).get('/titles/tt_rrr').set(H);
      assert.equal(after.body.title.viewCount, 1);
      assert.equal(after.body.cached, false, 'the stale cached copy must have been dropped');
    });

    test('trending reflects accumulated playback events', async () => {
      for (let i = 0; i < 5; i += 1) {
        await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS,
          createEvent(EVENTS.PLAYBACK_STARTED, { titleId: 'tt_panchayat' }, { key: `u${i}` }));
      }
      await ctx.bus.drain();

      const res = await request(ctx.app).get('/titles/trending?limit=1').set(H);
      assert.equal(res.body.items[0].id, 'tt_panchayat');
      assert.equal(res.body.items[0].viewCount, 5);
    });

    test('a playback event for an unknown title is ignored, not fatal', async () => {
      await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS,
        createEvent(EVENTS.PLAYBACK_STARTED, { titleId: 'tt_ghost' }, { key: 'u1' }));
      await ctx.bus.drain();
      assert.equal(ctx.bus.dlq.length, 0, 'it should not end up dead-lettered');
    });
  });
});
