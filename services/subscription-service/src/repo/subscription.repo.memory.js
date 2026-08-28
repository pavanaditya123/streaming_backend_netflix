import { getMemoryDb } from '@streaming/shared';

/** In-memory subscription + saga repository (DATA_DRIVER=memory). */
export function createMemorySubscriptionRepo(db = getMemoryDb()) {
  const subs = db.table('subscriptions', { primaryKey: 'id' });
  const sagas = db.table('saga_instances', { primaryKey: 'id' });
  const processed = db.table('processed_events', { primaryKey: 'id' });
  const idem = db.table('idempotency_keys', { primaryKey: 'id' });

  return {
    // ---- subscriptions ---------------------------------------------------
    async createSubscription(row) {
      return subs.insert(row);
    },
    async findSubscription(id) {
      return subs.findByPk(id);
    },
    async findActiveByUser(userId) {
      return subs.findOne((s) => s.user_id === userId && s.status === 'active');
    },
    async listByUser(userId) {
      return subs.find((s) => s.user_id === userId, { sort: (a, b) => b.__seq - a.__seq });
    },
    async updateSubscription(id, patch) {
      return subs.update(id, { ...patch, updated_at: new Date().toISOString() });
    },

    // ---- saga instances --------------------------------------------------
    async createSaga(row) {
      return sagas.insert(row);
    },
    async findSaga(id) {
      return sagas.findByPk(id);
    },
    async findSagaBySubscription(subscriptionId) {
      return sagas.findOne((s) => s.subscription_id === subscriptionId);
    },
    async updateSaga(id, patch) {
      return sagas.update(id, { ...patch, updated_at: new Date().toISOString() });
    },
    async appendSagaHistory(id, entry) {
      const saga = sagas.findByPk(id);
      if (!saga) return null;
      return sagas.update(id, { history: [...(saga.history || []), entry] });
    },
    async listSagas({ limit = 50 } = {}) {
      return sagas.find(() => true, { sort: (a, b) => b.__seq - a.__seq, limit });
    },

    // ---- idempotency / dedupe -------------------------------------------
    /** Returns false if this event id was already handled by this consumer. */
    async markEventProcessed(eventId, consumer) {
      const id = `${consumer}:${eventId}`;
      if (processed.findByPk(id)) return false;
      processed.insert({ id, event_id: eventId, consumer, processed_at: new Date().toISOString() });
      return true;
    },
    async findIdempotentResult(key) {
      const row = idem.findByPk(key);
      return row ? row.result : null;
    },
    async saveIdempotentResult(key, result) {
      idem.upsert({ id: key, result, created_at: new Date().toISOString() });
    }
  };
}
