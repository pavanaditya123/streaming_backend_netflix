import { getMemoryDb } from '@streaming/shared';

export function createMemoryNotificationRepo(db = getMemoryDb()) {
  const notifications = db.table('notifications', { primaryKey: 'id' });
  const processed = db.table('notif_processed_events', { primaryKey: 'id' });

  return {
    async create(row) {
      return notifications.insert(row);
    },
    async listByUser(userId, { limit = 20, offset = 0, unreadOnly = false } = {}) {
      const all = notifications.find(
        (n) => n.user_id === userId && (!unreadOnly || !n.read_at),
        { sort: (a, b) => b.__seq - a.__seq }
      );
      return { items: all.slice(offset, offset + limit), total: all.length };
    },
    async markRead(id, userId) {
      const n = notifications.findByPk(id);
      if (!n || n.user_id !== userId) return null;
      return notifications.update(id, { read_at: new Date().toISOString() });
    },
    async markAllRead(userId) {
      return notifications.updateWhere(
        (n) => n.user_id === userId && !n.read_at,
        { read_at: new Date().toISOString() }
      ).length;
    },
    async unreadCount(userId) {
      return notifications.count((n) => n.user_id === userId && !n.read_at);
    },
    async markEventProcessed(eventId, consumer) {
      const id = `${consumer}:${eventId}`;
      if (processed.findByPk(id)) return false;
      processed.insert({ id, processed_at: new Date().toISOString() });
      return true;
    }
  };
}
