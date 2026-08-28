# The Subscribe Saga

## Why a saga is needed at all

Activating a subscription requires two things to happen together:

1. **Charge the card** — owned by `billing-service`, in the `billing` schema, and
   ultimately a call to an external payment provider.
2. **Activate the subscription** — owned by `subscription-service`, in the
   `subscriptions` schema.

They live in different services and different schemas, so `BEGIN … COMMIT` cannot
span them. And even a single shared transaction would not help, because **you
cannot roll back a credit card charge**. Once the money has moved, the only way
back is a second forward action: a refund.

That is exactly what a saga is — a sequence of local transactions where each step
has a **compensating action** that semantically undoes it.

### Why orchestration rather than choreography

Two ways to run a saga:

- **Choreography** — each service listens for the previous service's event and
  decides what to do next. No coordinator. The problem: the flow exists only as
  an emergent property of who happens to be listening to what. Nobody can answer
  "what state is subscription X in?" without reading every service's logs.
- **Orchestration** — one service owns the sequence and tells the others what to
  do. That is what this uses.

Orchestration was chosen because this flow involves **money**. The properties that
matter here are: the current state is a row you can query, the whole flow is
readable in one file, and adding a step does not mean editing three services.
The cost is that `subscription-service` becomes a coordinator that must stay up.

For the playback fan-out — three consumers reacting to one event, no ordering
requirement, no money — choreography is right, and that is what it uses. **Both
patterns are in this codebase on purpose.**

## The state machine

```
                              start()
                                 │  create pending subscription (local tx)
                                 │  command: CHARGE_PAYMENT
                                 ▼
                      ┌────────────────────┐
                      │  AWAITING_PAYMENT  │
                      └─────────┬──────────┘
                billing.charge  │  billing.charge.failed
                  .succeeded    │        │
                                ▼        └──────────────────────┐
                      ┌────────────────────┐                    │
                      │     ACTIVATING     │                    │
                      └─────────┬──────────┘                    │
                                │                               │
              activation ok     │      activation threw         │
                    ┌───────────┴───────────┐                   │
                    ▼                       ▼                   │
            ┌──────────────┐     ┌──────────────────────┐       │
            │  COMPLETED   │     │ COMPENSATING_REFUND  │       │
            └──────────────┘     └──────────┬───────────┘       │
              publish                       │ billing.refund    │
              subscription.activated        │   .completed      │
                                            ▼                   │
                                     ┌──────────────┐           │
                                     │    FAILED    │◄──────────┘
                                     └──────────────┘
                                       publish subscription.failed
```

Note the asymmetry, which is the heart of the design:

- **Charge failed** → go straight to `FAILED`. No money moved, so there is
  nothing to compensate. Issuing a refund here would itself be a bug.
- **Activation failed** → go to `COMPENSATING_REFUND` first. Money *did* move,
  so it must be given back before the saga can be considered finished.

## The code

The machine is a **pure function**
([`saga-definition.js`](../services/subscription-service/src/domain/saga-definition.js)):

```js
transition(currentState, event) -> { state, commands }
```

No database, no Kafka, no clock, no side effects. It returns *what should happen*
and the orchestrator decides *how*. That separation is what makes the
compensation path — normally very hard to trigger — testable in three lines:

```js
let state = start().state;
state = transition(state, { type: CHARGE_SUCCEEDED, payload: { paymentId: 'p1' } }).state;
state = transition(state, { type: 'ACTIVATION_FAILED', payload: {} }).state;
state = transition(state, { type: REFUND_COMPLETED, payload: {} }).state;
assert.equal(state, 'FAILED');
```

The orchestrator
([`orchestrator.js`](../services/subscription-service/src/saga/orchestrator.js))
loads the saga row, asks the state machine, persists the new state and its
history entry, then executes the commands.

## Durability

Saga state lives in `subscriptions.saga_instances`, **not** in process memory:

```sql
id, saga_type, subscription_id, user_id,
state,                 -- current state
payload   JSONB,       -- plan, price, and the payment id once charged
history   JSONB,       -- append-only audit of every transition
created_at, updated_at
```

If `subscription-service` restarts mid-saga, the row is still there and the
billing reply is still on the topic. The service resumes from whatever state it
finds.

`GET /subscriptions/sagas/:id` returns the row, and `GET /subscriptions/:id`
includes the live state and full history — so "what happened to this
subscription?" is one HTTP call, not a log hunt.

### One subtle bug worth knowing about

Compensation reads the payment id from **the saga's own payload**, not from the
subscription row. The first version read it from the subscription — and the
integration test caught that this is exactly wrong: if activation failed, the
subscription row was never updated, so the payment id is not there, and the
refund silently had nothing to refund.

The saga's own state is the source of truth for compensation. The payment id is
therefore written to `payload` *before* activation is attempted.

## Idempotency, at three layers

Kafka delivers **at least once**, and clients retry. Money must not move twice.

**1. Request level** — `Idempotency-Key` header on `POST /subscriptions`:

```js
const previous = await repo.findIdempotentResult(`subscribe:${userId}:${key}`);
if (previous) return res.status(202).json({ ...previous, idempotentReplay: true });
```

**2. Consumer level** — every consumer dedupes on `eventId` before acting:

```sql
INSERT INTO processed_events (id, ...) VALUES ($1, ...) ON CONFLICT (id) DO NOTHING
-- rowCount === 0 means "already handled this"
```

**3. Payment level** — `billing.payments.idempotency_key` is `UNIQUE`. A
redelivered charge command finds the existing row and replays its outcome rather
than charging again:

```js
const existing = await repo.findByIdempotencyKey(idempotencyKey);
if (existing) return replyToCharge({ bus, event, payment: existing });
```

Plus a fourth guarantee from the state machine itself: a saga in a terminal state
ignores every event, so a late duplicate cannot resurrect a finished saga.

## Timeouts

If billing never replies — crash, lost message, network partition — the saga
would sit in `AWAITING_PAYMENT` forever. A background sweeper fails any saga that
has been non-terminal for too long:

```js
sweepStalledSagas({ repo, orchestrator, timeoutMs: 60_000 })
```

It feeds a synthetic `CHARGE_FAILED` into the saga, which drives it through the
normal failure path — the user is notified and no state is left dangling. The
partial index `saga_stalled_idx` makes finding those rows cheap.

## Seeing it work

```bash
npm run dev
npm run smoke     # steps 4 and 11 are the happy and failure paths
```

A card ending in `0000` is always declined, so the failure path is reproducible.
To see the **compensation** path, the activation step must fail — the integration
test forces that by making the database write throw:

```
services/subscription-service/test/saga-orchestrator.test.js
  → "COMPENSATION: when activation fails after charging, the money is refunded"
```

It asserts the saga ends `FAILED`, a refund was requested *and* completed, and
the payment row reads `refunded` with a refund id.

## Trade-offs

**What this buys:** no distributed transaction; every step independently
retryable; the current state is queryable; money is never left in an inconsistent
place; participants stay decoupled.

**What it costs:**

- **Eventual consistency.** `POST /subscriptions` returns `202`, not `201`. The
  subscription is `pending` for a moment. The client must poll or wait for a
  notification — this is a real API design consequence, not an implementation
  detail.
- **No isolation.** Unlike a transaction, intermediate states are visible. A user
  can see a `pending` subscription.
- **Compensation is semantic, not a rollback.** A refund is a new fact, not an
  erasure. The customer sees a charge and a refund on their statement.
- **More moving parts.** A saga is harder to reason about than `BEGIN … COMMIT`,
  which is precisely why the state machine is pure and separately tested.
