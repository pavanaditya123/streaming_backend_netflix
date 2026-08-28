# Architecture

## How the boundaries were chosen

Services are split by **what changes together and what scales together**, not by
technical layer. There is no "database service" or "API layer service" here —
those splits create chatty dependencies without buying independence.

The test applied to each candidate service was: *can this be deployed, scaled and
broken independently of the others?*

| Service | Scaling shape | Failure tolerance |
|---|---|---|
| playback | Very high write rate, latency-critical | Must never go down; users are mid-stream |
| catalog | Very high read rate, rarely written | Cacheable; slightly stale is fine |
| watch-history | High write rate, tolerates lag | Can be seconds behind with no user impact |
| subscription/billing | Very low volume, correctness-critical | Slow is acceptable; wrong is not |
| notification | Bursty, fully async | Can retry for minutes |
| recommendation | Read-heavy, CPU-light | Degrade to trending if it fails |

playback and billing sit at opposite extremes on every row, which is the clearest
possible argument that they do not belong in one process.

## Request flows

### Starting playback (synchronous, latency-critical)

```
client ──► gateway ──► playback ──┬──► subscription  GET /entitlement   (Redis, ~1ms)
                                  └──► catalog       GET /titles/:id    (Redis, ~1ms)
                                        │
                                  authorize (pure function)
                                        │
                                  write session row
                                        │
                                  publish playback.session.started ──► Kafka
                                        │
                                  201 + manifest URL
```

The two upstream calls run **in parallel** and both are cached on the other side.
The Kafka publish is fire-and-forget: playback does not wait for watch-history,
catalog or notifications, and does not fail if they are down.

### After playback (asynchronous fan-out)

```
                      ┌──► watch-history   update progress, invalidate cache
playback.events ──────┼──► catalog         increment view count, drop trending cache
                      └──► notification    only if the title was finished
```

Three consumer groups, three independent failure domains. Each dedupes on
`eventId` because Kafka is at-least-once.

### Subscribing (asynchronous, orchestrated)

```
client ──► gateway ──► subscription   create pending row, start saga
                              │       202 Accepted (returns immediately)
                              ▼
                       billing.commands ──► billing   charge card
                              ▲                │
                              └── billing.events ◄────┘
                              │
                       activate + publish subscription.activated
                              │
                              └──► notification
```

The client gets `202 Accepted` and polls `GET /subscriptions/:id`, which returns
the live saga state. See [SAGA.md](SAGA.md).

## The trust boundary

The end-user JWT is verified in **exactly one place**: the gateway.

```
internet ──[Bearer JWT]──► gateway ──[x-internal-secret + x-user-id]──► services
```

Downstream services never see the token. They require `x-internal-secret` and
trust the forwarded `x-user-id`. This means:

- One place to change auth, rotate keys, or add claims.
- Services do not each carry JWT-verification code.
- A service is not reachable from outside with a forged identity.

The obvious weakness is that the shared secret is a single credential. In
production this is where you would put mTLS or a service mesh; the header
approach is the same shape, just simpler to run. The tests assert this boundary
holds (`services/user-service/test/auth.test.js`).

## Resilience

| Mechanism | Where | What it prevents |
|---|---|---|
| Circuit breaker | `http-client.js` | Requests piling up on a dying dependency (opens after 5 failures, half-open probe after 10s) |
| Timeout + retry | `http-client.js` | Hanging on a slow upstream. Retries only idempotent methods — never a POST |
| Graceful degradation | `home.route.js` | One slow service blanking the whole home screen; each call degrades to `null` |
| Consumer retry + DLQ | both bus adapters | A poison message blocking a partition forever |
| Idempotency keys | subscription + billing | A retried request charging twice |
| Event dedupe | every consumer | At-least-once delivery double-counting |
| Saga timeout sweeper | `orchestrator.js` | A lost billing reply leaving a subscription pending forever |
| Session reaper | `playback/server.js` | A crashed client holding a stream slot forever |
| Stampede protection | `withCache` | A thundering herd on one cold key |

4xx responses deliberately **do not** trip the circuit breaker — a 403 is a
healthy service giving a correct answer.

## What this design costs

Stated plainly, because these are real:

- **Latency.** Function calls became network calls. The home screen fans out to
  four services — which is exactly why it is cached.
- **Eventual consistency.** Watch history appears milliseconds after you stop
  watching, not in the same transaction. The UI must tolerate that.
- **Operational weight.** 9 processes, Kafka, Redis, Postgres, and a saga to
  reason about — instead of `node server.js`.
- **Debugging across services.** One user action now spans several logs, which
  is why every request carries `x-request-id` and every event carries a
  `correlationId` linking back to it.
- **No cross-service joins.** "Which users watched title X" now needs an event
  stream or an API call, not a `JOIN`.

If playback and billing had similar scaling shapes, the monolith would still be
the right answer. See [`legacy-monolith/`](../legacy-monolith/).

## What is deliberately simplified

Being honest about the gap between this and production:

- **Payments are simulated.** `payment-gateway.js` is deterministic rather than
  a real Stripe/Razorpay integration — but it sits behind the interface a real
  one would use, and it fails deterministically so the compensation path is
  demonstrable.
- **One Postgres instance, schema per service.** Real isolation would be
  separate instances. The schema boundary enforces the same rule in code.
- **No transactional outbox.** A saga writes its state and publishes an event as
  two steps; a crash between them is possible. The timeout sweeper catches the
  resulting stuck saga. A production system would write to an outbox table in
  the same transaction and relay from there.
- **JWT has no refresh token or revocation list.**
- **No distributed tracing backend.** Request ids propagate correctly, but
  nothing collects them into spans.
- **The CDN is a URL shape**, not a signed URL against real storage.
