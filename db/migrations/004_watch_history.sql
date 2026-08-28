-- =============================================================================
-- watch-history-service  (built entirely from playback events)
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS watch_history;

CREATE TABLE IF NOT EXISTS watch_history.entries (
  user_id               TEXT        NOT NULL,
  title_id              TEXT        NOT NULL,
  title_name            TEXT,
  position_seconds      INT         NOT NULL DEFAULT 0,
  duration_seconds      INT,
  completed             BOOLEAN     NOT NULL DEFAULT FALSE,
  play_count            INT         NOT NULL DEFAULT 0,
  total_watched_seconds BIGINT      NOT NULL DEFAULT 0,
  first_watched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_watched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One row per (user, title): re-watching UPDATES rather than inserting, so
  -- the table grows with distinct titles watched, not with playback events.
  PRIMARY KEY (user_id, title_id)
);

-- Serves both "my history" and "continue watching" without a sort step.
CREATE INDEX IF NOT EXISTS entries_user_recent
  ON watch_history.entries (user_id, last_watched_at DESC);

-- "Continue watching" only ever looks at unfinished rows.
CREATE INDEX IF NOT EXISTS entries_continue_idx
  ON watch_history.entries (user_id, last_watched_at DESC)
  WHERE completed = FALSE AND position_seconds >= 30;

-- Consumer-side deduplication table (see the note in 005 about idempotency).
CREATE TABLE IF NOT EXISTS watch_history.processed_events (
  id           TEXT PRIMARY KEY,
  event_id     TEXT        NOT NULL,
  consumer     TEXT        NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS wh_processed_at_idx ON watch_history.processed_events (processed_at);
