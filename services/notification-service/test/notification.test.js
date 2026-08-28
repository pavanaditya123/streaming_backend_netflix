import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { MemoryBus, getMemoryDb, createEvent, TOPICS, EVENTS } from '@streaming/shared';
import { createNotificationApp } from '../src/app.js';
import { render } from '../src/domain/templates.js';

const asUser = (id) => ({ 'x-internal-secret': 'dev-only-internal-secret', 'x-user-id': id });

function build() {
  getMemoryDb().clear();
  const bus = new MemoryBus({ retryDelayMs: 1 });
  const delivered = [];
  const app = createNotificationApp({ bus, deliver: async (n) => delivered.push(n) });
  return { app, bus, delivered };
}

describe('notification templates (pure)', () => {
  test('renders a welcome message on registration', () => {
    const out = render(createEvent(EVENTS.USER_REGISTERED, { userId: 'u1', displayName: 'Pavan' }));
    assert.equal(out.channel, 'email');
    assert.match(out.body, /Pavan/);
  });

  test('renders plan details on activation', () => {
    const out = render(createEvent(EVENTS.SUBSCRIPTION_ACTIVATED, {
      userId: 'u1', planName: 'Premium', priceMinor: 64900, maxStreams: 4,
      maxQuality: '4K', currentPeriodEnd: '2026-09-25T00:00:00.000Z'
    }));
    assert.match(out.subject, /Premium/);
    assert.match(out.body, /649\.00/, 'money is formatted from minor units');
    assert.match(out.body, /4K/);
  });

  test('explains WHY a subscription failed', () => {
    const declined = render(createEvent(EVENTS.SUBSCRIPTION_FAILED, { userId: 'u1', reason: 'card_declined' }));
    assert.match(declined.body, /declined/i);

    const refunded = render(createEvent(EVENTS.SUBSCRIPTION_FAILED, {
      userId: 'u1', reason: 'activation_failed_refunded'
    }));
    assert.match(refunded.body, /refunded/i, 'a compensated saga must tell the user their money is back');
  });

  test('only notifies about a FINISHED title, not every stop', () => {
    const finished = render(createEvent(EVENTS.PLAYBACK_STOPPED, { userId: 'u1', titleName: 'Dune', completed: true }));
    const paused = render(createEvent(EVENTS.PLAYBACK_STOPPED, { userId: 'u1', titleName: 'Dune', completed: false }));
    assert.ok(finished, 'finishing something is worth a notification');
    assert.equal(paused, null, 'pausing is not');
  });

  test('returns null for an event with no template', () => {
    assert.equal(render(createEvent('something.unrelated', { userId: 'u1' })), null);
  });
});

describe('notification service', () => {
  let ctx;
  beforeEach(() => { ctx = build(); });

  test('fans in from several topics', async () => {
    await ctx.bus.publish(TOPICS.USER_EVENTS,
      createEvent(EVENTS.USER_REGISTERED, { userId: 'u1', displayName: 'Pavan', email: 'p@x.com' }, { key: 'u1' }));
    await ctx.bus.publish(TOPICS.SUBSCRIPTION_EVENTS,
      createEvent(EVENTS.SUBSCRIPTION_ACTIVATED, {
        userId: 'u1', planId: 'premium', planName: 'Premium', priceMinor: 64900,
        maxStreams: 4, maxQuality: '4K', currentPeriodEnd: '2026-09-25T00:00:00.000Z'
      }, { key: 'u1' }));
    await ctx.bus.drain();

    const res = await request(ctx.app).get('/notifications').set(asUser('u1'));
    assert.equal(res.body.total, 2);
    const sources = res.body.items.map((n) => n.sourceEventType);
    assert.ok(sources.includes(EVENTS.USER_REGISTERED));
    assert.ok(sources.includes(EVENTS.SUBSCRIPTION_ACTIVATED));
  });

  test('actually delivers through the injected channel', async () => {
    await ctx.bus.publish(TOPICS.USER_EVENTS,
      createEvent(EVENTS.USER_REGISTERED, { userId: 'u1', displayName: 'Pavan' }, { key: 'u1' }));
    await ctx.bus.drain();
    assert.equal(ctx.delivered.length, 1);
  });

  test('publishes a notification.sent event of its own', async () => {
    await ctx.bus.publish(TOPICS.USER_EVENTS,
      createEvent(EVENTS.USER_REGISTERED, { userId: 'u1', displayName: 'Pavan' }, { key: 'u1' }));
    await ctx.bus.drain();
    assert.equal(ctx.bus.eventsOfType(EVENTS.NOTIFICATION_SENT).length, 1);
  });

  test('a redelivered event does not notify twice', async () => {
    const event = createEvent(EVENTS.USER_REGISTERED, { userId: 'u1', displayName: 'Pavan' }, { key: 'u1' });
    await ctx.bus.publish(TOPICS.USER_EVENTS, event);
    await ctx.bus.publish(TOPICS.USER_EVENTS, event);
    await ctx.bus.drain();

    const res = await request(ctx.app).get('/notifications').set(asUser('u1'));
    assert.equal(res.body.total, 1, 'nobody wants the same email twice');
  });

  test('ignores high-volume playback events that are not notifiable', async () => {
    for (let i = 0; i < 20; i += 1) {
      await ctx.bus.publish(TOPICS.PLAYBACK_EVENTS,
        createEvent(EVENTS.PLAYBACK_PROGRESS, { userId: 'u1', titleId: 't1', positionSeconds: i * 60 }, { key: 'u1' }));
    }
    await ctx.bus.drain();

    const res = await request(ctx.app).get('/notifications').set(asUser('u1'));
    assert.equal(res.body.total, 0, 'progress heartbeats must never become notifications');
  });

  test('tracks read state', async () => {
    await ctx.bus.publish(TOPICS.USER_EVENTS,
      createEvent(EVENTS.USER_REGISTERED, { userId: 'u1', displayName: 'Pavan' }, { key: 'u1' }));
    await ctx.bus.drain();

    const before = await request(ctx.app).get('/notifications/unread-count').set(asUser('u1'));
    assert.equal(before.body.count, 1);

    const list = await request(ctx.app).get('/notifications').set(asUser('u1'));
    await request(ctx.app).post(`/notifications/${list.body.items[0].id}/read`).set(asUser('u1'));

    const after = await request(ctx.app).get('/notifications/unread-count').set(asUser('u1'));
    assert.equal(after.body.count, 0);
  });

  test('a user cannot read another user notification', async () => {
    await ctx.bus.publish(TOPICS.USER_EVENTS,
      createEvent(EVENTS.USER_REGISTERED, { userId: 'u1', displayName: 'Pavan' }, { key: 'u1' }));
    await ctx.bus.drain();

    const list = await request(ctx.app).get('/notifications').set(asUser('u1'));
    const attempt = await request(ctx.app)
      .post(`/notifications/${list.body.items[0].id}/read`).set(asUser('attacker'));
    assert.equal(attempt.status, 404);
  });
});
