# Interview guide

Honest answers to the questions this design invites. If you can answer the ten in
"The questions you will definitely get", you can hold a conversation about this
project.

**One rule above all: do not claim anything here you have not read.** Every
answer below points at a file. Open it, read it, and be able to say why it is
written that way. An interviewer will forgive "I haven't optimised that yet"; they
will not forgive a confident explanation of code you cannot find.

---

## Ninety-second summary

> "It's a streaming backend — catalog, playback, watch history, subscriptions,
> billing, notifications and recommendations. It started as a monolith; that's
> still in the repo under `legacy-monolith/`.
>
> Two things forced the split. First, playback and billing have completely
> different scaling shapes — playback is thousands of requests a second, billing
> is a handful a minute — and in one process you can't scale them separately.
> Second, `POST /play` was doing three writes the user didn't need before it
> returned a stream URL, so any of them failing failed playback.
>
> After the split the services were still coupled through synchronous calls, so I
> put Kafka in between. Playback now publishes one event and returns; watch
> history, catalog and notifications each react on their own.
>
> Subscriptions were the hard part, because charging a card and activating a
> subscription live in two services and you can't roll back a credit card charge.
> That's a saga with a compensating refund.
>
> Then the read paths were slow, because the home screen fans out to four
> services. I cache the composed result in Redis and invalidate on events. There's
> a benchmark script — p95 goes from about 68ms to 12ms on my machine, and
> throughput about 5x."

Then stop and let them pick a thread.

---

## The questions you will definitely get

### 1. "Why microservices? Wasn't the monolith fine?"

The strongest answer starts by agreeing.

> "For most projects the monolith is right, and I kept it in the repo to make
> that point. Two specific things pushed me off it.
>
> Scaling shape: playback needs thousands of requests a second, billing needs a
> handful a minute. One process means one scaling unit, so scaling playback meant
> scaling billing too.
>
> Failure blast radius: in the monolith, `POST /play` incremented a view count,
> wrote watch history and queued a notification — all before returning a stream
> URL. None of it was needed to answer the request, but any of it failing failed
> playback.
>
> If those two things weren't true I'd have stayed with the monolith."

Have the cost list ready — they will ask, and volunteering it is stronger than
being caught: added latency, eventual consistency, 9 processes to operate,
debugging across services, no cross-service joins.

### 2. "Explain the saga."

Draw the state machine. Lead with *why*, not *what*:

> "Charging a card is in billing, activating a subscription is in subscriptions —
> different services, different schemas, so no shared transaction. And even one
> transaction wouldn't help, because you can't roll back a credit card charge.
> The only way back is a second forward action: a refund.
>
> So it's a sequence of local transactions, each with a compensating action."

Then the asymmetry, which is the part that shows you understand it:

> "If the charge fails, I go straight to FAILED — no money moved, nothing to
> compensate. Issuing a refund there would be a bug. If the charge succeeds but
> activation fails, I go to COMPENSATING_REFUND first, because money did move."

Then the design point:

> "The state machine is a pure function — state and event in, next state and
> commands out. No database, no Kafka. That's what makes the compensation path
> testable, which otherwise is very hard to trigger."

→ `services/subscription-service/src/domain/saga-definition.js`

### 3. "Orchestration or choreography? Why?"

> "Orchestration for the saga, choreography for the playback fan-out — both are
> in the codebase on purpose.
>
> The saga involves money and needs compensation, so I want one place that owns
> the sequence and a row I can query to answer 'what state is this in?'. With
> choreography that flow only exists as an emergent property of who's listening
> to what.
>
> The playback fan-out is the opposite — three consumers, no ordering
> requirement, no money. Playback publishes a fact and doesn't care who listens.
> Adding a fourth consumer needs no change anywhere else."

### 4. "Kafka delivers at-least-once. How do you avoid charging twice?"

Four layers — count them off:

1. **Request** — `Idempotency-Key` header; a retried POST replays the original
   result instead of starting a second saga.
2. **Consumer** — every consumer inserts the `eventId` into a `processed_events`
   table with `ON CONFLICT DO NOTHING`; `rowCount === 0` means already handled.
3. **Payment** — `billing.payments.idempotency_key` is `UNIQUE`. A redelivered
   charge command finds the row and replays its outcome.
4. **State machine** — a terminal saga ignores every event, so a late duplicate
   cannot resurrect it.

> "The database enforces it, not just application code — that's what makes it
> hold under a race."

### 5. "How did you get 1.2s down to 150ms?" / "Where does the speed come from?"

**Be precise about what you measured.** Do not quote numbers you cannot
reproduce.

> "Two things. The home screen needed data from four services; the calls are
> independent so I fan out in parallel rather than sequentially — that turns the
> sum into the max. Then I cache the composed payload in Redis, so a warm request
> is one lookup and no fan-out at all.
>
> There's a benchmark script in the repo. On my laptop with in-memory drivers I
> measure p95 going from about 68ms to 12ms and throughput from 530 to 2950
> requests a second — about 5x. The gap is much larger with real Postgres and a
> big catalog, because the uncached path scales with data size and the cached
> path doesn't. Those are the numbers I can actually reproduce."

If your resume says 1.2s → 150ms, **run the benchmark against Docker with a
seeded catalog and use whatever it actually prints.** A real smaller number beats
an impressive number you cannot demonstrate.

### 6. "How do you invalidate the cache?"

> "TTL alone isn't enough for anything correctness-sensitive. The clearest case
> is cancellation — entitlement has a 5-minute TTL, so a cancelled user could
> keep streaming for 5 minutes. So cancelling deletes that key immediately.
> There's a test for it, because it's exactly the kind of thing that silently
> regresses.
>
> Same for watch history: the playback consumer drops the continue-watching cache
> whenever an event arrives.
>
> One detail — pattern deletes use SCAN, not KEYS. KEYS blocks the whole Redis
> event loop on a large keyspace."

### 7. "What happens when a service goes down?"

Pick the concrete example:

> "The home screen calls four services and each call has its own catch that
> degrades to null — so if recommendations is down, you still get trending and
> your subscription info, just fewer rails. A blank page is much worse than a
> partial one.
>
> There's also a circuit breaker: after five consecutive failures it opens and
> fails fast for ten seconds instead of piling requests onto a dying service.
> 4xx responses deliberately don't trip it — a 403 is a healthy service giving a
> correct answer.
>
> And for consumers, a handler that keeps throwing gets dead-lettered rather than
> retried forever, because otherwise one poison message blocks its partition and
> every subsequent event for those users stops."

### 8. "How do you test any of this without infrastructure?"

This is a genuinely strong part of the project — do not undersell it.

> "Every external dependency is behind an adapter with two implementations —
> Postgres/memory, Redis/memory, Kafka/memory — chosen by an environment
> variable. The in-memory bus implements the same contract as Kafka: consumer
> groups, per-key ordering, retries, dead-letter. So the whole platform boots in
> one command with nothing installed, and 224 tests run in about ten seconds in
> CI with no service containers.
>
> The SQL is still real and still tested. The integration suite runs every query
> against PGlite — Postgres compiled to WebAssembly — and CI runs the same suite
> again against a real postgres:16 container, with a flag that makes it fail
> rather than silently fall back.
>
> That suite caught four real bugs while I was building it: a generated column
> that wasn't immutable, an ambiguous column in a self-join, and a parameter used
> as both INT and BIGINT."

### 9. "Why rules instead of an LLM for search?"

> "It's on the hot path of a search box, so I wanted sub-millisecond,
> deterministic, free and testable — an LLM adds hundreds of milliseconds and
> makes results non-reproducible, which also makes them untestable. It parses in
> about 0.1ms.
>
> The cost is vocabulary coverage, which is real. The vocabulary is data, not
> code, so adding synonyms doesn't touch the parser, and there's a keyword
> fallback when nothing matches.
>
> If I needed open-ended language, the hybrid is: rules on the hot path for the
> formulaic queries, LLM only for the low-confidence fallback. The architecture
> already isolates that branch."

### 10. "What would you do differently / what's missing?"

Never say "nothing". Have three real ones:

> "First, the transactional outbox. Right now a saga writes its state and
> publishes an event as two steps, so a crash between them is possible. I have a
> timeout sweeper that catches the resulting stuck saga, but the correct fix is
> writing to an outbox table in the same transaction and relaying from there.
>
> Second, the internal secret between services is one shared credential. That
> should be mTLS or a service mesh.
>
> Third, request ids propagate correctly but nothing collects them into traces.
> With a saga spanning services, OpenTelemetry would make debugging much easier."

---

## Questions that catch people out

**"Why 202 instead of 201 on subscribe?"**
> "Because it's genuinely not done yet — billing hasn't replied. Returning 201
> would be lying. The client polls `GET /subscriptions/:id`, which returns the
> live saga state. It's a real API consequence of choosing a saga."

**"What's the partition key and why does it matter?"**
> "User id. All events for one user land on one partition so one consumer
> processes them in order. Concretely: a progress event at 1200 seconds arriving
> after one at 2400 would move someone's resume point backwards. Different users
> have no ordering relationship, which is what lets it scale horizontally."

**"Where does JWT validation happen?"**
> "Only at the gateway. Downstream services never see the token — the gateway
> forwards the user id plus a shared internal secret. One place to change auth,
> and services aren't reachable from outside with a forged identity."

**"Why is money an integer?"**
> "Paise, not rupees. Floats lose precision on money — 0.1 + 0.2 isn't 0.3. There's
> a `CHECK (amount_minor > 0)` too, and a test asserting the column type is
> integer."

**"What's a partial index and where did you use one?"**
> "An index over only the rows matching a condition. The concurrent-stream check
> runs on every play but only cares about `status = 'playing'`, so the index
> covers only those rows — finished sessions aren't in it at all. Same for
> continue-watching and the unread-notification badge. There's also a partial
> *unique* index enforcing one active subscription per user, which is what makes
> the database — not just app code — prevent a double subscription."

**"How would you scale this to 10 million users?"**
> "Roughly: read replicas for catalog since it's read-heavy; partition watch
> history by user id; more Kafka partitions and consumer instances — per-user
> ordering still holds; Redis cluster; and scale playback independently, which is
> the whole point of the split. The saga is already horizontally scalable because
> its state is in Postgres, not in memory."

**"What's the hardest bug you hit?"**
Use the real one — specific beats impressive:
> "Compensation was reading the payment id from the subscription row. But if
> activation failed, that row was never updated — so the refund had nothing to
> refund, and it failed silently. The integration test caught it. The fix was to
> record the payment id on the saga itself before attempting activation: the
> saga's own state has to be the source of truth for compensation, not the thing
> that just failed to write."

---

## Demo script (about 5 minutes)

```bash
npm install
npm run dev          # terminal 1
npm run smoke        # terminal 2 — prints every step
```

Walk them through the smoke output: blocked without a subscription → saga runs to
COMPLETED → playback works → watch history appears with nobody writing to it →
notifications from events → declined card fails cleanly → idempotent retry →
natural-language search → cached home screen → cancel revokes access instantly.

Then:

```bash
npm run bench        # your real cache numbers
npm test             # 224 tests, ~10 seconds
```

If they want depth, open these three, in this order:

1. `services/subscription-service/src/domain/saga-definition.js` — the pure state machine
2. `services/api-gateway/src/routes/home.route.js` — fan-out + caching + degradation
3. `legacy-monolith/server.js` — the numbered comments showing what each thing became

---

## Things to avoid saying

- **"Microservices are better than monoliths."** They are a trade-off. Saying so
  unprompted is the single strongest signal of seniority here.
- **Quoting numbers you cannot reproduce.** Run `npm run bench` and use its output.
- **"It handles millions of users."** It has not been load-tested at that scale.
  Say what you measured and how you would scale further.
- **Claiming the payment integration is real.** It is a deterministic simulator
  behind the interface a real one would use. That is a fine answer; pretending
  otherwise is not.
- **Explaining code you have not read.** If you do not know, say "I'd have to
  check" — it costs you far less than being caught.
