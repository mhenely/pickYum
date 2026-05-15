-- Enable trigram extension for fast case-insensitive substring search.
-- Idempotent: safe to re-run on databases where it's already enabled.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN index using gin_trgm_ops lets Postgres serve `name ILIKE '%foo%'`
-- (which is how Prisma compiles `name: { contains, mode: 'insensitive' }`)
-- from an index instead of a full table scan. Hot path: every "add
-- option" search on the group event page (restaurants?search=…).
--
-- IF NOT EXISTS guards against re-run, but it does NOT detect a partial
-- failure during initial creation — if you see this fail with "already
-- exists", drop the index and re-run.
CREATE INDEX IF NOT EXISTS restaurants_name_trgm_idx
  ON restaurants
  USING GIN (name gin_trgm_ops);
