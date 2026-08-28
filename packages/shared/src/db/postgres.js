import pg from 'pg';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('postgres');

let pool = null;

/**
 * Override the pool. Used by the integration tests to point the very same
 * repository code at an embedded Postgres instead of a server, so the SQL is
 * exercised for real without requiring a running database.
 */
export function setPool(instance) {
  pool = instance;
  return pool;
}

export function getPool() {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: config.postgres.url,
    max: config.postgres.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: config.postgres.statementTimeoutMs
  });
  pool.on('error', (err) => log.error({ err: err.message }, 'idle pg client error'));
  return pool;
}

export async function query(text, params = []) {
  const started = Date.now();
  const result = await getPool().query(text, params);
  const ms = Date.now() - started;
  if (ms > 500) log.warn({ ms, sql: text.slice(0, 120) }, 'slow query');
  return result;
}

/**
 * Run a function inside a transaction. Used by the saga and by any place that
 * writes state and an outbox row together.
 */
export async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn({
      query: (text, params = []) => client.query(text, params)
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function healthy() {
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closePool() {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
}
