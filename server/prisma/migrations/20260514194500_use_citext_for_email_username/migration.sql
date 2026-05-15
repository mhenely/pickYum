-- Enable case-insensitive text type for email + username. `pg_trgm` was
-- already created out-of-band by the previous migration; the IF NOT EXISTS
-- makes this a no-op here. Declared in schema.prisma's datasource so
-- Prisma's drift detection keeps both extensions accounted for.
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Convert email + username to citext. Comparison and the unique-index
-- lookups both become case-insensitive at the DB level — login,
-- register, forgot-password, and profile uniqueness checks now serve
-- from the existing B-tree unique index in O(log N) instead of doing a
-- sequential scan. Original casing is preserved on storage; only the
-- = and ILIKE operators are case-insensitive.
--
-- Will fail loudly if the table already contains case-variant duplicates
-- (e.g. "Alice@x.com" AND "alice@x.com" as separate users) — the app-
-- level check has always been case-insensitive, so this shouldn't
-- happen in practice. If it does, resolve manually before re-running.
ALTER TABLE "users" ALTER COLUMN "email" SET DATA TYPE CITEXT,
ALTER COLUMN "username" SET DATA TYPE CITEXT;

