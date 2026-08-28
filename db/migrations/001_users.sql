-- =============================================================================
-- user-service
--
-- Each service owns its own SCHEMA and no service ever reads another's tables.
-- In production these would be separate database instances; separate schemas
-- enforce exactly the same boundary while keeping local dev to one container.
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS users;

CREATE TABLE IF NOT EXISTS users.accounts (
  id            TEXT PRIMARY KEY,
  email         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  display_name  TEXT        NOT NULL,
  country       CHAR(2)     NOT NULL DEFAULT 'IN',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforces "one account per email" in the DATABASE, not just in application
-- code. Two concurrent registrations cannot both win.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_key ON users.accounts (LOWER(email));
