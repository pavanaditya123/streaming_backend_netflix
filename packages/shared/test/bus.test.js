import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBus } from '../src/bus/memory-bus.js';
import { createEvent } from '../src/bus/envelope.js';
import { TOPICS, EVENTS } from '../src/bus/topics.js';

describe('MemoryBus', () => {
  let bus;
  beforeEach(() => {
    bus = new MemoryBus({ maxRetries: 3, retryDelayMs: 1 });
  });

  test('delivers a published event to a subscriber', async () => {
    const received = [];
    await bus.subscribe(TOPICS.PLAYBACK_EVENTS, async (e) => received.push(e), { groupId: 'g1' });

    await bus.publish(
      TOPICS.PLAYBACK_EVENTS,
      createEvent(EVENTS.PLAYBACK_STARTED, { titleId: 't1' }, { key: 'u1' })
    );
    await bus.drain();

    assert.equal(received.length, 1);
    assert.equal(received[0].type, EVENTS.PLAYBACK_STARTED);
    assert.equal(received[0].payload.titleId, 't1');
  });

  test('gives every consumer GROUP its own copy of the message', async () => {
    const a = [];
    const b = [];
    await bus.subscribe(TOPICS.PLAYBACK_EVENTS, async (e) => a.push(e), { groupId: 'group-a' });
    await bus.subscribe(TOPICS.PLAYBACK_EVENTS, async (e) => b.push(e), { groupId: 'group-b' });

    await bus.publish(TOPICS.PLAYBACK_EVENTS, createEvent(EVENTS.PLAYBACK_STARTED, {}, { key: 'u1' }));
    await bus.drain();

    assert.equal(a.length, 1, 'group-a receives it');
    assert.equal(b.length, 1, 'group-b receives it independently');
  });

  test('filters by event type when the subscription asks for specific types', async () => {
    const received = [];
    await bus.subscribe(TOPICS.PLAYBACK_EVENTS, async (e) => received.push(e.type), {
      groupId: 'filtered',
      types: [EVENTS.PLAYBACK_STOPPED]
    });

    await bus.publish(TOPICS.PLAYBACK_EVENTS, createEvent(EVENTS.PLAYBACK_STARTED, {}, { key: 'u1' }));
    await bus.publish(TOPICS.PLAYBACK_EVENTS, createEvent(EVENTS.PLAYBACK_STOPPED, {}, { key: 'u1' }));
    await bus.drain();

    assert.deepEqual(received, [EVENTS.PLAYBACK_STOPPED]);
  });

  test('preserves per-key ordering', async () => {
    const order = [];
    await bus.subscribe(
      TOPICS.PLAYBACK_EVENTS,
      async (e) => {
        // Deliberately make the first handler slow: ordering must still hold.
        await new Promise((r) => setTimeout(r, e.payload.n === 1 ? 20 : 1));
        order.push(e.payload.n);
      },
      { groupId: 'ordered' }
    );

    for (const n of [1, 2, 3]) {
      await bus.publish(TOPICS.PLAYBACK_EVENTS, createEvent(EVENTS.PLAYBACK_PROGRESS, { n }, { key: 'same-user' }));
    }
    await bus.drain();

    assert.deepEqual(order, [1, 2, 3], 'events for one key must arrive in order');
  });

  test('retries a failing handler, then dead-letters it', async () => {
    let attempts = 0;
    await bus.subscribe(
      TOPICS.PLAYBACK_EVENTS,
      async () => {
        attempts += 1;
        throw new Error('handler blew up');
      },
      { groupId: 'flaky' }
    );

    await bus.publish(TOPICS.PLAYBACK_EVENTS, createEvent(EVENTS.PLAYBACK_STARTED, {}, { key: 'u1' }));
    await bus.drain();

    assert.equal(attempts, 3, 'should retry up to maxRetries');
    assert.equal(bus.dlq.length, 1, 'the poison message ends up in the DLQ');
    assert.match(bus.dlq[0].error, /handler blew up/);
  });

  test('recovers if the handler succeeds on a retry', async () => {
    let attempts = 0;
    const done = [];
    await bus.subscribe(
      TOPICS.PLAYBACK_EVENTS,
      async (e) => {
        attempts += 1;
        if (attempts < 2) throw new Error('transient');
        done.push(e.eventId);
      },
      { groupId: 'recovering' }
    );

    await bus.publish(TOPICS.PLAYBACK_EVENTS, createEvent(EVENTS.PLAYBACK_STARTED, {}, { key: 'u1' }));
    await bus.drain();

    assert.equal(done.length, 1);
    assert.equal(bus.dlq.length, 0);
  });

  test('one failing consumer does not stop another', async () => {
    const good = [];
    await bus.subscribe(TOPICS.PLAYBACK_EVENTS, async () => { throw new Error('down'); }, { groupId: 'broken' });
    await bus.subscribe(TOPICS.PLAYBACK_EVENTS, async (e) => good.push(e), { groupId: 'healthy' });

    await bus.publish(TOPICS.PLAYBACK_EVENTS, createEvent(EVENTS.PLAYBACK_STARTED, {}, { key: 'u1' }));
    await bus.drain();

    assert.equal(good.length, 1, 'the healthy consumer still gets its copy');
  });
});

describe('event envelope', () => {
  test('carries an id, a timestamp and a correlation id', () => {
    const e = createEvent('some.thing.happened', { a: 1 }, { key: 'u1', correlationId: 'req-1' });
    assert.ok(e.eventId);
    assert.equal(e.type, 'some.thing.happened');
    assert.equal(e.key, 'u1');
    assert.equal(e.correlationId, 'req-1');
    assert.ok(!Number.isNaN(Date.parse(e.occurredAt)));
    assert.deepEqual(e.payload, { a: 1 });
  });
});
