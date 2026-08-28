import { getMemoryDb } from '@streaming/shared';

export function createMemoryPlaybackRepo(db = getMemoryDb()) {
  const sessions = db.table('playback_sessions', { primaryKey: 'id' });

  return {
    async createSession(row) {
      return sessions.insert(row);
    },
    async findSession(id) {
      return sessions.findByPk(id);
    },
    async updateSession(id, patch) {
      return sessions.update(id, { ...patch, updated_at: new Date().toISOString() });
    },
    async activeSessionsForUser(userId) {
      return sessions.find((s) => s.user_id === userId && s.status === 'playing');
    },
    async listByUser(userId, { limit = 20 } = {}) {
      return sessions.find((s) => s.user_id === userId, { sort: (a, b) => b.__seq - a.__seq, limit });
    },
    /** Reap sessions whose last heartbeat is older than the cutoff. */
    async expireStale(cutoffISO) {
      return sessions.updateWhere(
        (s) => s.status === 'playing' && s.last_heartbeat_at < cutoffISO,
        { status: 'expired', ended_at: new Date().toISOString() }
      );
    }
  };
}
