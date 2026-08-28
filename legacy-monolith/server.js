/**
 * THE "BEFORE" — the original monolith, kept deliberately.
 *
 * This is roughly where the project started: one Express process, one database
 * connection, every concern in one file. It works. For a small service it is
 * genuinely the right answer, and nothing here is a strawman.
 *
 * Run it:  node legacy-monolith/server.js   (listens on :3900)
 *
 * It is kept in the repo because the interesting part of this project is not
 * "microservices are good" — it is being able to point at the exact lines that
 * became a scaling problem, and show what each one turned into.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT HURT, AND WHAT IT BECAME
 * ---------------------------------------------------------------------------
 *
 * 1. ONE PROCESS, ONE SCALING UNIT.            [see: the split into 8 services]
 *    Playback is the hot path — thousands of requests a second. The billing
 *    code runs a few times a minute. In here they share a process, so scaling
 *    playback means running more copies of billing too, and a slow billing call
 *    occupies an event loop that playback needed.
 *
 * 2. SYNCHRONOUS FAN-OUT ON THE HOT PATH.      [see: TOPICS.PLAYBACK_EVENTS]
 *    Look at startPlayback() below: before the user gets a stream URL it writes
 *    watch history, bumps a popularity counter, and maybe sends a notification.
 *    None of that is needed to answer the request, but all of it is in the
 *    critical path, and any of it failing fails the whole request.
 *    -> Now: playback publishes one event and returns. watch-history, catalog
 *       and notifications each react on their own.
 *
 * 3. NO TRANSACTION BOUNDARY AROUND PAYMENT.   [see: SubscribeSagaOrchestrator]
 *    subscribe() charges a card and then writes a subscription row. If the
 *    process dies between those two lines the customer is charged and has
 *    nothing. A database transaction cannot help — the charge is a call to
 *    someone else's system.
 *    -> Now: a saga with an explicit compensating refund.
 *
 * 4. EVERY READ HITS THE DATABASE.             [see: withCache + Redis]
 *    getHome() runs four queries on every single page load, including for
 *    users who reload constantly.
 *    -> Now: cache-aside on the composed payload, invalidated by events.
 *
 * 5. ONE SCHEMA, SO EVERYTHING COUPLES TO EVERYTHING.
 *    Any handler can join any table, so over time every table becomes load
 *    bearing for every feature and nothing can be changed safely.
 *    -> Now: a schema per service and no cross-service joins.
 * ---------------------------------------------------------------------------
 */

import express from 'express';

const app = express();
app.use(express.json());

// A single in-memory "database" standing in for one shared Postgres schema.
const db = {
  users: new Map(),
  titles: new Map(),
  subscriptions: new Map(),
  watchHistory: new Map(),
  notifications: [],
  sessions: new Map()
};

// Seed a couple of titles so the endpoints do something.
for (const t of [
  { id: 'tt_1', title: 'Interstellar', plans: ['premium'], durationMinutes: 169, viewCount: 0, rating: 8.6 },
  { id: 'tt_2', title: '3 Idiots', plans: ['basic', 'standard', 'premium'], durationMinutes: 170, viewCount: 0, rating: 8.4 }
]) db.titles.set(t.id, t);

const PLANS = {
  basic: { price: 14900, maxStreams: 1, quality: '480p' },
  standard: { price: 49900, maxStreams: 2, quality: '1080p' },
  premium: { price: 64900, maxStreams: 4, quality: '4K' }
};

const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

// --- auth --------------------------------------------------------------------
app.post('/register', (req, res) => {
  const { email, password, displayName } = req.body;
  for (const u of db.users.values()) {
    if (u.email === email) return res.status(409).json({ error: 'email taken' });
  }
  const user = { id: uid('usr'), email, password, displayName };
  db.users.set(user.id, user);

  // PROBLEM 2: sending the welcome message is in the request path. If the mail
  // provider is slow, registration is slow.
  db.notifications.push({ userId: user.id, subject: 'Welcome', body: `Hi ${displayName}` });

  res.status(201).json({ user: { id: user.id, email, displayName } });
});

// --- subscribe ---------------------------------------------------------------
app.post('/subscribe', async (req, res) => {
  const { userId, planId } = req.body;
  const plan = PLANS[planId];
  if (!plan) return res.status(400).json({ error: 'unknown plan' });

  // PROBLEM 3: two systems, no shared transaction.
  //
  //   1. charge the card   <- an external system; cannot be rolled back
  //   2. save the row      <- if THIS fails, or the process dies here,
  //                           the customer has paid for nothing
  //
  // Wrapping these in BEGIN/COMMIT does not help: the money has already moved
  // by the time the transaction aborts. This is the exact problem the saga and
  // its compensating refund exist to solve.
  const charge = await fakeChargeCard(plan.price);
  if (!charge.ok) return res.status(402).json({ error: charge.reason });

  const subscription = { id: uid('sub'), userId, planId, status: 'active', paymentId: charge.paymentId };
  db.subscriptions.set(subscription.id, subscription);

  db.notifications.push({ userId, subject: `Your ${planId} plan is active`, body: '...' });
  res.status(201).json({ subscription });
});

// --- playback ----------------------------------------------------------------
app.post('/play', (req, res) => {
  const { userId, titleId } = req.body;

  const title = db.titles.get(titleId);
  if (!title) return res.status(404).json({ error: 'no such title' });

  // PROBLEM 4: an uncached entitlement scan on the hottest path in the product.
  const subscription = [...db.subscriptions.values()]
    .find((s) => s.userId === userId && s.status === 'active');
  if (!subscription) return res.status(403).json({ error: 'no subscription' });

  const plan = PLANS[subscription.planId];
  if (!title.plans.includes(subscription.planId)) {
    return res.status(403).json({ error: 'not in your plan' });
  }

  const active = [...db.sessions.values()].filter((s) => s.userId === userId && s.status === 'playing');
  if (active.length >= plan.maxStreams) return res.status(403).json({ error: 'too many streams' });

  const session = { id: uid('ses'), userId, titleId, status: 'playing', position: 0 };
  db.sessions.set(session.id, session);

  // PROBLEM 2, in one place: none of the next three lines is needed to answer
  // this request, but the user waits for all of them, and any one of them
  // throwing turns a successful play into a 500.
  title.viewCount += 1;                                              // -> catalog-service
  db.watchHistory.set(`${userId}:${titleId}`, {                      // -> watch-history-service
    userId, titleId, position: 0, playCount: 1, lastWatchedAt: new Date().toISOString()
  });
  db.notifications.push({ userId, subject: 'Enjoy your show', body: '...' }); // -> notification-service

  res.status(201).json({
    session,
    manifestUrl: `https://cdn.example.com/${titleId}/${plan.quality}/master.m3u8`
  });
});

// --- home --------------------------------------------------------------------
app.get('/home/:userId', (req, res) => {
  const { userId } = req.params;

  // PROBLEM 4: four full scans, on every load, for every user, forever.
  // Nothing here is cached and nothing here is indexed.
  const subscription = [...db.subscriptions.values()].find((s) => s.userId === userId && s.status === 'active');
  const history = [...db.watchHistory.values()].filter((h) => h.userId === userId);
  const trending = [...db.titles.values()].sort((a, b) => b.viewCount - a.viewCount).slice(0, 10);
  const unread = db.notifications.filter((n) => n.userId === userId).length;

  res.json({ subscription, continueWatching: history, trending, unread });
});

async function fakeChargeCard(amount) {
  await new Promise((r) => setTimeout(r, 50));
  if (amount > 100000) return { ok: false, reason: 'limit exceeded' };
  return { ok: true, paymentId: uid('pay') };
}

const PORT = process.env.PORT || 3900;
if (process.argv[1]?.endsWith('server.js')) {
  app.listen(PORT, () => {
    console.log(`legacy monolith listening on http://localhost:${PORT}`);
  });
}

export { app, db };
