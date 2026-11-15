# Runbook: SubscribeSagaFailing

**Severity:** warning · **Fires when:** more than 20% of subscribe sagas end in `FAILED` over 15 minutes.

## What it means
Customers are trying to subscribe and it is not working. Because of the saga
design (`docs/SAGA.md`), a failed subscription after a successful charge is
refunded automatically, so nobody is charged for nothing. The business is
still losing signups.

## Check
1. Why are they failing? Each saga stores its state and failure reason:
   `GET /subscriptions/sagas` on subscription-service (internal route), or
   query the sagas table directly.
2. `payment_failed` for everyone: is `billing-service` up? Check its runbook.
3. Failures in `ACTIVATING`: the subscription write is failing. Check
   `subscription-service` logs and Postgres.
4. Look for `COMPENSATING_REFUND` sagas that never reached a terminal state.
   Those are refunds that need a human.

## Fix
Fix the failing dependency. Sagas already in `FAILED` do not retry, so tell
support which users to contact (query by time window).
