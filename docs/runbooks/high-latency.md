# Runbook: HighLatencyP95

**Severity:** warning · **Fires when:** a service's p95 latency stays above 500 ms for 10 minutes.

## Check
1. Which routes are slow?
   `histogram_quantile(0.95, sum by (route, le) (rate(http_request_duration_ms_bucket{service="<service>"}[5m])))`
2. Is the cache working? A falling hit ratio on the dashboard means the read
   paths are going to Postgres again (see `docs/CACHING.md`).
   `redis-cli info stats | grep keyspace`
3. Is the pod starved? `kubectl -n streaming top pods` against the limits in
   `k8s/`.
4. Is traffic simply higher than usual? Compare requests per second to last week.

## Fix
- CPU at the limit: the HPA should already be scaling `api-gateway` and
  `catalog-service`; check `kubectl -n streaming get hpa`. Raise `maxReplicas`
  if it is pinned at the max.
- Cache empty after a Redis restart: it refills on its own; latency drops as
  the hit ratio climbs.
- One slow SQL query: run it with `EXPLAIN ANALYZE` and add the missing index.
