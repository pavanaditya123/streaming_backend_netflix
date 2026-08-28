import { uuid } from '../ids.js';

/**
 * Standard event envelope.
 *
 * `key` decides the Kafka partition, which is how per-user ordering is
 * guaranteed: all events for one user land on the same partition, so a single
 * consumer processes them in order.
 */
export function createEvent(type, payload, { key, correlationId, causationId, version = 1 } = {}) {
  return {
    eventId: uuid(),
    type,
    version,
    key: key ?? null,
    correlationId: correlationId ?? uuid(),
    causationId: causationId ?? null,
    occurredAt: new Date().toISOString(),
    payload
  };
}

export function isEvent(value) {
  return Boolean(value && typeof value === 'object' && typeof value.type === 'string' && 'payload' in value);
}
