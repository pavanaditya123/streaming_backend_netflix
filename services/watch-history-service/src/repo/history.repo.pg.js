import { postgres } from '@streaming/shared';

const { query } = postgres;

/**
 * Postgres watch-history repository.
 *
 * The table is keyed on (user_id, title_id) so re-watching updates one row
 * rather than growing forever, and every read is served by the
 * (user_id, last_watched_at DESC) index.
 */
export function createPgHistoryRepo() {
  return {
    async upsertProgress({ userId, titleId, titleName, positionSeconds, durationSeconds, completed, watchedAt }) {
      const { rows } = await query(
        `INSERT INTO watch_history.entries
           (user_id, title_id, title_name, position_seconds, duration_seconds, completed,
            play_count, total_watched_seconds, first_watched_at, last_watched_at)
         -- position_seconds is INT and total_watched_seconds is BIGINT, so they
         -- get separate placeholders ($4 and $8) even though the value is the
         -- same: one parameter cannot be deduced as two different types.
         VALUES ($1,$2,$3,$4,$5,$6,1,$8,$7,$7)
         ON CONFLICT (user_id, title_id) DO UPDATE SET
           title_name            = COALESCE(EXCLUDED.title_name, watch_history.entries.title_name),
           position_seconds      = EXCLUDED.position_seconds,
           duration_seconds      = COALESCE(EXCLUDED.duration_seconds, watch_history.entries.duration_seconds),
           completed             = watch_history.entries.completed OR EXCLUDED.completed,
           total_watched_seconds = GREATEST(watch_history.entries.total_watched_seconds, EXCLUDED.position_seconds),
           last_watched_at       = EXCLUDED.last_watched_at
         RETURNING *`,
        [userId, titleId, titleName ?? null, positionSeconds, durationSeconds ?? null,
         Boolean(completed), watchedAt, positionSeconds]
      );
      return rows[0];
    },

    async incrementPlayCount({ userId, titleId, titleName, durationSeconds, watchedAt }) {
      const { rows } = await query(
        `INSERT INTO watch_history.entries
           (user_id, title_id, title_name, position_seconds, duration_seconds, completed,
            play_count, total_watched_seconds, first_watched_at, last_watched_at)
         VALUES ($1,$2,$3,0,$4,false,1,0,$5,$5)
         ON CONFLICT (user_id, title_id) DO UPDATE SET
           play_count      = watch_history.entries.play_count + 1,
           last_watched_at = EXCLUDED.last_watched_at,
           title_name      = COALESCE(EXCLUDED.title_name, watch_history.entries.title_name)
         RETURNING *`,
        [userId, titleId, titleName ?? null, durationSeconds ?? null, watchedAt]
      );
      return rows[0];
    },

    async listByUser(userId, { limit = 20, offset = 0 } = {}) {
      const { rows } = await query(
        `SELECT *, COUNT(*) OVER() AS total_count
           FROM watch_history.entries
          WHERE user_id = $1
          ORDER BY last_watched_at DESC
          LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );
      return {
        items: rows.map(({ total_count: _t, ...r }) => r),
        total: rows.length ? Number(rows[0].total_count) : 0
      };
    },

    async continueWatching(userId, { limit = 10 } = {}) {
      const { rows } = await query(
        `SELECT * FROM watch_history.entries
          WHERE user_id = $1 AND completed = false AND position_seconds >= 30
          ORDER BY last_watched_at DESC LIMIT $2`,
        [userId, limit]
      );
      return rows;
    },

    async findEntry(userId, titleId) {
      const { rows } = await query(
        `SELECT * FROM watch_history.entries WHERE user_id = $1 AND title_id = $2`,
        [userId, titleId]
      );
      return rows[0] || null;
    },

    async stats(userId) {
      const { rows } = await query(
        `SELECT COUNT(*)::int AS titles_watched,
                COUNT(*) FILTER (WHERE completed)::int AS completed,
                COUNT(*) FILTER (WHERE NOT completed AND position_seconds >= 30)::int AS in_progress,
                COALESCE(SUM(total_watched_seconds),0)::bigint AS total_watched_seconds
           FROM watch_history.entries WHERE user_id = $1`,
        [userId]
      );
      const r = rows[0];
      return {
        titlesWatched: r.titles_watched,
        completed: r.completed,
        inProgress: r.in_progress,
        totalWatchedSeconds: Number(r.total_watched_seconds)
      };
    },

    async deleteEntry(userId, titleId) {
      const { rowCount } = await query(
        `DELETE FROM watch_history.entries WHERE user_id = $1 AND title_id = $2`,
        [userId, titleId]
      );
      return rowCount > 0;
    },

    async markEventProcessed(eventId, consumer) {
      const { rowCount } = await query(
        `INSERT INTO watch_history.processed_events (id, event_id, consumer, processed_at)
         VALUES ($1,$2,$3,NOW()) ON CONFLICT (id) DO NOTHING`,
        [`${consumer}:${eventId}`, eventId, consumer]
      );
      return rowCount > 0;
    }
  };
}
