import { metrics } from '../metrics.js';
import { TOPICS } from './topics.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * In-process event bus that reproduces the behaviours used by the core tests:
 *  - named subscriptions (each subscription gets a copy of every message)
 *  - per-key ordering
 *  - bounded retries then a dead-letter topic
 *
 * It is not a Kafka emulator: it has no broker, offsets, rebalances, partitions,
 * persistence, or same-group load balancing. Delivery is asynchronous, so tests
 * use `drain()` instead of sleeping for an arbitrary time.
 */
export class MemoryBus {
  constructor({ maxRetries = 3, retryDelayMs = 5 } = {}) {
    this.subscriptions = []; // { topic, groupId, handler, types }
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
    this.pending = new Set();
    this.dlq = [];
    this.published = [];
    this.connected = false;
    // One serialised queue per (group, key) preserves ordering per user/entity.
    this.chains = new Map();
  }

  async connect() {
    this.connected = true;
  }

  async publish(topic, event) {
    if (!this.connected) await this.connect();
    metrics.eventsPublished.inc({ topic, type: event.type });
    this.published.push({ topic, event });

    const matching = this.subscriptions.filter(
      (s) => s.topic === topic && (!s.types || s.types.includes(event.type))
    );

    for (const sub of matching) {
      const chainKey = `${sub.groupId}:${event.key ?? event.eventId}`;
      const previous = this.chains.get(chainKey) || Promise.resolve();
      const next = previous.then(() => this.#deliver(sub, topic, event));
      this.chains.set(chainKey, next.catch(() => {}));
      this.#track(next);
    }
    return { topic, eventId: event.eventId };
  }

  async publishAll(topic, events) {
    for (const e of events) await this.publish(topic, e);
  }

  async #deliver(sub, topic, event) {
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        await sub.handler(event, { topic, attempt, groupId: sub.groupId });
        metrics.eventsConsumed.inc({ topic, type: event.type, group: sub.groupId });
        return;
      } catch (err) {
        metrics.eventsFailed.inc({ topic, type: event.type, group: sub.groupId });
        if (attempt === this.maxRetries) {
          this.dlq.push({ topic, event, groupId: sub.groupId, error: err.message, attempts: attempt });
          if (topic !== TOPICS.DEAD_LETTER) {
            this.published.push({ topic: TOPICS.DEAD_LETTER, event: { ...event, error: err.message } });
          }
          return;
        }
        await sleep(this.retryDelayMs * attempt);
      }
    }
  }

  #track(promise) {
    const p = promise.catch(() => {}).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** topic, handler, { groupId, types } */
  async subscribe(topic, handler, { groupId = 'default', types = null } = {}) {
    this.subscriptions.push({ topic, groupId, handler, types });
    return { unsubscribe: () => {
      const i = this.subscriptions.findIndex((s) => s.handler === handler && s.topic === topic);
      if (i >= 0) this.subscriptions.splice(i, 1);
    } };
  }

  /** Resolves once every in-flight delivery (and anything they published) is done. */
  async drain() {
    let guard = 0;
    while (this.pending.size > 0 && guard < 1000) {
      await Promise.all([...this.pending]);
      await sleep(1);
      guard += 1;
    }
  }

  eventsOfType(type) {
    return this.published.filter((p) => p.event.type === type).map((p) => p.event);
  }

  reset() {
    this.published = [];
    this.dlq = [];
    this.chains.clear();
  }

  async healthy() {
    return true;
  }

  async close() {
    await this.drain();
    this.subscriptions = [];
    this.connected = false;
  }
}
