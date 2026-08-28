import { postgres } from '@streaming/shared';

const { query } = postgres;

export function createPgBillingRepo() {
  return {
    async createPayment(row) {
      const { rows } = await query(
        `INSERT INTO billing.payments
           (id, user_id, subscription_id, saga_id, idempotency_key, amount_minor, currency,
            status, failure_reason, refund_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
        [row.id, row.user_id, row.subscription_id, row.saga_id, row.idempotency_key,
         row.amount_minor, row.currency, row.status, row.failure_reason ?? null,
         row.refund_id ?? null, row.created_at]
      );
      return rows[0];
    },

    async findPayment(id) {
      const { rows } = await query(`SELECT * FROM billing.payments WHERE id = $1`, [id]);
      return rows[0] || null;
    },

    async findByIdempotencyKey(key) {
      const { rows } = await query(`SELECT * FROM billing.payments WHERE idempotency_key = $1`, [key]);
      return rows[0] || null;
    },

    async updatePayment(id, patch) {
      const { rows } = await query(
        `UPDATE billing.payments SET
           status = COALESCE($2, status),
           failure_reason = COALESCE($3, failure_reason),
           refund_id = COALESCE($4, refund_id),
           updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id, patch.status ?? null, patch.failure_reason ?? null, patch.refund_id ?? null]
      );
      return rows[0] || null;
    },

    async listByUser(userId, { limit = 50 } = {}) {
      const { rows } = await query(
        `SELECT * FROM billing.payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [userId, limit]
      );
      return rows;
    },

    async markEventProcessed(eventId, consumer) {
      const { rowCount } = await query(
        `INSERT INTO billing.processed_events (id, event_id, consumer, processed_at)
         VALUES ($1,$2,$3,NOW()) ON CONFLICT (id) DO NOTHING`,
        [`${consumer}:${eventId}`, eventId, consumer]
      );
      return rowCount > 0;
    }
  };
}
