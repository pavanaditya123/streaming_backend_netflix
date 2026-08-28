# The monolith this project started as

`server.js` is the original single-process version, kept on purpose.

It is not a strawman. For a small product it is the correct design: one deploy,
one database, no network between your own functions, and you can read the whole
thing in ten minutes. **Most projects should stay here.**

It is in the repository because the honest version of this project's story is
not "microservices are better". It is: here are the specific things that stopped
working, and here is what each one became.

## What actually forced the split

| # | The problem in `server.js` | Where it hurt | What it became |
|---|---|---|---|
| 1 | One process is one scaling unit | Playback needs thousands of req/s; billing needs a handful per minute. Scaling one scales both. | 8 services, each scaled on its own |
| 2 | Synchronous fan-out in `POST /play` | Three writes the user does not need happen before they get a stream URL, and any of them failing fails playback | `playback.events` on Kafka; three independent consumers |
| 3 | `POST /subscribe` charges, then writes | Crash between the two lines = customer charged, no subscription. A DB transaction cannot undo a charge. | The Subscribe Saga with a compensating refund |
| 4 | `GET /home` runs four uncached scans | Every page load, every user, forever | Redis cache-aside on the composed payload, invalidated by events |
| 5 | One schema, any handler can join anything | Every table becomes load-bearing for every feature | A schema per service, no cross-service joins |

## Reading it alongside the new code

```bash
node legacy-monolith/server.js     # :3900
```

The comments in `server.js` are numbered to match the table above, and each one
names the file in the new architecture that replaced it. Reading `POST /play`
here and then `services/playback-service/src/routes/playback.routes.js` is
probably the single most useful five minutes in this repo.

## What the split cost

Worth saying plainly, because it is the thing an interviewer will probe:

- **Latency**: a function call became a network call. The home screen now fans
  out to four services — which is exactly why it had to be cached.
- **Consistency**: watch history is now eventually consistent. It appears a few
  milliseconds after you stop watching, not in the same transaction.
- **Operational weight**: 9 processes, Kafka, Redis, Postgres, and a saga to
  reason about, instead of `node server.js`.
- **Debugging**: one request now spans several services, which is why every
  request carries an `x-request-id` and every event carries a `correlationId`.

The split was worth it here because playback and billing genuinely have
different scaling shapes and different failure tolerances. If they did not, the
monolith would still be the right answer.
