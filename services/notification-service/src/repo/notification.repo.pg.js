import { postgres } from '@streaming/shared';

const { query } = postgres;

export function createPgNotificationRepo() {
  return {
    async create(row) {
      const { rows } = await query(
        `INSERT INTO notifications.notifications
           (id, user_id, channel, category, subject, body, source_event_id, source_event_type, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [row.id, row.user_id, row.channel, row.category, row.subject, row.body,
         row.source_event_id, row.source_event_type, row.created_at]
      );
      return rows[0];
    },

    async listByUser(userId, { limit = 20, offset = 0, unreadOnly = false } = {}) {
      const { rows } = await query(
        `SELECT *, COUNT(*) OVER() AS total_count
           FROM notifications.notifications
          WHERE user_id = $1 AND ($4 = false OR read_at IS NULL)
          ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit, offset, unreadOnly]
      );
      return {
        items: rows.map(({ total_count: _t, ...r }) => r),
        total: rows.length ? Number(rows[0].total_count) : 0
      };
    },

    async markRead(id, userId) {
      const { rows } = await query(
        `UPDATE notifications.notifications SET read_at = NOW()
          WHERE id = $1 AND user_id = $2 RETURNING *`,
        [id, userId]
      );
      return rows[0] || null;
    },

    async markAllRead(userId) {
      const { rowCount } = await query(
        `UPDATE notifications.notifications SET read_at = NOW()
          WHERE user_id = $1 AND read_at IS NULL`,
        [userId]
      );
      return rowCount;
    },

    async unreadCount(userId) {
      const { rows } = await query(
        `SELECT COUNT(*)::int AS n FROM notifications.notifications
          WHERE user_id = $1 AND read_at IS NULL`,
        [userId]
      );
      return rows[0].n;
    },

    async markEventProcessed(eventId, consumer) {
      const { rowCount } = await query(
        `INSERT INTO notifications.processed_events (id, event_id, consumer, processed_at)
         VALUES ($1,$2,$3,NOW()) ON CONFLICT (id) DO NOTHING`,
        [`${consumer}:${eventId}`, eventId, consumer]
      );
      return rowCount > 0;
    }
  };
}
