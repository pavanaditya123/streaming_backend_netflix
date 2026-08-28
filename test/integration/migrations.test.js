import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupDatabase } from './helpers.js';
import { query } from '@streaming/shared/src/db/postgres.js';

/**
 * The schema itself is a deliverable — these tests assert that the constraints
 * and indexes the design depends on actually exist in the database.
 */
let db;
before(async () => { db = await setupDatabase(); });
after(async () => { await db.close(); });

describe('schema', () => {
  test('every service owns its own schema', async () => {
    const { rows } = await query(`
      SELECT schema_name FROM information_schema.schemata
       WHERE schema_name IN ('users','catalog','playback','watch_history','subscriptions','billing','notifications')
    `);
    assert.equal(rows.length, 7, 'one schema per service enforces the data boundary');
  });

  test('a user can hold at most one ACTIVE subscription', async () => {
    const { rows } = await query(`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'subscriptions' AND indexname = 'one_active_subscription_per_user'
    `);
    assert.equal(rows.length, 1, 'the partial unique index must exist');
    assert.match(rows[0].indexdef, /UNIQUE/i);
    assert.match(rows[0].indexdef, /WHERE.*active/i, 'it must be PARTIAL, not a plain unique index');
  });

  test('payments are uniquely keyed by idempotency key', async () => {
    const { rows } = await query(`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'billing' AND indexname = 'payments_idempotency_key'
    `);
    assert.equal(rows.length, 1);
    assert.match(rows[0].indexdef, /UNIQUE/i, 'without this, a retry could charge twice');
  });

  test('catalog array columns are GIN-indexed', async () => {
    const { rows } = await query(`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'catalog' AND indexdef ILIKE '%USING gin%'
    `);
    const indexed = rows.map((r) => r.indexname);
    for (const expected of ['titles_genres_gin', 'titles_cast_gin', 'titles_search_gin']) {
      assert.ok(indexed.includes(expected), `${expected} is missing — genre filters would seq-scan`);
    }
  });

  test('hot lookups use partial indexes', async () => {
    const { rows } = await query(`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE indexdef ILIKE '%WHERE%'
         AND schemaname IN ('playback','watch_history','notifications')
    `);
    const names = rows.map((r) => r.indexname);
    assert.ok(names.includes('sessions_active_idx'), 'the concurrent-stream check needs a partial index');
    assert.ok(names.includes('entries_continue_idx'), 'continue-watching needs a partial index');
    assert.ok(names.includes('notifications_unread_idx'), 'the unread badge needs a partial index');
  });

  test('money is stored as an integer, never a float', async () => {
    const { rows } = await query(`
      SELECT table_schema, table_name, column_name, data_type
        FROM information_schema.columns
       WHERE column_name IN ('price_minor','amount_minor')
    `);
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      assert.equal(row.data_type, 'integer', `${row.table_name}.${row.column_name} must not be a float`);
    }
  });

  test('every consumer has a dedupe table for at-least-once delivery', async () => {
    const { rows } = await query(`
      SELECT table_schema FROM information_schema.tables WHERE table_name = 'processed_events'
    `);
    const schemas = rows.map((r) => r.table_schema).sort();
    assert.deepEqual(schemas, ['billing', 'notifications', 'subscriptions', 'watch_history']);
  });

  test('the catalog search vector is a generated column kept in sync by Postgres', async () => {
    await query(`
      INSERT INTO catalog.titles (id,title,type,year,genres,language,rating,maturity,director,cast_members,moods,awards,plans,description)
      VALUES ('gen_1','Test Film','movie',2020,'{drama}','en',7.5,'UA','Some Director','{Jane Actor}','{tense}','{}','{basic}','a story about submarines')
      ON CONFLICT (id) DO NOTHING
    `);
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM catalog.titles WHERE search_vector @@ plainto_tsquery('simple', $1)`,
      ['submarines']
    );
    assert.equal(rows[0].n, 1, 'the description must be searchable without any application-side indexing');

    const byCast = await query(
      `SELECT COUNT(*)::int AS n FROM catalog.titles WHERE search_vector @@ plainto_tsquery('simple', $1)`,
      ['Jane Actor']
    );
    assert.equal(byCast.rows[0].n, 1, 'array columns must be included in the search vector');
  });
});
