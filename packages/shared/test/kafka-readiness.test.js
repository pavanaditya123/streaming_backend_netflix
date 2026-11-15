import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { KafkaBus } from '../src/bus/kafka-bus.js';

// Just enough of a kafkajs client to see when the bus reports ready.
function fakeKafka() {
  const consumers = [];
  return {
    consumers,
    consumer() {
      const c = new EventEmitter();
      c.events = { GROUP_JOIN: 'consumer.group_join' };
      c.connect = async () => {};
      c.subscribe = async () => {};
      c.run = async () => {};
      c.disconnect = async () => {};
      consumers.push(c);
      return c;
    },
    admin() {
      return { connect: async () => {}, listTopics: async () => [], disconnect: async () => {} };
    }
  };
}

test('not ready until every consumer group has joined', async () => {
  const bus = new KafkaBus({ brokers: ['unused:9092'], clientId: 'test' });
  bus.kafka = fakeKafka();

  await bus.subscribe('billing.commands', async () => {}, { groupId: 'billing' });
  await bus.subscribe('billing.events', async () => {}, { groupId: 'subscription' });
  assert.equal(await bus.healthy(), false, 'no group has joined yet');

  bus.kafka.consumers[0].emit('consumer.group_join');
  assert.equal(await bus.healthy(), false, 'one group is still joining');

  bus.kafka.consumers[1].emit('consumer.group_join');
  assert.equal(await bus.healthy(), true);
});
