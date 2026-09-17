# Events

## Topics

| Topic | Produced by | Consumed by |
|---|---|---|
| `playback.events` | playback | watch-history, catalog, notification |
| `subscription.events` | subscription | notification |
| `billing.commands` | subscription (orchestrator) | billing |
| `billing.events` | billing | subscription (orchestrator) |
| `user.events` | user | notification |
| `notification.events` | notification | — (audit trail) |
| `platform.dlq` | any consumer | — (operator inspection) |

## Commands vs events

The distinction is deliberate and worth stating in an interview:

- **An event is a fact.** `playback.session.started` — this happened. The
  producer does not know or care who listens. Anyone may consume it.
- **A command is a request.** `billing.charge.requested` — please do this. It is
  addressed to exactly one service, and the sender expects a reply.

Commands live on `*.commands` topics, events on `*.events`. The saga uses
commands because it needs a specific service to act; the playback fan-out uses
events because playback genuinely does not care who is listening.

## Event envelope

```js
{
  eventId: "uuid",              // dedupe key for consumers
  type: "playback.session.started",
  version: 1,
  key: "usr_abc",               // partition key -> ordering guarantee
  correlationId: "req-uuid",    // ties back to the originating HTTP request
  causationId: "event-uuid",    // which event caused this one
  occurredAt: "2026-08-25T...",
  payload: { ... }
}
```

`correlationId` starts as the gateway's `x-request-id` and is carried through
every downstream event, so one user action is traceable across services and
topics. `causationId` builds the chain: charge command → charge succeeded →
subscription activated → notification sent.

## Ordering

`key` is the Kafka partition key, and it is always the **user id**. All events
for one user land on one partition, so one consumer processes them in order.
That matters concretely: `PLAYBACK_PROGRESS(1200)` arriving after
`PLAYBACK_PROGRESS(2400)` would move a resume point backwards.

Events for *different* users have no ordering relationship, which is what allows
horizontal scaling — add partitions and consumers, and per-user ordering still
holds.

The in-memory bus reproduces this: it serialises delivery per `(groupId, key)`.
There is a test that makes the first handler deliberately slow and asserts the
order still comes out `[1, 2, 3]`.

## Consumer groups

| Group | Topic(s) | Purpose |
|---|---|---|
| `watch-history` | playback.events | build progress + continue-watching |
| `catalog-popularity` | playback.events | view counts, trending |
| `notifications` | playback, subscription, user events | email/push |
| `billing-commands` | billing.commands | charge / refund |
| `subscription-saga` | billing.events | drive the saga |

Each group gets its **own copy** of every message. Three groups consume
`playback.events` and none of them affect the others — a broken watch-history
consumer does not stop trending from updating.

## Idempotency

Kafka delivery can repeat, so every consumer must be designed with redelivery in
mind. The watch-history, notification, billing, and saga consumers record the
`eventId` before doing their work:

```js
const fresh = await repo.markEventProcessed(event.eventId, 'watch-history');
if (!fresh) return;
```

Backed by an atomic upsert:

```sql
INSERT INTO watch_history.processed_events (id, event_id, consumer, processed_at)
VALUES ($1, $2, $3, NOW()) ON CONFLICT (id) DO NOTHING
-- rowCount === 0  =>  already processed
```

The id is `<consumer>:<eventId>`, so a different consumer group still gets to
process the same event — dedupe is per-consumer, not global.

Tests cover duplicate protection in the consumers that implement it. The catalog
popularity consumer currently has no dedupe record, so the same playback-started
event can increment `view_count` twice. Also, the consumers currently commit the
dedupe marker and the business mutation as separate operations. A crash between
them can cause a retry to skip unfinished work. The production pattern is an
inbox record and the business mutation in one local database transaction.

## Failure handling

A handler that throws is retried with backoff, then dead-lettered:

```
attempt 1 → fail → wait → attempt 2 → fail → wait → attempt 3 → fail → DLQ
```

Parking the message matters more than it looks: without a DLQ, a single poison
message can block later work on its partition. Both adapters exercise bounded
retry and dead-letter paths, although the memory adapter is a test double rather
than a complete Kafka emulator.

A failing consumer group does not affect the others — there is a test for that too.

## Both patterns, on purpose

This codebase contains **choreography** and **orchestration**, chosen per flow:

- **Choreography** (`playback.events`): playback publishes a fact; three services
  react independently. No coordinator. Right when there is no ordering
  requirement between consumers and no money involved — and adding a fourth
  consumer requires changing nothing.
- **Orchestration** (the saga): one coordinator drives an explicit sequence.
  Right when the flow involves money, needs compensation, and someone must be
  able to ask "what state is this in?".

See [SAGA.md](SAGA.md) for why orchestration won for subscriptions.

## Adding a new consumer

Nothing else in the platform changes:

```js
bus.subscribe(TOPICS.PLAYBACK_EVENTS, async (event) => {
  const fresh = await repo.markEventProcessed(event.eventId, 'my-consumer');
  if (!fresh) return;
  // ...
}, { groupId: 'my-consumer', types: [EVENTS.PLAYBACK_STOPPED] });
```

That is the payoff of the event-driven split, and the clearest contrast with the
monolith, where the same feature meant editing `POST /play` and putting more work
in the user's critical path.
