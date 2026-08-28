import { config } from '../config.js';
import { MemoryBus } from './memory-bus.js';
import { KafkaBus } from './kafka-bus.js';

export { MemoryBus, KafkaBus };
export * from './topics.js';
export * from './envelope.js';

let singleton = null;

export function createBus({ driver = config.drivers.bus } = {}) {
  if (driver === 'kafka') {
    return new KafkaBus({ brokers: config.kafka.brokers, clientId: config.kafka.clientId });
  }
  return new MemoryBus();
}

export function getBus() {
  if (!singleton) singleton = createBus();
  return singleton;
}

export function setBus(instance) {
  singleton = instance;
  return singleton;
}
