import { postgres } from '@streaming/shared';
const { query } = postgres;

/**
 * Postgres implementation of the user repository (DATA_DRIVER=postgres).
 * Same interface as the memory repo — the service code never knows which is in use.
 */
export function createPgUserRepo() {
  return {
    async create(user) {
      const { rows } = await query(
        `INSERT INTO users.accounts (id, email, password_hash, display_name, country, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         RETURNING id, email, display_name, country, created_at, updated_at`,
        [user.id, user.email, user.password_hash, user.display_name, user.country, user.created_at]
      );
      return rows[0];
    },

    async findByEmail(email) {
      const { rows } = await query(`SELECT * FROM users.accounts WHERE email = $1`, [email]);
      return rows[0] || null;
    },

    async findById(id) {
      const { rows } = await query(
        `SELECT id, email, display_name, country, created_at, updated_at
         FROM users.accounts WHERE id = $1`,
        [id]
      );
      return rows[0] || null;
    },

    async updateProfile(id, patch) {
      const { rows } = await query(
        `UPDATE users.accounts
            SET display_name = COALESCE($2, display_name),
                country      = COALESCE($3, country),
                updated_at   = NOW()
          WHERE id = $1
      RETURNING id, email, display_name, country, created_at, updated_at`,
        [id, patch.display_name ?? null, patch.country ?? null]
      );
      return rows[0] || null;
    },

    async list({ limit = 50 } = {}) {
      const { rows } = await query(
        `SELECT id, email, display_name, country, created_at FROM users.accounts
         ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
      return rows;
    }
  };
}
