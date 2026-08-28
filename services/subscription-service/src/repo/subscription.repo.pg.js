import { postgres } from '@streaming/shared';

const { query } = postgres;

/** Postgres subscription + saga repository (DATA_DRIVER=postgres). */
export function createPgSubscriptionRepo() {
  return {
    // ---- subscriptions ---------------------------------------------------
    async createSubscription(row) {
      const { rows } = await query(
        `INSERT INTO subscriptions.subscriptions
           (id, user_id, plan_id, status, price_minor, currency, current_period_start,
            current_period_end, payment_id, failure_reason, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
         RETURNING *`,
        [row.id, row.user_id, row.plan_id, row.status, row.price_minor, row.currency,
         row.current_period_start, row.current_period_end, row.payment_id ?? null,
         row.failure_reason ?? null, row.created_at]
      );
      return rows[0];
    },

    async findSubscription(id) {
      const { rows } = await query(`SELECT * FROM subscriptions.subscriptions WHERE id = $1`, [id]);
      return rows[0] || null;
    },

    async findActiveByUser(userId) {
      // Partial unique index guarantees at most one active row per user.
      const { rows } = await query(
        `SELECT * FROM subscriptions.subscriptions
          WHERE user_id = $1 AND status = 'active'
          ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      return rows[0] || null;
    },

    async listByUser(userId) {
      const { rows } = await query(
        `SELECT * FROM subscriptions.subscriptions WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      );
      return rows;
    },

    async updateSubscription(id, patch) {
      const { rows } = await query(
        `UPDATE subscriptions.subscriptions SET
            status               = COALESCE($2, status),
            payment_id           = COALESCE($3, payment_id),
            failure_reason       = COALESCE($4, failure_reason),
            current_period_start = COALESCE($5, current_period_start),
            current_period_end   = COALESCE($6, current_period_end),
            cancelled_at         = COALESCE($7, cancelled_at),
            updated_at           = NOW()
          WHERE id = $1 RETURNING *`,
        [id, patch.status ?? null, patch.payment_id ?? null, patch.failure_reason ?? null,
         patch.current_period_start ?? null, patch.current_period_end ?? null, patch.cancelled_at ?? null]
      );
      return rows[0] || null;
    },

    // ---- saga instances --------------------------------------------------
    async createSaga(row) {
      const { rows } = await query(
        `INSERT INTO subscriptions.saga_instances
           (id, saga_type, subscription_id, user_id, state, payload, history, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
        [row.id, row.saga_type, row.subscription_id, row.user_id, row.state,
         JSON.stringify(row.payload || {}), JSON.stringify(row.history || []), row.created_at]
      );
      return rows[0];
    },

    async findSaga(id) {
      const { rows } = await query(`SELECT * FROM subscriptions.saga_instances WHERE id = $1`, [id]);
      return rows[0] || null;
    },

    async findSagaBySubscription(subscriptionId) {
      const { rows } = await query(
        `SELECT * FROM subscriptions.saga_instances WHERE subscription_id = $1 LIMIT 1`,
        [subscriptionId]
      );
      return rows[0] || null;
    },

    async updateSaga(id, patch) {
      const { rows } = await query(
        `UPDATE subscriptions.saga_instances SET
            state      = COALESCE($2, state),
            payload    = COALESCE($3, payload),
            updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [id, patch.state ?? null, patch.payload ? JSON.stringify(patch.payload) : null]
      );
      return rows[0] || null;
    },

    async appendSagaHistory(id, entry) {
      const { rows } = await query(
        `UPDATE subscriptions.saga_instances
            SET history = history || $2::jsonb, updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [id, JSON.stringify([entry])]
      );
      return rows[0] || null;
    },

    async listSagas({ limit = 50 } = {}) {
      const { rows } = await query(
        `SELECT * FROM subscriptions.saga_instances ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
      return rows;
    },

    // ---- idempotency / dedupe -------------------------------------------
    /**
     * Insert-or-ignore on the primary key. Returns false when the row already
     * existed, i.e. this consumer has seen this event before. This is what makes
     * the at-least-once delivery of Kafka safe to build on.
     */
    async markEventProcessed(eventId, consumer) {
      const { rowCount } = await query(
        `INSERT INTO subscriptions.processed_events (id, event_id, consumer, processed_at)
         VALUES ($1,$2,$3,NOW()) ON CONFLICT (id) DO NOTHING`,
        [`${consumer}:${eventId}`, eventId, consumer]
      );
      return rowCount > 0;
    },

    async findIdempotentResult(key) {
      const { rows } = await query(`SELECT result FROM subscriptions.idempotency_keys WHERE id = $1`, [key]);
      return rows[0]?.result || null;
    },

    async saveIdempotentResult(key, result) {
      await query(
        `INSERT INTO subscriptions.idempotency_keys (id, result, created_at)
         VALUES ($1,$2,NOW()) ON CONFLICT (id) DO UPDATE SET result = EXCLUDED.result`,
        [key, JSON.stringify(result)]
      );
    }
  };
}
