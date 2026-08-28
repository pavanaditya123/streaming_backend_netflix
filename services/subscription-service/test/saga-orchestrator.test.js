import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { MemoryBus, MemoryCache, setCache, getMemoryDb, TOPICS, EVENTS, cacheKeys } from '@streaming/shared';
import { createSubscriptionApp } from '../src/app.js';
import { createBillingApp } from '../../billing-service/src/app.js';
import { SAGA_STATES } from '../src/domain/saga-definition.js';

/**
 * Orchestrator + participant, wired together over a real (in-memory) event bus.
 *
 * This is the test that proves the saga actually works: subscription-service and
 * billing-service only ever communicate through published events, exactly as
 * they would over Kafka.
 */
const SECRET = 'dev-only-internal-secret';
const asUser = (id) => ({ 'x-internal-secret': SECRET, 'x-user-id': id });

function buildStack() {
  getMemoryDb().clear();
  const cache = setCache(new MemoryCache());
  const bus = new MemoryBus({ retryDelayMs: 1 });
  const subscriptionApp = createSubscriptionApp({ cache, bus });
  const billingApp = createBillingApp({ bus });
  return { cache, bus, subscriptionApp, billingApp };
}

describe('Subscribe saga (orchestrator + billing over the bus)', () => {
  let stack;
  beforeEach(() => {
    stack = buildStack();
  });

  test('happy path: pending -> charged -> active, and an event is published', async () => {
    const { subscriptionApp, bus } = stack;

    const res = await request(subscriptionApp)
      .post('/subscriptions')
      .set(asUser('u1'))
      .send({ planId: 'premium', paymentMethod: { cardNumber: '4111111111111111' } });

    assert.equal(res.status, 202, 'the API returns immediately; the saga runs async');
    assert.equal(res.body.state, SAGA_STATES.AWAITING_PAYMENT);

    await bus.drain();

    const detail = await request(subscriptionApp)
      .get(`/subscriptions/${res.body.subscriptionId}`)
      .set(asUser('u1'));

    assert.equal(detail.body.subscription.status, 'active');
    assert.equal(detail.body.saga.state, SAGA_STATES.COMPLETED);
    assert.ok(detail.body.subscription.paymentId, 'the payment id was recorded');

    const activated = bus.eventsOfType(EVENTS.SUBSCRIPTION_ACTIVATED);
    assert.equal(activated.length, 1);
    assert.equal(activated[0].payload.planId, 'premium');
  });

  test('records the full transition history', async () => {
    const { subscriptionApp, bus } = stack;
    const res = await request(subscriptionApp)
      .post('/subscriptions').set(asUser('u1'))
      .send({ planId: 'basic', paymentMethod: { cardNumber: '4111111111111111' } });
    await bus.drain();

    const detail = await request(subscriptionApp)
      .get(`/subscriptions/${res.body.subscriptionId}`).set(asUser('u1'));

    assert.deepEqual(
      detail.body.saga.history.map((h) => h.to),
      ['AWAITING_PAYMENT', 'ACTIVATING', 'COMPLETED']
    );
  });

  test('declined card: subscription fails and the user is NOT entitled', async () => {
    const { subscriptionApp, bus } = stack;

    const res = await request(subscriptionApp)
      .post('/subscriptions').set(asUser('u2'))
      // The simulated gateway always declines a card ending 0000.
      .send({ planId: 'premium', paymentMethod: { cardNumber: '4000000000000000' } });
    await bus.drain();

    const detail = await request(subscriptionApp)
      .get(`/subscriptions/${res.body.subscriptionId}`).set(asUser('u2'));

    assert.equal(detail.body.subscription.status, 'failed');
    assert.equal(detail.body.subscription.failureReason, 'card_declined');
    assert.equal(detail.body.saga.state, SAGA_STATES.FAILED);

    const ent = await request(subscriptionApp).get('/subscriptions/entitlement').set(asUser('u2'));
    assert.equal(ent.body.entitled, false);
    assert.equal(ent.body.reason, 'no_active_subscription');

    assert.equal(bus.eventsOfType(EVENTS.SUBSCRIPTION_ACTIVATED).length, 0);
    assert.equal(bus.eventsOfType(EVENTS.SUBSCRIPTION_FAILED).length, 1);
  });

  test('COMPENSATION: when activation fails after charging, the money is refunded', async () => {
    const { subscriptionApp, billingApp, bus } = stack;
    const orchestrator = subscriptionApp.locals.orchestrator;
    const repo = subscriptionApp.locals.repo;

    // Force the local activation step to blow up, which is the only way to reach
    // the compensation branch. This simulates "payment took, database died".
    const originalUpdate = repo.updateSubscription.bind(repo);
    repo.updateSubscription = async (id, patch) => {
      if (patch.status === 'active') throw new Error('database unavailable');
      return originalUpdate(id, patch);
    };

    const res = await request(subscriptionApp)
      .post('/subscriptions').set(asUser('u3'))
      .send({ planId: 'premium', paymentMethod: { cardNumber: '4111111111111111' } });
    await bus.drain();

    const saga = await orchestrator.repo.findSaga(res.body.sagaId);
    assert.equal(saga.state, SAGA_STATES.FAILED, 'the saga ends FAILED, not stuck');

    // A refund was requested AND completed.
    const refundRequests = bus.published.filter((p) => p.event.type === EVENTS.REFUND_REQUESTED);
    const refundsDone = bus.eventsOfType(EVENTS.REFUND_COMPLETED);
    assert.equal(refundRequests.length, 1, 'a refund was requested');
    assert.equal(refundsDone.length, 1, 'billing completed the refund');

    // The payment row reflects the refund.
    const payments = await request(billingApp).get('/billing/payments').set(asUser('u3'));
    assert.equal(payments.body.items[0].status, 'refunded');
    assert.ok(payments.body.items[0].refundId);

    const history = saga.history.map((h) => h.to);
    assert.deepEqual(history, ['AWAITING_PAYMENT', 'ACTIVATING', 'COMPENSATING_REFUND', 'FAILED']);
  });

  test('a user cannot hold two active subscriptions', async () => {
    const { subscriptionApp, bus } = stack;
    await request(subscriptionApp).post('/subscriptions').set(asUser('u4'))
      .send({ planId: 'basic', paymentMethod: { cardNumber: '4111111111111111' } });
    await bus.drain();

    const second = await request(subscriptionApp).post('/subscriptions').set(asUser('u4'))
      .send({ planId: 'premium', paymentMethod: { cardNumber: '4111111111111111' } });

    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'CONFLICT');
  });

  test('Idempotency-Key stops a retried subscribe from charging twice', async () => {
    const { subscriptionApp, billingApp, bus } = stack;
    const send = () =>
      request(subscriptionApp)
        .post('/subscriptions')
        .set({ ...asUser('u5'), 'idempotency-key': 'retry-me' })
        .send({ planId: 'standard', paymentMethod: { cardNumber: '4111111111111111' } });

    const first = await send();
    const retry = await send();
    await bus.drain();

    assert.equal(retry.body.idempotentReplay, true);
    assert.equal(first.body.sagaId, retry.body.sagaId, 'no second saga');

    const payments = await request(billingApp).get('/billing/payments').set(asUser('u5'));
    assert.equal(payments.body.items.length, 1, 'exactly one charge');
  });

  test('billing ignores a redelivered charge command (at-least-once safety)', async () => {
    const { subscriptionApp, billingApp, bus } = stack;

    const res = await request(subscriptionApp).post('/subscriptions').set(asUser('u6'))
      .send({ planId: 'basic', paymentMethod: { cardNumber: '4111111111111111' } });
    await bus.drain();

    // Replay the exact charge command Kafka already delivered once.
    const chargeCommand = bus.published.find((p) => p.event.type === EVENTS.CHARGE_REQUESTED).event;
    await bus.publish(TOPICS.BILLING_COMMANDS, chargeCommand);
    await bus.drain();

    const payments = await request(billingApp).get('/billing/payments').set(asUser('u6'));
    assert.equal(payments.body.items.length, 1, 'a duplicate command must not create a second payment');
    assert.ok(res.body.sagaId);
  });

  test('cancelling clears the cached entitlement', async () => {
    const { subscriptionApp, bus, cache } = stack;

    const res = await request(subscriptionApp).post('/subscriptions').set(asUser('u7'))
      .send({ planId: 'premium', paymentMethod: { cardNumber: '4111111111111111' } });
    await bus.drain();

    const before = await request(subscriptionApp).get('/subscriptions/entitlement').set(asUser('u7'));
    assert.equal(before.body.entitled, true);
    assert.ok(await cache.get(cacheKeys.entitlement('u7')), 'entitlement is cached');

    await request(subscriptionApp).post(`/subscriptions/${res.body.subscriptionId}/cancel`).set(asUser('u7'));

    assert.equal(await cache.get(cacheKeys.entitlement('u7')), null, 'cache was invalidated');
    const after = await request(subscriptionApp).get('/subscriptions/entitlement').set(asUser('u7'));
    assert.equal(after.body.entitled, false, 'a cancelled user must lose access immediately');
  });

  test('entitlement is served from cache on the second read', async () => {
    const { subscriptionApp, bus } = stack;
    await request(subscriptionApp).post('/subscriptions').set(asUser('u8'))
      .send({ planId: 'standard', paymentMethod: { cardNumber: '4111111111111111' } });
    await bus.drain();

    const first = await request(subscriptionApp).get('/subscriptions/entitlement').set(asUser('u8'));
    const second = await request(subscriptionApp).get('/subscriptions/entitlement').set(asUser('u8'));

    assert.equal(first.body.cached, false);
    assert.equal(second.body.cached, true);
    assert.equal(second.body.maxQuality, '1080p');
  });
});
