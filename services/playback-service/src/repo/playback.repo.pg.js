import { postgres } from '@streaming/shared';

const { query } = postgres;

export function createPgPlaybackRepo() {
  return {
    async createSession(row) {
      const { rows } = await query(
        `INSERT INTO playback.sessions
           (id, user_id, title_id, device_id, quality, status, position_seconds,
            started_at, last_heartbeat_at, ended_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
        [row.id, row.user_id, row.title_id, row.device_id, row.quality, row.status,
         row.position_seconds ?? 0, row.started_at, row.last_heartbeat_at,
         row.ended_at ?? null, row.created_at]
      );
      return rows[0];
    },

    async findSession(id) {
      const { rows } = await query(`SELECT * FROM playback.sessions WHERE id = $1`, [id]);
      return rows[0] || null;
    },

    async updateSession(id, patch) {
      const { rows } = await query(
        `UPDATE playback.sessions SET
           status            = COALESCE($2, status),
           position_seconds  = COALESCE($3, position_seconds),
           last_heartbeat_at = COALESCE($4, last_heartbeat_at),
           ended_at          = COALESCE($5, ended_at),
           updated_at        = NOW()
         WHERE id = $1 RETURNING *`,
        [id, patch.status ?? null, patch.position_seconds ?? null,
         patch.last_heartbeat_at ?? null, patch.ended_at ?? null]
      );
      return rows[0] || null;
    },

    async activeSessionsForUser(userId) {
      const { rows } = await query(
        `SELECT * FROM playback.sessions WHERE user_id = $1 AND status = 'playing'`,
        [userId]
      );
      return rows;
    },

    async listByUser(userId, { limit = 20 } = {}) {
      const { rows } = await query(
        `SELECT * FROM playback.sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT $2`,
        [userId, limit]
      );
      return rows;
    },

    async expireStale(cutoffISO) {
      const { rows } = await query(
        `UPDATE playback.sessions SET status = 'expired', ended_at = NOW(), updated_at = NOW()
          WHERE status = 'playing' AND last_heartbeat_at < $1 RETURNING *`,
        [cutoffISO]
      );
      return rows;
    }
  };
}
