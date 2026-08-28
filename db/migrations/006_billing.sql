-- =============================================================================
-- billing-service  (saga participant)
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS billing;

CREATE TABLE IF NOT EXISTS billing.payments (
  id              TEXT PRIMARY KEY,
  user_id         TEXT        NOT NULL,
  subscription_id TEXT        NOT NULL,
  saga_id         TEXT        NOT NULL,
  -- The single most important column in this service: it makes charging
  -- idempotent. A redelivered charge command finds this row and replays the
  -- original outcome instead of taking the money a second time.
  idempotency_key TEXT        NOT NULL,
  amount_minor    INT         NOT NULL CHECK (amount_minor > 0),
  currency        CHAR(3)     NOT NULL DEFAULT 'INR',
  status          TEXT        NOT NULL CHECK (status IN ('succeeded','failed','refunded')),
  failure_reason  TEXT,
  refund_id       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS payments_idempotency_key ON billing.payments (idempotency_key);
CREATE INDEX IF NOT EXISTS payments_user_idx  ON billing.payments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_saga_idx  ON billing.payments (saga_id);

CREATE TABLE IF NOT EXISTS billing.processed_events (
  id           TEXT PRIMARY KEY,
  event_id     TEXT        NOT NULL,
  consumer     TEXT        NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
