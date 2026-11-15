# Runbook: HighErrorRate

**Severity:** critical · **Fires when:** more than 5% of a service's requests return a 5xx for 5 minutes.

## Check
1. Which routes are failing?
   `sum by (route, status) (rate(http_requests_total{service="<service>", status=~"5.."}[5m]))`
2. Did it start with a deploy? `kubectl -n streaming rollout history deploy/<service>`
3. Find a failing request in the logs. Every log line carries `requestId`, and
   the same id appears in every service the request passed through:
   `kubectl -n streaming logs deploy/<service> | grep '"status":5'`
4. Is a downstream service down too? A ServiceDown alert on a dependency
   usually explains this one.

## Fix
- Started right after a deploy: `kubectl -n streaming rollout undo deploy/<service>`.
- Database errors in the logs: check the Postgres pod and connection count.
- Caused by another service: follow that service's runbook first.

## Close out
Error share back under 1% on the Grafana "Service Overview" dashboard.
