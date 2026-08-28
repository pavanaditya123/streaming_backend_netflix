import { getMemoryDb } from '@streaming/shared';

export function createMemoryHistoryRepo(db = getMemoryDb()) {
  const entries = db.table('watch_history', { primaryKey: 'id' });
  const processed = db.table('wh_processed_events', { primaryKey: 'id' });

  // One row per (user, title): watching a title again updates the same row.
  const keyOf = (userId, titleId) => `${userId}:${titleId}`;

  return {
    async upsertProgress({ userId, titleId, titleName, positionSeconds, durationSeconds, completed, watchedAt }) {
      const id = keyOf(userId, titleId);
      const existing = entries.findByPk(id);

      if (!existing) {
        return entries.insert({
          id,
          user_id: userId,
          title_id: titleId,
          title_name: titleName ?? null,
          position_seconds: positionSeconds,
          duration_seconds: durationSeconds ?? null,
          completed: Boolean(completed),
          play_count: 1,
          total_watched_seconds: positionSeconds,
          first_watched_at: watchedAt,
          last_watched_at: watchedAt
        });
      }

      return entries.update(id, {
        title_name: titleName ?? existing.title_name,
        position_seconds: positionSeconds,
        duration_seconds: durationSeconds ?? existing.duration_seconds,
        completed: Boolean(completed) || existing.completed,
        total_watched_seconds: Math.max(existing.total_watched_seconds, positionSeconds),
        last_watched_at: watchedAt
      });
    },

    async incrementPlayCount({ userId, titleId, titleName, durationSeconds, watchedAt }) {
      const id = keyOf(userId, titleId);
      const existing = entries.findByPk(id);
      if (!existing) {
        return entries.insert({
          id,
          user_id: userId,
          title_id: titleId,
          title_name: titleName ?? null,
          position_seconds: 0,
          duration_seconds: durationSeconds ?? null,
          completed: false,
          play_count: 1,
          total_watched_seconds: 0,
          first_watched_at: watchedAt,
          last_watched_at: watchedAt
        });
      }
      return entries.update(id, {
        play_count: existing.play_count + 1,
        last_watched_at: watchedAt,
        title_name: titleName ?? existing.title_name
      });
    },

    async listByUser(userId, { limit = 20, offset = 0 } = {}) {
      const all = entries.find((e) => e.user_id === userId);
      all.sort((a, b) => new Date(b.last_watched_at) - new Date(a.last_watched_at));
      return { items: all.slice(offset, offset + limit), total: all.length };
    },

    /** "Continue watching": started, not finished, and far enough in to matter. */
    async continueWatching(userId, { limit = 10 } = {}) {
      const all = entries.find(
        (e) => e.user_id === userId && !e.completed && e.position_seconds >= 30
      );
      all.sort((a, b) => new Date(b.last_watched_at) - new Date(a.last_watched_at));
      return all.slice(0, limit);
    },

    async findEntry(userId, titleId) {
      return entries.findByPk(keyOf(userId, titleId));
    },

    async stats(userId) {
      const all = entries.find((e) => e.user_id === userId);
      return {
        titlesWatched: all.length,
        completed: all.filter((e) => e.completed).length,
        inProgress: all.filter((e) => !e.completed && e.position_seconds >= 30).length,
        totalWatchedSeconds: all.reduce((sum, e) => sum + (e.total_watched_seconds || 0), 0)
      };
    },

    async deleteEntry(userId, titleId) {
      return entries.delete(keyOf(userId, titleId));
    },

    async markEventProcessed(eventId, consumer) {
      const id = `${consumer}:${eventId}`;
      if (processed.findByPk(id)) return false;
      processed.insert({ id, processed_at: new Date().toISOString() });
      return true;
    }
  };
}
