import { Kafka, logLevel } from 'kafkajs';
import { metrics } from '../metrics.js';
import { TOPICS } from './topics.js';

/**
 * Kafka adapter (production driver).
 *
 * Mirrors MemoryBus exactly: consumer groups, per-key ordering (Kafka gives us
 * this via partitioning on `event.key`), bounded retries, then dead-letter.
 */
export class KafkaBus {
  constructor({ brokers, clientId, maxRetries = 3 }) {
    this.kafka = new Kafka({ clientId, brokers, logLevel: logLevel.ERROR, retry: { retries: 5 } });
    this.producer = this.kafka.producer({ allowAutoTopicCreation: true, idempotent: true });
    this.consumers = [];
    this.maxRetries = maxRetries;
    this.connected = false;
  }

  async connect() {
    if (this.connected) return;
    await this.producer.connect();
    this.connected = true;
  }

  async publish(topic, event) {
    await this.connect();
    await this.producer.send({
      topic,
      messages: [
        {
          key: event.key ?? event.eventId,
          value: JSON.stringify(event),
          headers: {
            'event-type': event.type,
            'correlation-id': event.correlationId ?? ''
          }
        }
      ]
    });
    metrics.eventsPublished.inc({ topic, type: event.type });
    return { topic, eventId: event.eventId };
  }

  async publishAll(topic, events) {
    await this.connect();
    await this.producer.send({
      topic,
      messages: events.map((event) => ({ key: event.key ?? event.eventId, value: JSON.stringify(event) }))
    });
  }

  async subscribe(topic, handler, { groupId = 'default', types = null, fromBeginning = false } = {}) {
    const consumer = this.kafka.consumer({ groupId, sessionTimeout: 30_000 });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning });

    await consumer.run({
      eachMessage: async ({ message }) => {
        let event;
        try {
          event = JSON.parse(message.value.toString());
        } catch {
          return; // poison message: cannot even parse it, drop rather than block the partition
        }
        if (types && !types.includes(event.type)) return;

        for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
          try {
            await handler(event, { topic, attempt, groupId });
            metrics.eventsConsumed.inc({ topic, type: event.type, group: groupId });
            return;
          } catch (err) {
            metrics.eventsFailed.inc({ topic, type: event.type, group: groupId });
            if (attempt === this.maxRetries) {
              // Park it so the partition keeps moving instead of blocking forever.
              await this.publish(TOPICS.DEAD_LETTER, {
                ...event,
                type: `${event.type}.dlq`,
                payload: { originalTopic: topic, groupId, error: err.message, original: event.payload }
              });
              return;
            }
            await new Promise((r) => setTimeout(r, 100 * attempt));
          }
        }
      }
    });

    this.consumers.push(consumer);
    return { unsubscribe: () => consumer.disconnect() };
  }

  async drain() {
    // No-op for Kafka: real consumers are always running. Tests poll instead.
  }

  async healthy() {
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      await admin.listTopics();
      return true;
    } catch {
      return false;
    } finally {
      await admin.disconnect().catch(() => {});
    }
  }

  async close() {
    await Promise.all(this.consumers.map((c) => c.disconnect().catch(() => {})));
    if (this.connected) await this.producer.disconnect().catch(() => {});
    this.connected = false;
  }
}
