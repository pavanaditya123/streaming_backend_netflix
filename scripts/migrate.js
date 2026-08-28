/**
 * Applies db/migrations/*.sql in order, exactly once each.
 *
 *   DATABASE_URL=postgres://... node scripts/migrate.js
 *
 * A tiny hand-rolled migrator rather than a framework: it is 60 lines, has no
 * dependencies, and you can explain every line of it.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgres } from '@streaming/shared';

const { query, transaction, closePool } = postgres;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

async function main() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows } = await query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  = ${file} (already applied)`);
      continue;
    }

    const sql = await readFile(join(migrationsDir, file), 'utf8');

    // Each migration runs inside its own transaction: it applies fully or not
    // at all, and is recorded in the same transaction that applied it.
    await transaction(async (tx) => {
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });

    console.log(`  + ${file}`);
    count += 1;
  }

  console.log(count ? `\nApplied ${count} migration(s).` : '\nDatabase already up to date.');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Migration failed:', err.message);
    await closePool();
    process.exit(1);
  });
