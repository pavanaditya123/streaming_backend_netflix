import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDatabase, truncateAll } from './helpers.js';
import { createPgUserRepo } from '../../services/user-service/src/repo/user.repo.pg.js';
import { createPgCatalogRepo } from '../../services/catalog-service/src/repo/catalog.repo.pg.js';
import { createPgSubscriptionRepo } from '../../services/subscription-service/src/repo/subscription.repo.pg.js';
import { createPgBillingRepo } from '../../services/billing-service/src/repo/billing.repo.pg.js';
import { createPgHistoryRepo } from '../../services/watch-history-service/src/repo/history.repo.pg.js';
import { createPgPlaybackRepo } from '../../services/playback-service/src/repo/playback.repo.pg.js';
import { createPgNotificationRepo } from '../../services/notification-service/src/repo/notification.repo.pg.js';
import { TITLES } from '../../db/seed/titles.js';

/**
 * Every SQL query in the project, executed against a real Postgres engine.
 *
 * The in-memory driver can never catch a typo in a query or a missing column —
 * this suite is what does.
 */
let db;

before(async () => {
  db = await setupDatabase();
  console.log(`  (running against: ${db.kind})`);
});

after(async () => { await db.close(); });
beforeEach(async () => { await truncateAll(db); });

const now = () => new Date().toISOString();

describe('users repository', () => {
  const repo = createPgUserRepo();

  test('creates and reads a user', async () => {
    await repo.create({
      id: 'usr_1', email: 'a@b.com', password_hash: 'hash',
      display_name: 'Pavan', country: 'IN', created_at: now()
    });

    const byEmail = await repo.findByEmail('a@b.com');
    assert.equal(byEmail.id, 'usr_1');

    const byId = await repo.findById('usr_1');
    assert.equal(byId.display_name, 'Pavan');
    assert.equal(byId.password_hash, undefined, 'findById must not return the hash');
  });

  test('the unique email index rejects a duplicate', async () => {
    const user = {
      id: 'usr_1', email: 'a@b.com', password_hash: 'h',
      display_name: 'A', country: 'IN', created_at: now()
    };
    await repo.create(user);
    await assert.rejects(
      () => repo.create({ ...user, id: 'usr_2' }),
      (err) => err.code === '23505'
    );
  });

  test('updates a profile', async () => {
    await repo.create({
      id: 'usr_1', email: 'a@b.com', password_hash: 'h',
      display_name: 'A', country: 'IN', created_at: now()
    });
    const updated = await repo.updateProfile('usr_1', { display_name: 'B', country: null });
    assert.equal(updated.display_name, 'B');
    assert.equal(updated.country, 'IN', 'a null patch value must not overwrite');
  });
});

describe('catalog repository', () => {
  const repo = createPgCatalogRepo();
  beforeEach(async () => { await repo.upsertMany(TITLES); });

  test('finds a title by id with the API-shaped columns', async () => {
    const t = await repo.findById('tt_inception');
    assert.equal(t.title, 'Inception');
    assert.equal(t.durationMinutes, 148, 'snake_case is mapped to camelCase');
    assert.ok(Array.isArray(t.genres));
    assert.ok(t.cast.includes('Leonardo DiCaprio'));
  });

  test('filters by genre using the array containment operator', async () => {
    const { items, total } = await repo.search({ genre: 'sci-fi' }, { limit: 50 });
    assert.ok(total > 0);
    assert.ok(items.every((t) => t.genres.includes('sci-fi')));
  });

  test('combines several filters', async () => {
    const { items } = await repo.search({ language: 'hi', type: 'movie', minRating: 8 }, { limit: 50 });
    assert.ok(items.length > 0);
    assert.ok(items.every((t) => t.language === 'hi' && t.type === 'movie' && Number(t.rating) >= 8));
  });

  test('filters by a year range', async () => {
    const { items } = await repo.search({ yearFrom: 1990, yearTo: 1999 }, { limit: 50 });
    assert.ok(items.length > 0);
    assert.ok(items.every((t) => t.year >= 1990 && t.year <= 1999));
  });

  test('full-text search covers cast and director, not just the title', async () => {
    const byCast = await repo.search({ q: 'DiCaprio' }, { limit: 10 });
    assert.ok(byCast.items.some((t) => t.id === 'tt_inception'));

    const byDirector = await repo.search({ q: 'Nolan' }, { limit: 10 });
    assert.ok(byDirector.items.length >= 3);
  });

  test('finds titles by a person in either cast or director', async () => {
    const { items } = await repo.search({ person: 'Tom Hanks' }, { limit: 10 });
    assert.ok(items.some((t) => t.id === 'tt_forrest_gump'));
  });

  test('sorts by rating', async () => {
    const { items } = await repo.search({}, { sort: 'rating', limit: 5 });
    const ratings = items.map((t) => Number(t.rating));
    assert.deepEqual(ratings, [...ratings].sort((a, b) => b - a));
  });

  test('paginates with a stable total', async () => {
    const page1 = await repo.search({ type: 'movie' }, { limit: 5, offset: 0 });
    const page2 = await repo.search({ type: 'movie' }, { limit: 5, offset: 5 });
    assert.equal(page1.total, page2.total, 'the window-function total must not change between pages');
    assert.notDeepEqual(page1.items.map((t) => t.id), page2.items.map((t) => t.id));
  });

  test('increments view count and drives trending', async () => {
    for (let i = 0; i < 7; i += 1) await repo.incrementViews('tt_rrr');
    const trending = await repo.trending(1);
    assert.equal(trending[0].id, 'tt_rrr');
    assert.equal(Number(trending[0].viewCount), 7);
  });

  test('computes similarity in SQL and excludes the seed', async () => {
    const similar = await repo.similar('tt_inception', 5);
    assert.equal(similar.length, 5);
    assert.ok(!similar.some((t) => t.id === 'tt_inception'));
    assert.ok(Number(similar[0].similarityScore) > 0);
  });

  test('reports facets', async () => {
    const facets = await repo.facets();
    assert.ok(facets.genres.length > 10);
    assert.ok(facets.languages.includes('hi'));
    assert.equal(facets.count, TITLES.length);
  });

  test('upsert is idempotent', async () => {
    const before = await repo.count();
    await repo.upsertMany(TITLES);
    assert.equal(await repo.count(), before, 're-seeding must not duplicate rows');
  });
});

describe('subscription + saga repository', () => {
  const repo = createPgSubscriptionRepo();

  const makeSub = (over = {}) => ({
    id: 'sub_1', user_id: 'u1', plan_id: 'premium', status: 'pending',
    price_minor: 64900, currency: 'INR',
    current_period_start: now(), current_period_end: now(), created_at: now(), ...over
  });

  test('creates and updates a subscription', async () => {
    await repo.createSubscription(makeSub());
    const updated = await repo.updateSubscription('sub_1', { status: 'active', payment_id: 'pay_1' });
    assert.equal(updated.status, 'active');
    assert.equal(updated.payment_id, 'pay_1');
  });

  test('the partial unique index allows only ONE active subscription per user', async () => {
    await repo.createSubscription(makeSub({ id: 'sub_1', status: 'active' }));
    await assert.rejects(
      () => repo.createSubscription(makeSub({ id: 'sub_2', status: 'active' })),
      (err) => err.code === '23505',
      'the database itself must prevent a double subscription'
    );
  });

  test('but allows many non-active rows for the same user', async () => {
    await repo.createSubscription(makeSub({ id: 'sub_1', status: 'failed' }));
    await repo.createSubscription(makeSub({ id: 'sub_2', status: 'cancelled' }));
    await repo.createSubscription(makeSub({ id: 'sub_3', status: 'active' }));
    const all = await repo.listByUser('u1');
    assert.equal(all.length, 3);
  });

  test('finds the active subscription for a user', async () => {
    await repo.createSubscription(makeSub({ id: 'sub_1', status: 'failed' }));
    await repo.createSubscription(makeSub({ id: 'sub_2', status: 'active' }));
    const active = await repo.findActiveByUser('u1');
    assert.equal(active.id, 'sub_2');
  });

  test('persists saga state and appends history as JSONB', async () => {
    await repo.createSubscription(makeSub());
    await repo.createSaga({
      id: 'saga_1', saga_type: 'SUBSCRIBE', subscription_id: 'sub_1', user_id: 'u1',
      state: 'AWAITING_PAYMENT', payload: { planId: 'premium' }, history: [{ to: 'AWAITING_PAYMENT' }],
      created_at: now()
    });

    await repo.updateSaga('saga_1', { state: 'ACTIVATING' });
    await repo.appendSagaHistory('saga_1', { to: 'ACTIVATING', at: now() });
    await repo.appendSagaHistory('saga_1', { to: 'COMPLETED', at: now() });

    const saga = await repo.findSaga('saga_1');
    assert.equal(saga.state, 'ACTIVATING');
    assert.equal(saga.history.length, 3, 'history is append-only');
    assert.equal(saga.history[2].to, 'COMPLETED');
    assert.equal(saga.payload.planId, 'premium');
  });

  test('event dedupe returns true once and false thereafter', async () => {
    assert.equal(await repo.markEventProcessed('evt_1', 'consumer-a'), true);
    assert.equal(await repo.markEventProcessed('evt_1', 'consumer-a'), false);
    assert.equal(
      await repo.markEventProcessed('evt_1', 'consumer-b'), true,
      'a different consumer must still get to process it'
    );
  });

  test('stores and replays an idempotent result', async () => {
    await repo.saveIdempotentResult('k1', { sagaId: 'saga_1' });
    const replayed = await repo.findIdempotentResult('k1');
    assert.equal(replayed.sagaId, 'saga_1');
    assert.equal(await repo.findIdempotentResult('unknown'), null);
  });
});

describe('billing repository', () => {
  const repo = createPgBillingRepo();

  const payment = (over = {}) => ({
    id: 'pay_1', user_id: 'u1', subscription_id: 'sub_1', saga_id: 'saga_1',
    idempotency_key: 'charge:saga_1', amount_minor: 64900, currency: 'INR',
    status: 'succeeded', created_at: now(), ...over
  });

  test('records a payment and finds it by idempotency key', async () => {
    await repo.createPayment(payment());
    const found = await repo.findByIdempotencyKey('charge:saga_1');
    assert.equal(found.id, 'pay_1');
  });

  test('the unique idempotency key makes double-charging impossible', async () => {
    await repo.createPayment(payment());
    await assert.rejects(
      () => repo.createPayment(payment({ id: 'pay_2' })),
      (err) => err.code === '23505'
    );
  });

  test('the amount check constraint rejects a non-positive charge', async () => {
    await assert.rejects(() => repo.createPayment(payment({ amount_minor: 0 })));
  });

  test('records a refund against a payment', async () => {
    await repo.createPayment(payment());
    const refunded = await repo.updatePayment('pay_1', { status: 'refunded', refund_id: 'ref_1' });
    assert.equal(refunded.status, 'refunded');
    assert.equal(refunded.refund_id, 'ref_1');
  });
});

describe('watch history repository', () => {
  const repo = createPgHistoryRepo();

  test('upsert keeps ONE row per (user, title)', async () => {
    await repo.upsertProgress({
      userId: 'u1', titleId: 't1', titleName: 'T1',
      positionSeconds: 100, durationSeconds: 6000, completed: false, watchedAt: now()
    });
    await repo.upsertProgress({
      userId: 'u1', titleId: 't1', titleName: 'T1',
      positionSeconds: 2000, durationSeconds: 6000, completed: false, watchedAt: now()
    });

    const { items, total } = await repo.listByUser('u1');
    assert.equal(total, 1);
    assert.equal(items[0].position_seconds, 2000);
  });

  test('completion is sticky once reached', async () => {
    await repo.upsertProgress({
      userId: 'u1', titleId: 't1', positionSeconds: 5800,
      durationSeconds: 6000, completed: true, watchedAt: now()
    });
    // A later partial re-watch must not un-complete it.
    await repo.upsertProgress({
      userId: 'u1', titleId: 't1', positionSeconds: 100,
      durationSeconds: 6000, completed: false, watchedAt: now()
    });

    const entry = await repo.findEntry('u1', 't1');
    assert.equal(entry.completed, true);
  });

  test('play count increments across sessions', async () => {
    for (let i = 0; i < 3; i += 1) {
      await repo.incrementPlayCount({ userId: 'u1', titleId: 't1', durationSeconds: 6000, watchedAt: now() });
    }
    const entry = await repo.findEntry('u1', 't1');
    assert.equal(entry.play_count, 3);
  });

  test('continue-watching excludes finished and barely-started titles', async () => {
    await repo.upsertProgress({ userId: 'u1', titleId: 'done', positionSeconds: 5800, durationSeconds: 6000, completed: true, watchedAt: now() });
    await repo.upsertProgress({ userId: 'u1', titleId: 'barely', positionSeconds: 10, durationSeconds: 6000, completed: false, watchedAt: now() });
    await repo.upsertProgress({ userId: 'u1', titleId: 'resume', positionSeconds: 1800, durationSeconds: 6000, completed: false, watchedAt: now() });

    const items = await repo.continueWatching('u1');
    assert.deepEqual(items.map((i) => i.title_id), ['resume']);
  });

  test('aggregates viewing stats', async () => {
    await repo.upsertProgress({ userId: 'u1', titleId: 'a', positionSeconds: 5800, durationSeconds: 6000, completed: true, watchedAt: now() });
    await repo.upsertProgress({ userId: 'u1', titleId: 'b', positionSeconds: 1800, durationSeconds: 6000, completed: false, watchedAt: now() });

    const stats = await repo.stats('u1');
    assert.equal(stats.titlesWatched, 2);
    assert.equal(stats.completed, 1);
    assert.equal(stats.inProgress, 1);
    assert.equal(stats.totalWatchedSeconds, 7600);
  });
});

describe('playback repository', () => {
  const repo = createPgPlaybackRepo();

  const session = (over = {}) => ({
    id: 'ses_1', user_id: 'u1', title_id: 't1', device_id: 'web', quality: '4K',
    status: 'playing', position_seconds: 0,
    started_at: now(), last_heartbeat_at: now(), created_at: now(), ...over
  });

  test('counts only playing sessions as active', async () => {
    await repo.createSession(session({ id: 'ses_1', status: 'playing' }));
    await repo.createSession(session({ id: 'ses_2', status: 'stopped' }));
    const active = await repo.activeSessionsForUser('u1');
    assert.equal(active.length, 1);
  });

  test('the status check constraint rejects an invalid status', async () => {
    await assert.rejects(() => repo.createSession(session({ status: 'bogus' })));
  });

  test('expires sessions whose heartbeat has gone stale', async () => {
    const old = new Date(Date.now() - 600_000).toISOString();
    await repo.createSession(session({ id: 'ses_old', last_heartbeat_at: old }));
    await repo.createSession(session({ id: 'ses_new' }));

    const expired = await repo.expireStale(new Date(Date.now() - 120_000).toISOString());
    assert.equal(expired.length, 1);
    assert.equal(expired[0].id, 'ses_old');
    assert.equal((await repo.activeSessionsForUser('u1')).length, 1, 'the live session is untouched');
  });
});

describe('notification repository', () => {
  const repo = createPgNotificationRepo();

  const note = (over = {}) => ({
    id: 'ntf_1', user_id: 'u1', channel: 'email', category: 'billing',
    subject: 'Hi', body: 'Body', source_event_id: 'evt_1',
    source_event_type: 'user.registered', created_at: now(), ...over
  });

  test('creates and lists notifications newest first', async () => {
    await repo.create(note({ id: 'ntf_1', created_at: new Date(Date.now() - 5000).toISOString() }));
    await repo.create(note({ id: 'ntf_2' }));
    const { items, total } = await repo.listByUser('u1');
    assert.equal(total, 2);
    assert.equal(items[0].id, 'ntf_2');
  });

  test('tracks unread count and marking as read', async () => {
    await repo.create(note({ id: 'ntf_1' }));
    await repo.create(note({ id: 'ntf_2' }));
    assert.equal(await repo.unreadCount('u1'), 2);

    await repo.markRead('ntf_1', 'u1');
    assert.equal(await repo.unreadCount('u1'), 1);

    await repo.markAllRead('u1');
    assert.equal(await repo.unreadCount('u1'), 0);
  });

  test('will not mark another user notification as read', async () => {
    await repo.create(note({ id: 'ntf_1', user_id: 'u1' }));
    assert.equal(await repo.markRead('ntf_1', 'attacker'), null);
    assert.equal(await repo.unreadCount('u1'), 1);
  });

  test('filters to unread only', async () => {
    await repo.create(note({ id: 'ntf_1' }));
    await repo.create(note({ id: 'ntf_2' }));
    await repo.markRead('ntf_1', 'u1');
    const { items } = await repo.listByUser('u1', { unreadOnly: true });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'ntf_2');
  });

  test('the channel check constraint rejects an unknown channel', async () => {
    await assert.rejects(() => repo.create(note({ channel: 'telepathy' })));
  });
});
