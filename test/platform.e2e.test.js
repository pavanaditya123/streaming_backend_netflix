import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryBus, MemoryCache, setCache, setBus, getMemoryDb, config
} from '@streaming/shared';
import { TITLES } from '../db/seed/titles.js';

/**
 * Whole-platform end-to-end test.
 *
 * All nine services are started on real ports and talk to each other over real
 * HTTP — the same topology as production. Only the three infrastructure
 * dependencies are swapped for their in-memory adapters, which is what lets this
 * run in CI in a couple of seconds with no Docker, no Postgres and no Kafka.
 */

const PORTS = {
  user: 4101, catalog: 4102, playback: 4103, watchHistory: 4104,
  subscription: 4105, billing: 4106, notification: 4107,
  recommendation: 4108, gateway: 4100
};

// Point service discovery at the test ports before any service module reads it.
for (const [name, port] of Object.entries(PORTS)) {
  config.ports[name] = port;
  config.services[name] = `http://127.0.0.1:${port}`;
}

const API = `http://127.0.0.1:${PORTS.gateway}/api/v1`;

const servers = [];
let bus;
let cache;

async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Wait for every async consumer to finish before asserting. */
const settle = async () => {
  await bus.drain();
  await new Promise((r) => setTimeout(r, 20));
  await bus.drain();
};

const newEmail = () => `e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}@test.com`;

async function registerUser() {
  const res = await api('/auth/register', {
    method: 'POST',
    body: { email: newEmail(), password: 'secret123', displayName: 'E2E User' }
  });
  return { token: res.body.token, userId: res.body.user.id };
}

async function subscribe(token, planId = 'premium', cardNumber = '4111111111111111') {
  const res = await api('/subscriptions', {
    method: 'POST', token, body: { planId, paymentMethod: { cardNumber } }
  });
  await settle();
  return res;
}

before(async () => {
  getMemoryDb().clear();
  cache = setCache(new MemoryCache());
  bus = setBus(new MemoryBus({ retryDelayMs: 1 }));
  await bus.connect();

  const { createUserApp } = await import('../services/user-service/src/app.js');
  const { createCatalogApp } = await import('../services/catalog-service/src/app.js');
  const { createPlaybackApp } = await import('../services/playback-service/src/app.js');
  const { createWatchHistoryApp } = await import('../services/watch-history-service/src/app.js');
  const { createSubscriptionApp } = await import('../services/subscription-service/src/app.js');
  const { createBillingApp } = await import('../services/billing-service/src/app.js');
  const { createNotificationApp } = await import('../services/notification-service/src/app.js');
  const { createRecommendationApp } = await import('../services/recommendation-service/src/app.js');
  const { createGatewayApp } = await import('../services/api-gateway/src/app.js');
  const { createCatalogRepo } = await import('../services/catalog-service/src/repo/index.js');

  const catalogRepo = createCatalogRepo();
  await catalogRepo.upsertMany(TITLES);

  const apps = [
    [createUserApp({ bus }), PORTS.user],
    [createCatalogApp({ repo: catalogRepo, cache, bus }), PORTS.catalog],
    [createPlaybackApp({ cache, bus }), PORTS.playback],
    [createWatchHistoryApp({ cache, bus }), PORTS.watchHistory],
    [createSubscriptionApp({ cache, bus }), PORTS.subscription],
    [createBillingApp({ bus }), PORTS.billing],
    [createNotificationApp({ bus }), PORTS.notification],
    [createRecommendationApp({ cache }), PORTS.recommendation],
    [createGatewayApp({ cache }), PORTS.gateway]
  ];

  for (const [app, port] of apps) {
    await new Promise((resolve, reject) => {
      servers.push(app.listen(port, '127.0.0.1', resolve).on('error', reject));
    });
  }
});

after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  await bus.close();
});

describe('platform end-to-end', () => {
  describe('health', () => {
    test('every service reports ready through the gateway', async () => {
      const res = await fetch(`http://127.0.0.1:${PORTS.gateway}/ops/services`);
      const body = await res.json();
      assert.equal(body.status, 'ok', JSON.stringify(body.services));
      assert.equal(Object.keys(body.services).length, 8);
    });
  });

  describe('authentication', () => {
    test('an unauthenticated request is rejected', async () => {
      const res = await api('/home');
      assert.equal(res.status, 401);
    });

    test('a garbage token is rejected', async () => {
      const res = await api('/home', { token: 'not.a.real.token' });
      assert.equal(res.status, 401);
    });

    test('the plan catalogue is public', async () => {
      const res = await api('/plans');
      assert.equal(res.status, 200);
      assert.equal(res.body.plans.length, 3);
    });
  });

  describe('the full subscribe-and-watch journey', () => {
    let token;
    before(async () => { ({ token } = await registerUser()); });

    test('1. playback is blocked before subscribing', async () => {
      const res = await api('/playback/sessions', {
        method: 'POST', token, body: { titleId: 'tt_interstellar' }
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.details.reason, 'no_active_subscription');
    });

    test('2. subscribing runs the saga to completion', async () => {
      const res = await subscribe(token);
      assert.equal(res.status, 202);

      const detail = await api(`/subscriptions/${res.body.subscriptionId}`, { token });
      assert.equal(detail.body.subscription.status, 'active');
      assert.equal(detail.body.saga.state, 'COMPLETED');
    });

    test('3. playback now succeeds at the plan quality', async () => {
      const res = await api('/playback/sessions', {
        method: 'POST', token, body: { titleId: 'tt_interstellar' }
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.session.quality, '4K');
    });

    test('4. watching builds history through the event pipeline', async () => {
      const play = await api('/playback/sessions', {
        method: 'POST', token, body: { titleId: 'tt_rrr' }
      });
      await api(`/playback/sessions/${play.body.session.id}/stop`, {
        method: 'POST', token, body: { positionSeconds: 3600 }
      });
      await settle();

      const history = await api('/watch-history/continue', { token });
      const entry = history.body.items.find((i) => i.titleId === 'tt_rrr');
      assert.ok(entry, 'watch-history was populated with no direct write to it');
      assert.equal(entry.positionSeconds, 3600);
    });

    test('5. the same events made the title trend', async () => {
      const res = await api('/titles/trending?limit=5', { token });
      assert.ok(res.body.items.some((t) => t.viewCount > 0), 'catalog reacted to playback events');
    });

    test('6. notifications were generated from events', async () => {
      const res = await api('/notifications', { token });
      const sources = res.body.items.map((n) => n.sourceEventType);
      assert.ok(sources.includes('user.registered'));
      assert.ok(sources.includes('subscription.activated'));
    });

    test('7. the home screen composes every service', async () => {
      const res = await api('/home', { token });
      assert.equal(res.status, 200);
      assert.equal(res.body.subscription.planId, 'premium');
      assert.ok(res.body.rails.length > 0);
      // Every rail must carry catalog titles in the same shape.
      for (const rail of res.body.rails) {
        for (const item of rail.items) {
          assert.ok(item.id && item.title, `rail "${rail.title}" has a malformed item`);
        }
      }
    });

    test('8. the home screen is cached on the second load', async () => {
      const first = await api('/home', { token });
      const second = await api('/home', { token });
      assert.equal(second.body.cached, true);
      assert.deepEqual(
        second.body.rails.map((r) => r.title),
        first.body.rails.map((r) => r.title)
      );
    });

    test('9. natural-language search resolves real intents', async () => {
      const cases = [
        ['korean thriller series', 'by_genre_and_language'],
        ['movies with Tom Hanks', 'by_actor'],
        ['what was I watching', 'continue_watching'],
        ['surprise me', 'random_pick']
      ];
      for (const [query, intent] of cases) {
        const res = await api('/recommendations/search', { method: 'POST', token, body: { query, limit: 5 } });
        assert.equal(res.status, 200);
        assert.equal(res.body.intent, intent, `"${query}"`);
        assert.ok(res.body.tookMs < 2000, `"${query}" took ${res.body.tookMs}ms`);
      }
    });

    test('10. cancelling revokes access immediately', async () => {
      const subs = await api('/subscriptions', { token });
      const active = subs.body.items.find((s) => s.status === 'active');
      const cancelled = await api(`/subscriptions/${active.id}/cancel`, { method: 'POST', token });
      assert.equal(cancelled.status, 200);

      const play = await api('/playback/sessions', {
        method: 'POST', token, body: { titleId: 'tt_interstellar' }
      });
      assert.equal(play.status, 403, 'a cancelled user must not keep streaming from a stale cache');
    });
  });

  describe('failure handling across services', () => {
    test('a declined card leaves the user unsubscribed and un-entitled', async () => {
      const { token } = await registerUser();
      const res = await subscribe(token, 'premium', '4000000000000000');

      const detail = await api(`/subscriptions/${res.body.subscriptionId}`, { token });
      assert.equal(detail.body.subscription.status, 'failed');
      assert.equal(detail.body.saga.state, 'FAILED');

      const play = await api('/playback/sessions', {
        method: 'POST', token, body: { titleId: 'tt_interstellar' }
      });
      assert.equal(play.status, 403);
    });

    test('a lower plan cannot stream a premium-only title', async () => {
      const { token } = await registerUser();
      await subscribe(token, 'basic');

      const res = await api('/playback/sessions', {
        method: 'POST', token, body: { titleId: 'tt_breaking_bad' }
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.details.reason, 'title_not_in_plan');
      assert.equal(res.body.error.details.upgradeTo, 'premium');
    });

    test('the concurrent-stream limit is enforced end to end', async () => {
      const { token } = await registerUser();
      await subscribe(token, 'basic');

      const first = await api('/playback/sessions', { method: 'POST', token, body: { titleId: 'tt_3_idiots' } });
      const second = await api('/playback/sessions', { method: 'POST', token, body: { titleId: 'tt_dangal' } });

      assert.equal(first.status, 201);
      assert.equal(second.status, 403);
      assert.equal(second.body.error.details.reason, 'max_concurrent_streams_reached');
    });

    test('a user cannot read another user data', async () => {
      const a = await registerUser();
      const b = await registerUser();
      await subscribe(a.token);

      const subs = await api('/subscriptions', { token: a.token });
      const stolen = await api(`/subscriptions/${subs.body.items[0].id}`, { token: b.token });
      assert.equal(stolen.status, 403);
    });
  });

  describe('cold start', () => {
    test('recommendations still work for a user with no history', async () => {
      const { token } = await registerUser();
      const res = await api('/recommendations/for-you', { token });
      assert.equal(res.status, 200);
      assert.equal(res.body.coldStart, true);
      assert.ok(res.body.rails.some((r) => r.items.length > 0), 'must fall back to trending');
    });

    test('the home screen renders for a brand-new user', async () => {
      const { token } = await registerUser();
      const res = await api('/home', { token });
      assert.equal(res.status, 200);
      assert.equal(res.body.subscription.entitled, false);
      assert.ok(res.body.rails.length > 0);
    });
  });
});
