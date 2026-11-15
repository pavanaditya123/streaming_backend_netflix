# Runbook: ServiceDown

**Severity:** critical · **Fires when:** Prometheus cannot scrape a service for 1 minute.

## What users see
Depends on the service. If it is `api-gateway`, everything is down. If it is
`billing-service`, new subscriptions hang in `AWAITING_PAYMENT` but playback
still works.

## Check
1. Is the process running?
   - Kubernetes: `kubectl -n streaming get pods -l app=<service>`
   - Compose: `docker compose ps <service>`
2. Why did it stop? Look at the last logs before the restart.
   - `kubectl -n streaming logs deploy/<service> --previous --tail=100`
   - `docker compose logs --tail=100 <service>`
3. Is it a dependency? `curl <service>/health/ready` lists Postgres, Redis and
   Kafka as `ok` or `down`.

## Fix
- `CrashLoopBackOff` with a config error: fix the ConfigMap/Secret, then
  `kubectl -n streaming rollout restart deploy/<service>`.
- Readiness failing on Postgres/Redis/Kafka: fix the dependency first; the pod
  recovers by itself once `/health/ready` returns 200.
- Bad release: `kubectl -n streaming rollout undo deploy/<service>`.

## Close out
Confirm `up{service="<service>"} == 1` in Prometheus and that the alert resolved.
