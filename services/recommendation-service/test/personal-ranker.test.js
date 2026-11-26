import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { engagementWeight, loadModel, rankForUser } from '../src/domain/personal-ranker.js';
import { TITLES } from '../../../db/seed/titles.js';

const NOW = Date.parse('2026-11-01T00:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();

const tiny = {
  neighbors: {
    a: [{ id: 'b', score: 0.9 }, { id: 'c', score: 0.5 }],
    x: [{ id: 'c', score: 0.8 }, { id: 'y', score: 0.7 }],
    b: [{ id: 'a', score: 0.9 }]
  }
};
const watched = (titleId, extra = {}) => ({
  titleId, completed: true, playCount: 1, lastWatchedAt: daysAgo(0), ...extra
});

describe('personal ranker', () => {
  test('never recommends anything already in the history', () => {
    const ids = rankForUser([watched('a'), watched('b')], tiny, { now: NOW }).map((p) => p.titleId);
    assert.ok(!ids.includes('a') && !ids.includes('b'));
    assert.deepEqual(ids, ['c']);
  });

  test('a title liked from two seeds outranks one with a single strong seed', () => {
    const picks = rankForUser([watched('a'), watched('x')], tiny, { now: NOW });
    assert.equal(picks[0].titleId, 'c'); // 0.5 + 0.8 beats b's 0.9
    assert.equal(picks[0].because, 'x'); // the larger contributor explains it
  });

  test('recent viewing counts more than old viewing', () => {
    const fresh = engagementWeight(watched('a'), { now: NOW });
    const stale = engagementWeight(watched('a', { lastWatchedAt: daysAgo(60) }), { now: NOW });
    assert.ok(Math.abs(stale - fresh / 4) < 1e-9, '60 days = two 30-day half-lives');
  });

  test('an abandoned title counts less than a finished one', () => {
    const done = engagementWeight(watched('a'), { now: NOW });
    const quit = engagementWeight(watched('a', { completed: false, progressPercent: 10 }), { now: NOW });
    assert.ok(quit < done);
  });

  test('empty history is a cold start: no picks', () => {
    assert.deepEqual(rankForUser([], tiny), []);
  });
});

describe('model artifact', () => {
  const model = loadModel();
  const ids = new Set(TITLES.map((t) => t.id));

  test('covers every catalog title', () => {
    assert.equal(model.titles, TITLES.length);
    for (const id of ids) assert.ok(model.neighbors[id]?.length, `${id} has no neighbours`);
  });

  test('neighbours are real titles, never the title itself, best first', () => {
    for (const [id, list] of Object.entries(model.neighbors)) {
      for (const n of list) {
        assert.ok(ids.has(n.id), `${n.id} is not in the catalog`);
        assert.notEqual(n.id, id);
      }
      const scores = list.map((n) => n.score);
      assert.deepEqual(scores, [...scores].sort((p, q) => q - p));
    }
  });

  test('an animated family film is closest to other animated family films', () => {
    const top = model.neighbors.tt_toy_story.slice(0, 3).map((n) => n.id);
    for (const id of top) {
      const t = TITLES.find((x) => x.id === id);
      assert.ok(t.genres.includes('animation'), `${id} is not animation`);
    }
  });
});
