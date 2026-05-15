# Migration Runbook

How to safely add, apply, and verify Prisma migrations for PickYum.

## Quick reference

| Task | Command |
|---|---|
| Check drift (any env) | `cd server && DATABASE_URL=... npx tsx scripts/check-migrations.ts` |
| Create a new migration | `cd server && npx prisma migrate dev --name <descriptive_snake_case>` |
| Apply pending migrations | `cd server && npx prisma migrate deploy` |
| Mark out-of-band SQL as applied | `cd server && npx prisma migrate resolve --applied <name>` |
| View migration status | `cd server && npx prisma migrate status` |

## When you add a migration

Every PR that changes `server/prisma/schema.prisma` must include:

1. **The migration file** under `server/prisma/migrations/<timestamp>_<name>/migration.sql`.
   Use `prisma migrate dev` in development to generate this — Prisma names the
   timestamped directory and writes the SQL diff itself. Don't hand-write the
   timestamp unless you're producing a deliberately deterministic name (e.g. for
   a backfill that pairs with the schema change in a sibling migration).

2. **A rollback note** in the PR description. One of:
   - *"Forward-only; rollback by reverting the migration in a follow-up migration."*
     (Default for adds, non-destructive changes.)
   - *"Reversible via `<SQL statement>`."*
     (Drops, type changes, anything that loses data. Spell it out.)

3. **"What breaks if this isn't applied"** line. Forces you to think about
   ordering between code deploys and DB migrations. Examples:
   - *"Login route reads `failed_login_count`; without the column, login 500s."*
   - *"Non-breaking: column is read defensively with null fallback."*

## Deploy order — code vs. migration

The general rule: **migrations land BEFORE the code that depends on them.**

| Change type | Order |
|---|---|
| Add column / table | Migration first → code that reads/writes it second. |
| Drop column / table | Code that stops reading it first → migration second, in a follow-up release. |
| Rename column | Migration adds NEW column → code dual-writes both → backfill → code reads new only → migration drops OLD column. (Three releases.) |
| Add index | Anytime — non-breaking. Use `CREATE INDEX CONCURRENTLY` for large tables to avoid table locks. |

## Applying migrations to production

Two paths:

1. **The standard path: `prisma migrate deploy`.** Runs as part of the CI/CD
   pipeline (App Runner's prebuild step) before the new server image takes
   traffic. Idempotent — re-running is a no-op.

2. **The recovery path: `prisma migrate resolve --applied <name>`.** Use
   when you've applied SQL out-of-band (e.g. via `prisma db execute --file`
   or a hot fix in the DB console) and need to teach Prisma's `_prisma_migrations`
   table about it. Mark a migration "applied" with this command after the
   SQL has actually run. **Don't use this to skip a migration** — that's
   how silent drift accumulates.

## The drift check (`scripts/check-migrations.ts`)

Compares the migration directories on disk against `_prisma_migrations` rows
in the target DB. Exit codes:

- `0` — every migration directory has a `finished_at IS NOT NULL` row.
- `1` — drift detected; pending migrations are named in stderr.
- `2` — environment problem (`DATABASE_URL` unset, connection failure).

The check does NOT require `applied_steps_count > 0`, because that field
is 0 for migrations applied via the `resolve --applied` recovery path —
those rows are still legitimately "applied" for our purposes.

Run it:

```bash
# Local
cd server && npx tsx scripts/check-migrations.ts

# Against a target env (read-only — safe in CI)
cd server && DATABASE_URL=postgres://... npx tsx scripts/check-migrations.ts --quiet
```

The `--quiet` flag suppresses output on the success path so CI logs stay
clean; failures still print.

## How drift happens (and how to avoid it)

The three failure modes we've observed in this codebase:

1. **"I applied this locally with `db execute` but forgot to resolve it."**
   The schema is in the DB but `_prisma_migrations` has no row.
   *Avoidance:* always pair `prisma db execute --file` with
   `prisma migrate resolve --applied <name>`. Or use `prisma migrate dev`
   for new migrations — it does both.

2. **"I edited a migration file after it was applied to staging."**
   Prisma stores a checksum of the SQL in `_prisma_migrations`. Changing
   the file after deploy makes `migrate deploy` refuse to run on that
   environment.
   *Avoidance:* never edit applied migrations. Add a follow-up migration
   instead.

3. **"The migration ran but the code that needs it didn't get deployed yet."**
   Reverse of the standard case — code that doesn't yet exist references
   a column that now does. Harmless.
   *Caution:* the inverse (code deploys before its migration) is a real
   incident. The CI/CD order above prevents this for the deploy pipeline,
   but watch it on hot-fix deploys.

## Pre-deploy checklist

Before merging any PR that touches `schema.prisma`:

- [ ] `cd server && npx prisma migrate dev` ran cleanly locally
- [ ] Migration file is in `server/prisma/migrations/<timestamp>_<name>/migration.sql`
- [ ] PR description has rollback note + "what breaks if not applied" line
- [ ] Server tests pass — `cd server && npm test`
- [ ] (For destructive changes) Confirmed with a teammate before merging

Before deploying to production:

- [ ] `npx tsx scripts/check-migrations.ts` shows no drift against staging
- [ ] Staging is healthy after the migration applied (monitor for 30 min)
- [ ] Rollback plan is written down (not just in someone's head)
