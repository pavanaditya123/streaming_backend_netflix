# Streaming Platform Backend

A streaming service backend (think Netflix/Prime Video) built as **8 microservices
behind an API gateway**, using **Node.js, Kafka, Redis and PostgreSQL**.

It started as a monolith — [`legacy-monolith/`](legacy-monolith/) is still in the
repo, with comments pointing at the exact lines that forced each split.

```
                                  ┌──────────────┐
   client  ──── JWT ────────────► │ api-gateway  │  :3000   auth · rate limit · BFF
                                  └──────┬───────┘
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
            ┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
            │ user-service │     │   catalog    │     │    playback      │
            │    :3001     │     │    :3002     │     │      :3003       │
            └──────┬───────┘     └──────┬───────┘     └────────┬─────────┘
                   │                    │                      │
                   │            ┌───────┴──────────────────────┴───────┐
                   └───────────►│            KAFKA (events)            │◄──────┐
                                └───┬─────────────┬──────────────┬─────┘       │
                                    ▼             ▼              ▼             │
                          ┌──────────────┐ ┌────────────┐ ┌──────────────┐     │
                          │ watch-history│ │notification│ │ subscription │─────┘
                          │    :3004     │ │   :3007    │ │    :3005     │
                          └──────────────┘ └────────────┘ └──────┬───────┘
                                                                 │  SAGA
                                  ┌──────────────────┐           │
                                  │ recommendation   │    ┌──────▼───────┐
                                  │      :3008       │    │   billing    │
                                  └──────────────────┘    │    :3006     │
                                                          └──────────────┘
```

---

## Run it

**No Docker, no database, no Kafka needed:**

```bash
npm install
npm run dev        # all 9 services, in-memory adapters
npm run smoke      # in another terminal — full end-to-end walkthrough
```

**With real infrastructure:**

```bash
docker compose up --build     # Postgres + Redis + Kafka + 9 service containers
npm run smoke
```

The only difference between the two is three environment variables. See
[Drivers](#drivers-the-one-idea-that-makes-this-runnable) below.

---

## What each service owns

| Service | Port | Owns | Talks to |
|---|---|---|---|
| **api-gateway** | 3000 | The only public surface. Verifies the JWT once, rate limits, routes, composes the home screen. | everything |
| **user-service** | 3001 | Identity: registration, login, JWT issuance, profiles. | — |
| **catalog-service** | 3002 | Title metadata, search, trending. The read-heavy one. | consumes playback events |
| **playback-service** | 3003 | Can you stream this? Session tracking. The write-heavy hot path. | catalog, subscription |
| **watch-history-service** | 3004 | Continue-watching, progress, viewing stats. | consumes playback events only |
| **subscription-service** | 3005 | Plans, subscriptions, entitlement. **Orchestrates the Subscribe Saga.** | billing (via events) |
| **billing-service** | 3006 | Payments and refunds. **Saga participant.** | subscription (via events) |
| **notification-service** | 3007 | Email/push, generated from events. | consumes 3 topics |
| **recommendation-service** | 3008 | Natural-language search over 26 intents. | catalog, watch-history |

Each service owns its own **database schema** and no service reads another's
tables. In production these would be separate database instances; separate
schemas enforce the same boundary while keeping local development to one container.

---

## The three things worth looking at

### 1. The Subscribe Saga

Activating a subscription spans two services and two databases: charge a card
(billing), then activate the subscription (subscriptions). There is no
distributed transaction, and a database rollback cannot un-charge a credit card.

So it runs as a saga — a sequence of local transactions, each with a
**compensating action** if a later step fails:

```
STARTED
   │  create pending subscription (local transaction)
   ▼
AWAITING_PAYMENT ──── billing.charge.failed ─────────────────► FAILED
   │                  (nothing charged, nothing to undo)
   │ billing.charge.succeeded
   ▼
ACTIVATING ───────── activation threw ──► COMPENSATING_REFUND
   │                                              │  refund the card
   │ activation ok                                ▼
   ▼                                           FAILED
COMPLETED
```

The state machine is a **pure function** in
[`saga-definition.js`](services/subscription-service/src/domain/saga-definition.js) —
no database, no Kafka, no clock — so every branch including the compensation
paths is unit-tested. The orchestrator executes the commands it returns.

Saga state lives in Postgres, so a crash mid-saga does not lose it.

→ [docs/SAGA.md](docs/SAGA.md)

### 2. Caching the read-heavy paths

`GET /api/v1/home` needs data from four services. Two things make it fast:

1. **Fan out in parallel** — the calls are independent, so the cost is the
   slowest one, not the sum.
2. **Cache the composed result** — a warm request is one Redis lookup and no
   fan-out at all.

Measured on this machine with `npm run bench` (in-memory drivers, 61 titles,
300 requests at concurrency 25):

| | p50 | p95 | throughput |
|---|---|---|---|
| `GET /home` cache bypassed | 37 ms | 68 ms | 534 rps |
| `GET /home` cache served | 8 ms | 12 ms | 2951 rps |

**5.6× faster at p95, 5.5× the throughput.** Run `npm run bench` yourself — those
are numbers from a real run, not estimates. They grow substantially with a real
Postgres, a larger catalog and real network hops between containers; the cached
column stays roughly flat, which is the whole point.

Caches are **invalidated by events**, not by TTL alone: stopping playback drops
your continue-watching cache, and cancelling a subscription drops your
entitlement cache immediately — so a cancelled user cannot keep streaming off a
stale entry. There is also single-flight stampede protection, so 20 concurrent
misses on the same key produce exactly one origin call.

→ [docs/CACHING.md](docs/CACHING.md)

### 3. Natural-language search (26 intents)

```bash
POST /api/v1/recommendations/search
{ "query": "korean thriller series" }
```

```json
{
  "intent": "by_genre_and_language",
  "slots": { "genre": "thriller", "language": "ko", "type": "series" },
  "explanation": "1 result: thriller, in ko, series",
  "items": [ { "title": "Squid Game", "...": "..." } ],
  "tookMs": 1.4
}
```

It handles things like *"what was I watching"*, *"90s movies rated above 8"*,
*"movies with Tom Hanks"*, *"something funny to cheer me up"*, *"kids movies"*,
*"surprise me"*.

**It is rules, not an LLM** — and that is a deliberate trade-off. This runs on the
hot path of a search box, so it needs to be sub-millisecond, deterministic,
free, offline-capable, and testable branch by branch. An LLM would add hundreds
of milliseconds and make results non-reproducible. The cost is vocabulary
coverage, which is why the vocabulary lives in
[`lexicon.js`](services/recommendation-service/src/domain/lexicon.js) as data you
can extend without touching the parser.

Measured p95: **~12 ms** (the resume claim was "under 2 s").

→ [docs/RECOMMENDATIONS.md](docs/RECOMMENDATIONS.md)

---

## Drivers: the one idea that makes this runnable

Every external dependency sits behind an adapter with two implementations:

| | `memory` | real |
|---|---|---|
| `DATA_DRIVER` | in-process tables | `postgres` |
| `CACHE_DRIVER` | Map with TTL | `redis` |
| `BUS_DRIVER` | in-process pub/sub | `kafka` |

The in-memory event bus implements the same contract as Kafka — consumer groups,
per-key ordering, bounded retries, dead-letter queue — so the code above it
cannot tell the difference.

This is not a testing gimmick; it is what lets the entire platform boot in one
command on a laptop with nothing installed, and it lets **224 tests run in ~10
seconds in CI with no service containers**. The SQL is still real and still
tested — see below.

---

## Testing

```bash
npm test               # everything (224 tests, ~10s)
npm run test:unit      # pure logic + per-service integration
npm run test:e2e       # all 9 services on real ports, in one process
npm run test:integration  # every SQL query against a real Postgres engine
npm run smoke          # drive a running stack end to end
npm run bench          # latency measurements
```

**The SQL is genuinely tested.** `test:integration` runs every Postgres query
against [PGlite](https://pglite.dev) — real Postgres compiled to WebAssembly — so
it needs no database installed, and CI runs the same suite again against a real
`postgres:16` container with `REQUIRE_REAL_POSTGRES=1` so it cannot silently
fall back.

That suite caught four real bugs while this was being built: a non-immutable
generated column, an ambiguous column reference in a self-join, and a parameter
used as both `INT` and `BIGINT`.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs four jobs:

1. **test** — lint, unit, e2e, and SQL against embedded Postgres
2. **integration** — the same SQL against real Postgres + Redis containers
3. **smoke** — boots the platform and drives it like a client, then benchmarks it
4. **docker** — builds the image, validates compose, boots a container

---

## API

All routes are under `/api/v1`. Public: `/auth/*`, `/plans`. Everything else
needs `Authorization: Bearer <jwt>`.

```
POST   /auth/register              create an account, get a JWT
POST   /auth/login
GET    /home                       composed home screen (cached)
GET    /plans
POST   /subscriptions              202 Accepted — starts the saga
GET    /subscriptions/:id          includes live saga state + history
POST   /subscriptions/:id/cancel
GET    /subscriptions/entitlement  the hot path; cached
POST   /playback/sessions          201, or 403 with a machine-readable reason
POST   /playback/sessions/:id/progress
POST   /playback/sessions/:id/stop
GET    /watch-history/continue     continue watching
GET    /titles                     filter/sort/paginate
GET    /titles/:id/similar
POST   /recommendations/search     natural language
GET    /notifications
GET    /billing/payments
```

Operational endpoints on every service: `/health`, `/health/ready`, `/metrics`
(Prometheus format). `GET /ops/services` on the gateway aggregates readiness
across the whole platform.

Errors are uniform:

```json
{ "error": { "code": "FORBIDDEN", "message": "...", "details": { "reason": "title_not_in_plan", "upgradeTo": "premium" }, "requestId": "..." } }
```

---

## Documentation

| Doc | What is in it |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Why these boundaries, request flows, trade-offs |
| [SAGA.md](docs/SAGA.md) | The saga in detail, every failure path |
| [CACHING.md](docs/CACHING.md) | Every cache key, TTL and invalidation trigger |
| [EVENTS.md](docs/EVENTS.md) | Topics, event schemas, consumer groups, idempotency |
| [RECOMMENDATIONS.md](docs/RECOMMENDATIONS.md) | All 26 intents and how parsing works |
| [INTERVIEW-GUIDE.md](docs/INTERVIEW-GUIDE.md) | The questions this design invites, and honest answers |
| [legacy-monolith/](legacy-monolith/) | The "before", annotated |

---

## Project layout

```
packages/shared/          config, logger, errors, metrics, auth, middleware
  src/cache/              MemoryCache | RedisCache + withCache
  src/bus/                MemoryBus | KafkaBus + topics + envelope
  src/db/                 pg pool + in-memory table engine
services/<name>/
  src/domain/             pure logic — no I/O, heavily unit-tested
  src/repo/               *.memory.js and *.pg.js behind one interface
  src/routes/             HTTP
  src/consumers/          event handlers
  test/
db/migrations/            numbered .sql, with comments on every index
scripts/                  dev-all · migrate · seed · smoke · bench · wait-for
```

The consistent shape per service is deliberate: `domain/` is where the thinking
is and it has no dependencies, so it is trivially testable. `repo/` is the only
place SQL exists. `routes/` is thin.
