-- =============================================================================
-- playback-service
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS playback;

CREATE TABLE IF NOT EXISTS playback.sessions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT        NOT NULL,
  title_id          TEXT        NOT NULL,
  device_id         TEXT        NOT NULL,
  quality           TEXT        NOT NULL,
  status            TEXT        NOT NULL CHECK (status IN ('playing','stopped','expired')),
  position_seconds  INT         NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The concurrent-stream check runs on EVERY play. A partial index over only the
-- 'playing' rows keeps it tiny: finished sessions are not in the index at all.
CREATE INDEX IF NOT EXISTS sessions_active_idx
  ON playback.sessions (user_id) WHERE status = 'playing';

-- Used by the stale-session reaper.
CREATE INDEX IF NOT EXISTS sessions_heartbeat_idx
  ON playback.sessions (last_heartbeat_at) WHERE status = 'playing';

CREATE INDEX IF NOT EXISTS sessions_user_started ON playback.sessions (user_id, started_at DESC);
