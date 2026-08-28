-- =============================================================================
-- notification-service  (pure event consumer)
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS notifications;

CREATE TABLE IF NOT EXISTS notifications.notifications (
  id                TEXT PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  channel           TEXT        NOT NULL CHECK (channel IN ('email','push','sms')),
  category          TEXT        NOT NULL,
  subject           TEXT        NOT NULL,
  body              TEXT        NOT NULL,
  -- Traceability: every notification records the exact event that caused it.
  source_event_id   TEXT,
  source_event_type TEXT,
  read_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications.notifications (user_id, created_at DESC);

-- The unread badge is polled constantly, so give it its own partial index.
CREATE INDEX IF NOT EXISTS notifications_unread_idx
  ON notifications.notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS notifications.processed_events (
  id           TEXT PRIMARY KEY,
  event_id     TEXT        NOT NULL,
  consumer     TEXT        NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
