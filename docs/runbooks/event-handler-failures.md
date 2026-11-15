# Runbook: EventHandlerFailures

**Severity:** warning · **Fires when:** a Kafka consumer threw errors in the last 10 minutes.

## What it means
A failing event is retried 3 times with a short backoff (`kafka-bus.js`). If
it still fails, it goes to the `platform.dlq` dead-letter topic so the
partition keeps moving. Nothing is lost, but the event's side effect (watch
history, a notification, a billing step) has not happened yet.

## Check
1. Which topic and event type? Both are labels on the metric:
   `sum by (topic, type) (increase(events_failed_total[10m]))`
2. Did anything reach the dead-letter topic? Each DLQ event carries the
   original topic, consumer group and error message:
   `kafka-console-consumer.sh --bootstrap-server kafka:9092 --topic platform.dlq --from-beginning`
3. One event type or all of them? One type points at a code bug; all of them
   points at a dependency such as Postgres.

## Fix
- Dependency down: fix it, then replay the DLQ events onto their original
  topic.
- Code bug on one event shape: ship the fix, then replay.
