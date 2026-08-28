/**
 * Test harness for the Postgres repositories.
 *
 * The SAME repository code is exercised either way:
 *   - locally: against PGlite, a real Postgres build compiled to WebAssembly,
 *     so the SQL is genuinely parsed and planned with no database to install
 *   - in CI:   against a real postgres:16 service container
 *
 * If REQUIRE_REAL_POSTGRES=1 the harness refuses to fall back, so CI can never
 * silently pass without touching a real server.
 */
import { readdir, readFile } from 'node:fs/promises';
import { setPool } from '@streaming/shared/src/db/postgres.js';

const MIGRATIONS_DIR = new URL('../../db/migrations/', import.meta.url);

async function migrationFiles() {
  const dir = new URL('./', MIGRATIONS_DIR);
  const names = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(new URL(name, MIGRATIONS_DIR), 'utf8') }))
  );
}

/**
 * Wrap a driver so it looks exactly like a `pg.Pool` to the repositories.
 *
 * node-postgres sends a parameterless query over the SIMPLE query protocol,
 * which happily accepts several statements at once — that is what lets
 * scripts/migrate.js hand a whole .sql file to `client.query()`. PGlite always
 * uses the extended protocol, so the shim routes multi-statement, parameterless
 * SQL through `exec()` to reproduce the same behaviour.
 */
function asPool(exec, queryFn) {
  const run = async (text, params = []) => {
    if (params.length === 0 && isMultiStatement(text)) {
      const results = await exec(text);
      const last = Array.isArray(results) ? results[results.length - 1] : results;
      return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? 0, fields: last?.fields ?? [] };
    }
    return queryFn(text, params);
  };

  return {
    query: run,
    connect: async () => ({ query: run, release: () => {} }),
    end: async () => {},
    on: () => {}
  };
}

/** True when the SQL contains more than one statement (ignoring trailing ';'). */
function isMultiStatement(sql) {
  const stripped = sql
    .replace(/--[^\n]*/g, '')      // line comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/\$\$[\s\S]*?\$\$/g, '') // dollar-quoted function bodies
    .trim()
    .replace(/;\s*$/, '');
  return stripped.includes(';');
}

async function tryRealPostgres() {
  if (!process.env.DATABASE_URL) return null;
  try {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 3000 });
    await pool.query('SELECT 1');
    return {
      kind: 'postgres-server',
      pool,
      exec: async (sql) => { await pool.query(sql); },
      close: async () => pool.end()
    };
  } catch {
    return null;
  }
}

async function embeddedPostgres() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  const pool = asPool((sql) => db.exec(sql), (text, params) => db.query(text, params));
  return {
    kind: 'pglite-embedded',
    pool,
    exec: (sql) => db.exec(sql),
    close: async () => db.close()
  };
}

/** Boot a database, apply every migration, and install it as the global pool. */
export async function setupDatabase() {
  const real = await tryRealPostgres();

  if (!real && process.env.REQUIRE_REAL_POSTGRES === '1') {
    throw new Error('REQUIRE_REAL_POSTGRES=1 but DATABASE_URL is not reachable');
  }

  const db = real || (await embeddedPostgres());
  setPool(db.pool);

  for (const { sql } of await migrationFiles()) {
    await db.exec(sql);
  }

  return db;
}

/** Empty every table between tests without re-running the migrations. */
export async function truncateAll(db) {
  await db.exec(`
    TRUNCATE
      users.accounts,
      catalog.titles,
      playback.sessions,
      watch_history.entries, watch_history.processed_events,
      subscriptions.subscriptions, subscriptions.saga_instances,
      subscriptions.processed_events, subscriptions.idempotency_keys,
      billing.payments, billing.processed_events,
      notifications.notifications, notifications.processed_events
    RESTART IDENTITY CASCADE
  `);
}
