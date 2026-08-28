-- =============================================================================
-- subscription-service  (the SAGA ORCHESTRATOR)
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS subscriptions;

CREATE TABLE IF NOT EXISTS subscriptions.subscriptions (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT        NOT NULL,
  plan_id              TEXT        NOT NULL CHECK (plan_id IN ('basic','standard','premium')),
  status               TEXT        NOT NULL CHECK (status IN ('pending','active','failed','cancelled','expired')),
  -- Money is stored as an INTEGER in the smallest currency unit (paise).
  -- Floating point must never be used for currency.
  price_minor          INT         NOT NULL,
  currency             CHAR(3)     NOT NULL DEFAULT 'INR',
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end   TIMESTAMPTZ NOT NULL,
  payment_id           TEXT,
  failure_reason       TEXT,
  cancelled_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A PARTIAL UNIQUE INDEX: a user may have many past subscriptions but at most
-- ONE active one. The database enforces this even if two saga instances race.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_subscription_per_user
  ON subscriptions.subscriptions (user_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions.subscriptions (user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- Saga instances.
--
-- This table is why the saga survives a crash: the current state of every
-- in-flight subscription lives here, not in the memory of a Node process. On
-- restart the orchestrator can resume from whatever state it finds.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions.saga_instances (
  id              TEXT PRIMARY KEY,
  saga_type       TEXT        NOT NULL,
  subscription_id TEXT        NOT NULL,
  user_id         TEXT        NOT NULL,
  state           TEXT        NOT NULL,
  payload         JSONB       NOT NULL DEFAULT '{}',
  -- Append-only audit trail of every transition — this is what
  -- GET /subscriptions/sagas/:id renders, and what you debug a stuck saga with.
  history         JSONB       NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS saga_subscription_idx ON subscriptions.saga_instances (subscription_id);

-- Drives the timeout sweeper: find sagas stuck in a non-terminal state.
CREATE INDEX IF NOT EXISTS saga_stalled_idx
  ON subscriptions.saga_instances (updated_at)
  WHERE state NOT IN ('COMPLETED','FAILED');

-- -----------------------------------------------------------------------------
-- Consumer-side deduplication.
--
-- Kafka guarantees AT-LEAST-ONCE delivery, so any consumer can see the same
-- event twice. Inserting the event id here with ON CONFLICT DO NOTHING makes
-- "have I already handled this?" an atomic database question.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions.processed_events (
  id           TEXT PRIMARY KEY,   -- '<consumer>:<eventId>'
  event_id     TEXT        NOT NULL,
  consumer     TEXT        NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sub_processed_at_idx ON subscriptions.processed_events (processed_at);

-- Request-side idempotency: retrying POST /subscriptions with the same
-- Idempotency-Key returns the first result instead of starting a second saga.
CREATE TABLE IF NOT EXISTS subscriptions.idempotency_keys (
  id         TEXT PRIMARY KEY,
  result     JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
