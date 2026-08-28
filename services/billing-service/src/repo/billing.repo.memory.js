import { getMemoryDb } from '@streaming/shared';

export function createMemoryBillingRepo(db = getMemoryDb()) {
  const payments = db.table('payments', { primaryKey: 'id' });
  const processed = db.table('billing_processed_events', { primaryKey: 'id' });

  return {
    async createPayment(row) {
      return payments.insert(row);
    },
    async findPayment(id) {
      return payments.findByPk(id);
    },
    /** Idempotency: the same charge command must never create two payments. */
    async findByIdempotencyKey(key) {
      return payments.findOne((p) => p.idempotency_key === key);
    },
    async updatePayment(id, patch) {
      return payments.update(id, { ...patch, updated_at: new Date().toISOString() });
    },
    async listByUser(userId, { limit = 50 } = {}) {
      return payments.find((p) => p.user_id === userId, { sort: (a, b) => b.__seq - a.__seq, limit });
    },
    async markEventProcessed(eventId, consumer) {
      const id = `${consumer}:${eventId}`;
      if (processed.findByPk(id)) return false;
      processed.insert({ id, processed_at: new Date().toISOString() });
      return true;
    }
  };
}
