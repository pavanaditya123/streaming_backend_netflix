# Caching

## The problem

`GET /api/v1/home` needs: the user's entitlement, their continue-watching list,
personalised rails, trending titles, and an unread notification count. That is
data from four services, each querying its own database.

Done naively — four sequential calls, no caching — the cost is the **sum** of
four round trips plus four sets of database work, on every single page load, for
every user, forever.

## Two fixes, in order

### 1. Fan out in parallel

The four calls do not depend on each other, so the cost should be the slowest
one, not the sum:

```js
const [entitlement, trending, forYou, unread] = await Promise.all([
  clients.subscription.get('/subscriptions/entitlement', ctx).catch(degrade('entitlement')),
  clients.catalog.get('/titles/trending?limit=12', ctx).catch(degrade('trending')),
  clients.recommendation.get('/recommendations/for-you?limit=12', ctx).catch(degrade('for-you')),
  clients.notification.get('/notifications/unread-count', ctx).catch(degrade('notifications'))
]);
```

Each has its own `.catch` that degrades to `null`. **One slow service must not
blank the home screen** — the page renders with whatever arrived.

### 2. Cache the composed result

The whole assembled payload is cached under one key, so a warm request is a
single Redis lookup and no fan-out at all.

## Measured effect

`npm run bench` — 300 requests, concurrency 25, in-memory drivers, 61 titles:

| Scenario | mean | p50 | p95 | p99 | throughput |
|---|---|---|---|---|---|
| `GET /home` cache bypassed | 45 ms | 37 ms | 68 ms | 193 ms | 534 rps |
| `GET /home` cache served | 8 ms | 8 ms | 12 ms | 14 ms | 2951 rps |
| `POST /recommendations/search` | 9 ms | 9 ms | 12 ms | 12 ms | 2741 rps |

**5.6× at p95, 5.5× the throughput.** Note the p99 in particular: uncached, it
blows out to 193 ms under concurrency because every request is doing real work;
cached, it stays at 14 ms. That gap widens as load and data grow — the uncached
column scales with both, the cached column barely moves.

These are numbers from an actual run on in-memory drivers. Run it yourself:

```bash
npm run dev
npm run bench --requests=500 --concurrency=50
```

To measure something closer to production, run against `docker compose up` with
a seeded catalog (`node scripts/seed.js --titles=5000`), where each service does
real Postgres work over a real network hop.

## Every cache key

| Key | TTL | Invalidated by |
|---|---|---|
| `home:{userId}` | 30 s | TTL only — it is a composition of already-invalidated parts |
| `entitlement:user:{userId}` | 300 s | subscription activated / cancelled |
| `catalog:title:{id}` | 300 s | `playback.session.started` (view count changed) |
| `catalog:trending:v1:{limit}` | 60 s | `playback.session.started` |
| `catalog:list:{hash}` | 300 s | TTL only |
| `catalog:similar:{id}:{limit}` | 300 s | TTL only |
| `catalog:facets` | 300 s | TTL only |
| `wh:continue:{userId}` | 60 s | any playback event for that user |
| `wh:list:{userId}:{page}` | 60 s | any playback event for that user |
| `reco:{userId|all}:{hash}` | 120 s | TTL only |
| `ratelimit:{id}:{bucket}` | window | expires with the window |

Keys are built by [`cacheKeys`](../packages/shared/src/cache/index.js) rather
than string-concatenated at call sites, so every key format is in one auditable
place.

## Event-driven invalidation

TTL alone is not good enough for anything correctness-sensitive. Two cases where
staleness would be a real bug:

**Cancelling a subscription.** With a 300 s entitlement TTL, a cancelled user
could keep starting streams for five minutes. So cancellation drops the key
immediately:

```js
await cache.del(cacheKeys.entitlement(sub.user_id));
```

There is a test that asserts exactly this
(`"cancelling clears the cached entitlement"`), because it is the kind of thing
that silently regresses.

**Watch history.** Stopping playback must move your continue-watching row. The
consumer invalidates on every playback event:

```js
await cache.del(cacheKeys.continueWatching(userId));
await cache.delByPattern(`wh:list:${userId}:`);
```

`delByPattern` uses `SCAN`, never `KEYS` — `KEYS` blocks the whole Redis event
loop on a large keyspace, which is a classic way to take down production.

## Stampede protection

A popular key expiring under load means every concurrent request misses at once
and they all hit the origin together. `withCache` collapses them into one call:

```js
if (inFlight.has(key)) return { value: await inFlight.get(key), coalesced: true };
```

The test fires 20 concurrent requests at one cold key and asserts the origin was
called **once**.

## Choosing a TTL

The rule used here: **how stale can this be before a user notices or it becomes
wrong?**

- `trending` — 60 s. It is a popularity ranking; nobody can tell it is a minute old.
- `entitlement` — 300 s, *but* explicitly invalidated. Long TTL is fine precisely
  because correctness does not depend on it expiring.
- `home` — 30 s. Short, because it is the most visible surface, and it is cheap
  to rebuild from already-cached parts.
- `title` — 300 s. Metadata changes rarely, and the view count is invalidated on
  write anyway.

## What is deliberately not cached

- Anything in the write path (playback session creation, subscribe).
- Payment history — low traffic, and a stale answer about money is worse than a
  slow one.
- Saga state — always read fresh; caching a state machine's state defeats the
  purpose.

## Metrics

`withCache` records hits and misses under a **low-cardinality key family**
(`catalog:title`, not `catalog:title:tt_inception`) — otherwise every title id
becomes its own metric series and the metrics backend falls over.

```bash
curl localhost:3002/metrics | grep cache_
```
