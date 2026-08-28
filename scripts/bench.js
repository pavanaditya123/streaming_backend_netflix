/**
 * Latency benchmark: cache-bypassed vs cache-served.
 *
 *   npm run dev                                  # terminal 1
 *   npm run bench                                # terminal 2
 *   node scripts/bench.js --requests=500 --concurrency=50
 *
 * The interesting comparison is not a single request — it is what happens under
 * concurrency. The uncached home endpoint fans out to four services, each of
 * which queries its own database, so its cost scales with load. The cached path
 * is one lookup, so it stays flat.
 *
 * Everything printed here is measured on YOUR machine against YOUR data. Numbers
 * grow with catalog size, row counts, and real network hops between containers.
 */
const BASE = process.env.GATEWAY_URL || 'http://localhost:3000';
const API = `${BASE}/api/v1`;

const argOf = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? Number(found.split('=')[1]) : fallback;
};

const REQUESTS = argOf('requests', 300);
const CONCURRENCY = argOf('concurrency', 25);


function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function summarise(name, samples, wallMs) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    name,
    n: samples.length,
    mean: +mean.toFixed(1),
    p50: +percentile(sorted, 50).toFixed(1),
    p95: +percentile(sorted, 95).toFixed(1),
    p99: +percentile(sorted, 99).toFixed(1),
    max: +sorted[sorted.length - 1].toFixed(1),
    rps: Math.round((samples.length / wallMs) * 1000)
  };
}

/** Run `total` requests with at most `concurrency` in flight. */
async function load(fn, total, concurrency) {
  const samples = [];
  let issued = 0;
  const startedAll = process.hrtime.bigint();

  const worker = async () => {
    while (issued < total) {
      issued += 1;
      const t0 = process.hrtime.bigint();
      try {
        await fn();
      } catch {
        /* a failed request still costs time; record it */
      }
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = Number(process.hrtime.bigint() - startedAll) / 1e6;
  return { samples, wallMs };
}

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return res.json();
}

function table(rows) {
  const cols = ['name', 'n', 'mean', 'p50', 'p95', 'p99', 'max', 'rps'];
  const header = ['scenario'.padEnd(34), ...cols.slice(1).map((c) => c.padStart(8))].join(' ');
  console.log(`\n${header}`);
  console.log('-'.repeat(header.length));
  for (const r of rows) {
    console.log([r.name.padEnd(34), ...cols.slice(1).map((c) => String(r[c]).padStart(8))].join(' '));
  }
}

async function main() {
  console.log(`\nBenchmarking ${BASE}`);
  console.log(`${REQUESTS} requests per scenario, concurrency ${CONCURRENCY}\n`);

  // ---- set up a user with a subscription and some watch history -------------
  const email = `bench_${Date.now()}@demo.com`;
  const reg = await api('/auth/register', {
    method: 'POST',
    body: { email, password: 'secret123', displayName: 'Bench User' }
  });
  const token = reg.token;

  await api('/subscriptions', {
    method: 'POST', token,
    body: { planId: 'premium', paymentMethod: { cardNumber: '4111111111111111' } }
  });
  await new Promise((r) => setTimeout(r, 800));

  // Give the user history so the personalised rails have real work to do.
  for (const titleId of ['tt_interstellar', 'tt_breaking_bad', 'tt_rrr', 'tt_parasite']) {
    const play = await api('/playback/sessions', { method: 'POST', token, body: { titleId } });
    if (play?.session?.id) {
      await api(`/playback/sessions/${play.session.id}/stop`, {
        method: 'POST', token, body: { positionSeconds: 1500 }
      });
    }
  }
  await new Promise((r) => setTimeout(r, 800));
  console.log('Warm-up complete: user has a premium plan and 4 history entries.\n');

  const results = [];

  // ---- GET /home ------------------------------------------------------------
  // Cache bypassed: every request fans out to 4 services and hits their DBs.
  {
    const { samples, wallMs } = await load(() => api('/home?fresh=1', { token }), REQUESTS, CONCURRENCY);
    results.push(summarise('GET /home  (cache bypassed)', samples, wallMs));
  }
  // Cache served: one lookup, no fan-out.
  {
    await api('/home', { token }); // populate
    const { samples, wallMs } = await load(() => api('/home', { token }), REQUESTS, CONCURRENCY);
    results.push(summarise('GET /home  (Redis cache-aside)', samples, wallMs));
  }

  // ---- catalog search -------------------------------------------------------
  {
    let i = 0;
    const { samples, wallMs } = await load(
      () => api(`/titles?genre=drama&sort=rating&limit=20&nocache=${i++}`, { token }),
      REQUESTS, CONCURRENCY
    );
    results.push(summarise('GET /titles  (unique key, miss)', samples, wallMs));
  }
  {
    await api('/titles?genre=drama&sort=rating&limit=20', { token });
    const { samples, wallMs } = await load(
      () => api('/titles?genre=drama&sort=rating&limit=20', { token }),
      REQUESTS, CONCURRENCY
    );
    results.push(summarise('GET /titles  (cached)', samples, wallMs));
  }

  // ---- natural-language search ---------------------------------------------
  {
    const queries = ['korean thriller series', 'something funny', 'movies with Tom Hanks', '90s action movies'];
    let i = 0;
    const { samples, wallMs } = await load(
      () => api('/recommendations/search', {
        method: 'POST', token, body: { query: queries[i++ % queries.length], limit: 12 }
      }),
      REQUESTS, CONCURRENCY
    );
    results.push(summarise('POST /recommendations/search', samples, wallMs));
  }

  table(results);

  const uncached = results[0];
  const cached = results[1];
  const speedup = uncached.p95 / Math.max(cached.p95, 0.01);

  console.log(`\nHome endpoint, p95: ${uncached.p95} ms uncached -> ${cached.p95} ms cached ` +
              `(${speedup.toFixed(1)}x faster)`);
  console.log(`Throughput:          ${uncached.rps} rps -> ${cached.rps} rps`);
  console.log(`Search p95:          ${results[4].p95} ms (budget: under 2000 ms)\n`);
  console.log('Note: these are measurements from THIS run. With Postgres, a larger');
  console.log('catalog and real network hops between containers, the uncached column');
  console.log('grows substantially while the cached column stays roughly flat.\n');
}

main().catch((err) => {
  console.error('Benchmark failed:', err.message);
  process.exit(1);
});
