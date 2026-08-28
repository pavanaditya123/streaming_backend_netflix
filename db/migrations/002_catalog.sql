-- =============================================================================
-- catalog-service  (the read-heavy service)
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS catalog;

-- Postgres marks the built-in array_to_string() as STABLE, not IMMUTABLE,
-- because in general it calls an element type's output function. A generated
-- column may only use IMMUTABLE expressions, so this thin wrapper pins it to
-- text[] — for which the conversion genuinely is immutable — and declares it as
-- such. This is the standard workaround for indexing array columns in a
-- generated tsvector.
CREATE OR REPLACE FUNCTION catalog.array_to_text(arr text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$ SELECT array_to_string(arr, ' ') $$;

CREATE TABLE IF NOT EXISTS catalog.titles (
  id               TEXT PRIMARY KEY,
  title            TEXT        NOT NULL,
  type             TEXT        NOT NULL CHECK (type IN ('movie','series')),
  year             INT         NOT NULL,
  genres           TEXT[]      NOT NULL DEFAULT '{}',
  language         TEXT        NOT NULL,
  country          TEXT,
  duration_minutes INT,
  seasons          INT,
  episodes         INT,
  rating           NUMERIC(3,1) NOT NULL DEFAULT 0,
  maturity         TEXT        NOT NULL DEFAULT 'UA',
  director         TEXT,
  cast_members     TEXT[]      NOT NULL DEFAULT '{}',
  moods            TEXT[]      NOT NULL DEFAULT '{}',
  awards           TEXT[]      NOT NULL DEFAULT '{}',
  plans            TEXT[]      NOT NULL DEFAULT '{}',
  description      TEXT,
  view_count       BIGINT      NOT NULL DEFAULT 0,
  added_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Generated full-text column: Postgres keeps it in sync on every write, so
  -- the application never has to remember to update a search index.
  search_vector    tsvector GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(title,'') || ' ' ||
      coalesce(description,'') || ' ' ||
      coalesce(director,'') || ' ' ||
      catalog.array_to_text(cast_members) || ' ' ||
      catalog.array_to_text(genres) || ' ' ||
      catalog.array_to_text(moods))
  ) STORED
);

-- GIN indexes make `genres @> ARRAY['action']` an index lookup instead of a
-- sequential scan over the whole catalog. Same for the full-text search column.
CREATE INDEX IF NOT EXISTS titles_genres_gin   ON catalog.titles USING GIN (genres);
CREATE INDEX IF NOT EXISTS titles_moods_gin    ON catalog.titles USING GIN (moods);
CREATE INDEX IF NOT EXISTS titles_plans_gin    ON catalog.titles USING GIN (plans);
CREATE INDEX IF NOT EXISTS titles_awards_gin   ON catalog.titles USING GIN (awards);
CREATE INDEX IF NOT EXISTS titles_cast_gin     ON catalog.titles USING GIN (cast_members);
CREATE INDEX IF NOT EXISTS titles_search_gin   ON catalog.titles USING GIN (search_vector);

-- Composite index matching the default ORDER BY of the trending query, so the
-- database can walk the index instead of sorting the whole table.
CREATE INDEX IF NOT EXISTS titles_popularity_idx ON catalog.titles (view_count DESC, rating DESC);
CREATE INDEX IF NOT EXISTS titles_rating_idx     ON catalog.titles (rating DESC);
CREATE INDEX IF NOT EXISTS titles_language_year  ON catalog.titles (language, year DESC);
CREATE INDEX IF NOT EXISTS titles_added_idx      ON catalog.titles (added_at DESC);
