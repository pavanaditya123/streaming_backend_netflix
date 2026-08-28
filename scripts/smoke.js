/**
 * End-to-end walkthrough of the whole platform against a running stack.
 *
 *   npm run dev      # terminal 1
 *   npm run smoke    # terminal 2
 *
 * This is the demo script: it exercises the saga (both outcomes), the event
 * pipeline, the entitlement rules, caching and natural-language search, and
 * prints what happened at every step. It exits non-zero if anything is wrong,
 * so CI runs it as a real end-to-end test.
 */
const BASE = process.env.GATEWAY_URL || 'http://localhost:3000';
const API = `${BASE}/api/v1`;

let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const c = {
  head: (s) => console.log(`\n\x1b[1m\x1b[36m${s}\x1b[0m`),
  ok: (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`),
  bad: (s) => { console.log(`  \x1b[31m✗ ${s}\x1b[0m`); failures += 1; },
  info: (s) => console.log(`    \x1b[90m${s}\x1b[0m`)
};

function check(condition, message, detail) {
  if (condition) c.ok(message);
  else c.bad(`${message}${detail ? ` — ${detail}` : ''}`);
  return condition;
}

async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const unique = () => `smoke_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

async function main() {
  c.head('0. Platform health');
  const health = await fetch(`${BASE}/ops/services`).then((r) => r.json());
  check(health.status === 'ok', 'all services report ready', JSON.stringify(health.services));
  c.info(Object.keys(health.services).join(', '));

  // ---------------------------------------------------------------------------
  c.head('1. Registration issues a JWT');
  const email = `${unique()}@demo.com`;
  const reg = await api('/auth/register', {
    method: 'POST',
    body: { email, password: 'secret123', displayName: 'Smoke Tester', country: 'IN' }
  });
  check(reg.status === 201, 'POST /auth/register -> 201', `got ${reg.status}`);
  const token = reg.body?.token;
  const userId = reg.body?.user?.id;
  check(Boolean(token), 'a JWT was returned');
  c.info(`user ${userId}`);

  c.head('2. Duplicate email is rejected');
  const dup = await api('/auth/register', {
    method: 'POST',
    body: { email, password: 'secret123', displayName: 'Impostor' }
  });
  check(dup.status === 409, 'duplicate registration -> 409 CONFLICT', `got ${dup.status}`);

  // ---------------------------------------------------------------------------
  c.head('3. Playback is blocked without a subscription');
  const blocked = await api('/playback/sessions', {
    method: 'POST', token, body: { titleId: 'tt_interstellar' }
  });
  check(blocked.status === 403, 'playback -> 403 FORBIDDEN', `got ${blocked.status}`);
  check(
    blocked.body?.error?.details?.reason === 'no_active_subscription',
    'reason is no_active_subscription'
  );

  // ---------------------------------------------------------------------------
  c.head('4. Subscribe — the saga runs to COMPLETED');
  const sub = await api('/subscriptions', {
    method: 'POST', token,
    headers: { 'idempotency-key': unique() },
    body: { planId: 'premium', paymentMethod: { cardNumber: '4111111111111111' } }
  });
  check(sub.status === 202, 'POST /subscriptions -> 202 Accepted (async saga)', `got ${sub.status}`);
  check(sub.body?.state === 'AWAITING_PAYMENT', 'saga starts in AWAITING_PAYMENT');
  c.info(`saga ${sub.body?.sagaId}`);

  await sleep(700);
  const subs = await api('/subscriptions', { token });
  const active = subs.body?.items?.find((s) => s.status === 'active');
  check(Boolean(active), 'subscription reached status=active');
  c.info(`plan ${active?.planId} · ${active?.price} · payment ${active?.paymentId}`);

  const detail = await api(`/subscriptions/${sub.body.subscriptionId}`, { token });
  const states = (detail.body?.saga?.history || []).map((h) => h.to);
  check(states.includes('COMPLETED'), 'saga history ends at COMPLETED');
  c.info(`path: STARTED -> ${states.join(' -> ')}`);

  // ---------------------------------------------------------------------------
  c.head('5. Entitlement is cached in Redis');
  const e1 = await api('/subscriptions/entitlement', { token });
  const e2 = await api('/subscriptions/entitlement', { token });
  check(e1.body?.entitled === true, 'user is entitled');
  check(e2.body?.cached === true, 'second read served from cache');

  // ---------------------------------------------------------------------------
  c.head('6. Playback now works');
  const play = await api('/playback/sessions', {
    method: 'POST', token, body: { titleId: 'tt_interstellar' }
  });
  check(play.status === 201, 'playback session created', `got ${play.status}`);
  check(play.body?.session?.quality === '4K', 'premium plan streams in 4K');
  const sessionId = play.body?.session?.id;
  c.info(play.body?.manifestUrl);

  c.head('7. A premium-only title is blocked on a lower plan');
  const basicEmail = `${unique()}@demo.com`;
  const basicReg = await api('/auth/register', {
    method: 'POST', body: { email: basicEmail, password: 'secret123', displayName: 'Basic User' }
  });
  const basicToken = basicReg.body.token;
  await api('/subscriptions', {
    method: 'POST', token: basicToken,
    body: { planId: 'basic', paymentMethod: { cardNumber: '4111111111111111' } }
  });
  await sleep(600);
  const gated = await api('/playback/sessions', {
    method: 'POST', token: basicToken, body: { titleId: 'tt_breaking_bad' }
  });
  check(gated.status === 403, 'basic plan blocked from a premium title', `got ${gated.status}`);
  check(gated.body?.error?.details?.reason === 'title_not_in_plan', 'reason is title_not_in_plan');
  c.info(`upgrade suggestion: ${gated.body?.error?.details?.upgradeTo}`);

  c.head('8. Concurrent-stream limit is enforced');
  const second = await api('/playback/sessions', {
    method: 'POST', token: basicToken, body: { titleId: 'tt_3_idiots' }
  });
  const third = await api('/playback/sessions', {
    method: 'POST', token: basicToken, body: { titleId: 'tt_dangal' }
  });
  check(second.status === 201, 'basic plan allows its first stream');
  check(third.status === 403, 'a second concurrent stream is blocked on basic', `got ${third.status}`);
  check(third.body?.error?.details?.reason === 'max_concurrent_streams_reached', 'reason is stream limit');

  // ---------------------------------------------------------------------------
  c.head('9. Watch history is built from playback events (async)');
  await api(`/playback/sessions/${sessionId}/progress`, {
    method: 'POST', token, body: { positionSeconds: 3000 }
  });
  await api(`/playback/sessions/${sessionId}/stop`, {
    method: 'POST', token, body: { positionSeconds: 4500 }
  });
  await sleep(700);

  const history = await api('/watch-history/continue', { token });
  const entry = history.body?.items?.find((i) => i.titleId === 'tt_interstellar');
  check(Boolean(entry), 'continue-watching row appeared without any direct write');
  c.info(`resume at ${entry?.positionSeconds}s (${entry?.progressPercent}% of Interstellar)`);

  // ---------------------------------------------------------------------------
  c.head('10. Notifications arrive from events');
  const notes = await api('/notifications', { token });
  const kinds = (notes.body?.items || []).map((n) => n.sourceEventType);
  check(kinds.includes('user.registered'), 'welcome notification from user.registered');
  check(kinds.includes('subscription.activated'), 'billing notification from subscription.activated');
  c.info(kinds.join(', '));

  // ---------------------------------------------------------------------------
  c.head('11. Saga COMPENSATION — a declined card fails cleanly');
  const failEmail = `${unique()}@demo.com`;
  const failReg = await api('/auth/register', {
    method: 'POST', body: { email: failEmail, password: 'secret123', displayName: 'Declined Card' }
  });
  const failToken = failReg.body.token;
  const failSub = await api('/subscriptions', {
    method: 'POST', token: failToken,
    // A card ending in 0000 is always declined by the simulated gateway.
    body: { planId: 'premium', paymentMethod: { cardNumber: '4000000000000000' } }
  });
  await sleep(700);
  const failDetail = await api(`/subscriptions/${failSub.body.subscriptionId}`, { token: failToken });
  check(failDetail.body?.subscription?.status === 'failed', 'subscription ended as failed');
  check(failDetail.body?.subscription?.failureReason === 'card_declined', 'failure reason recorded');
  check(failDetail.body?.saga?.state === 'FAILED', 'saga reached FAILED (no money moved)');
  const failEnt = await api('/subscriptions/entitlement', { token: failToken });
  check(failEnt.body?.entitled === false, 'user was NOT entitled after a failed payment');
  c.info(`path: ${(failDetail.body?.saga?.history || []).map((h) => h.to).join(' -> ')}`);

  // ---------------------------------------------------------------------------
  c.head('12. Idempotency — retrying a subscribe does not charge twice');
  const idemEmail = `${unique()}@demo.com`;
  const idemReg = await api('/auth/register', {
    method: 'POST', body: { email: idemEmail, password: 'secret123', displayName: 'Idem User' }
  });
  const idemToken = idemReg.body.token;
  const key = unique();
  const first = await api('/subscriptions', {
    method: 'POST', token: idemToken, headers: { 'idempotency-key': key },
    body: { planId: 'standard', paymentMethod: { cardNumber: '4111111111111111' } }
  });
  const retry = await api('/subscriptions', {
    method: 'POST', token: idemToken, headers: { 'idempotency-key': key },
    body: { planId: 'standard', paymentMethod: { cardNumber: '4111111111111111' } }
  });
  check(retry.body?.idempotentReplay === true, 'retry replayed the original result');
  check(first.body?.sagaId === retry.body?.sagaId, 'no second saga was started');
  await sleep(600);
  const payments = await api('/billing/payments', { token: idemToken });
  check((payments.body?.items || []).length === 1, 'exactly one payment exists',
    `found ${(payments.body?.items || []).length}`);

  // ---------------------------------------------------------------------------
  c.head('13. Natural-language search');
  const queries = [
    ['korean thriller series', 'by_genre_and_language'],
    ['something funny to cheer me up', 'by_mood'],
    ['movies with Tom Hanks', 'by_actor'],
    ['what was I watching', 'continue_watching'],
    ['90s movies rated above 8', 'by_rating_threshold'],
    ['kids movies', 'family_friendly'],
    ['surprise me', 'random_pick']
  ];
  for (const [query, expected] of queries) {
    const r = await api('/recommendations/search', { method: 'POST', token, body: { query, limit: 3 } });
    const got = r.body?.intent;
    check(got === expected, `"${query}" -> ${expected}`, `got ${got}`);
    check(r.body?.tookMs < 2000, `  responded in ${r.body?.tookMs}ms (budget 2000ms)`);
    c.info(`${r.body?.explanation} :: ${(r.body?.items || []).map((t) => t.title).join(', ')}`);
  }

  const intents = await api('/recommendations/intents', { token });
  check(intents.body?.count >= 20, `${intents.body?.count} search intents supported (target 20+)`);

  // ---------------------------------------------------------------------------
  c.head('14. Home screen composes 4 services and caches the result');
  // `?fresh=1` bypasses the cache entirely and does NOT populate it, so the
  // first normal call is still a miss and the second is the real cache hit.
  const cold = await api('/home?fresh=1', { token });
  const fill = await api('/home', { token });
  const warm = await api('/home', { token });
  check(cold.status === 200, 'home rendered');
  check(fill.body?.cached === false, 'first normal load is a cache miss');
  check(warm.body?.cached === true, 'second load served from cache');
  c.info(`rails: ${(cold.body?.rails || []).map((r) => r.title).join(' | ')}`);
  c.info(`uncached ${cold.body?.tookMs}ms -> cached ${warm.body?.tookMs}ms`);

  // ---------------------------------------------------------------------------
  c.head('15. Cancelling revokes entitlement immediately');
  const cancel = await api(`/subscriptions/${active.id}/cancel`, { method: 'POST', token });
  check(cancel.status === 200, 'cancel accepted', `got ${cancel.status}`);
  const afterCancel = await api('/subscriptions/entitlement', { token });
  check(afterCancel.body?.entitled === false, 'entitlement cache was invalidated, not stale');

  // ---------------------------------------------------------------------------
  console.log('');
  if (failures) {
    console.log(`\x1b[31m\x1b[1m${failures} check(s) failed.\x1b[0m\n`);
    process.exit(1);
  }
  console.log('\x1b[32m\x1b[1mAll checks passed.\x1b[0m\n');
}

main().catch((err) => {
  console.error('\n\x1b[31mSmoke run crashed:\x1b[0m', err.message);
  console.error(err.stack);
  process.exit(1);
});
