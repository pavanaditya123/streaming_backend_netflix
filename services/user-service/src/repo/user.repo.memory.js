import { getMemoryDb } from '@streaming/shared';

/** In-memory implementation of the user repository (DATA_DRIVER=memory). */
export function createMemoryUserRepo(db = getMemoryDb()) {
  const users = db.table('users', { primaryKey: 'id' });

  return {
    async create(user) {
      if (users.findOne((u) => u.email === user.email)) {
        throw Object.assign(new Error('email already registered'), { code: '23505' });
      }
      return users.insert(user);
    },
    async findByEmail(email) {
      return users.findOne((u) => u.email === email);
    },
    async findById(id) {
      return users.findByPk(id);
    },
    async updateProfile(id, patch) {
      return users.update(id, { ...patch, updated_at: new Date().toISOString() });
    },
    async list({ limit = 50 } = {}) {
      return users.find(() => true, { limit });
    }
  };
}
