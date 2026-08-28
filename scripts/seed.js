/**
 * Loads the catalog seed data into Postgres.
 *
 *   DATA_DRIVER=postgres DATABASE_URL=postgres://... node scripts/seed.js
 *
 * `--titles=N` pads the catalog with generated titles so the benchmark has a
 * realistic amount of data to work against.
 */
import { postgres, config } from '@streaming/shared';
import { createPgCatalogRepo } from '../services/catalog-service/src/repo/catalog.repo.pg.js';
import { TITLES } from '../db/seed/titles.js';

const { closePool } = postgres;

const arg = process.argv.find((a) => a.startsWith('--titles='));
const target = arg ? Number(arg.split('=')[1]) : TITLES.length;

/** Pad the real catalog with synthetic-but-plausible rows. */
function generate(base, count) {
  const out = [...base];
  let i = 0;
  while (out.length < count) {
    const seed = base[i % base.length];
    const n = out.length;
    out.push({
      ...seed,
      id: `tt_gen_${n}`,
      title: `${seed.title} ${Math.floor(n / base.length) + 2}`,
      year: 1990 + (n % 34),
      rating: Number((5 + ((n * 7) % 50) / 10).toFixed(1)),
      viewCount: (n * 37) % 5000
    });
    i += 1;
  }
  return out;
}

async function main() {
  if (config.drivers.data !== 'postgres') {
    console.error('Seeding only applies to DATA_DRIVER=postgres (memory mode seeds itself on boot).');
    process.exit(1);
  }

  const repo = createPgCatalogRepo();
  const rows = target > TITLES.length ? generate(TITLES, target) : TITLES;

  console.log(`Seeding ${rows.length} titles...`);
  const total = await repo.upsertMany(rows);
  console.log(`Catalog now holds ${total} titles.`);
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Seed failed:', err.message);
    await closePool();
    process.exit(1);
  });
