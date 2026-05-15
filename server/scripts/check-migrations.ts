#!/usr/bin/env -S npx tsx
/**
 * Migration drift check.
 *
 * Verifies that every migration directory in `server/prisma/migrations/`
 * has been successfully applied to the database the DATABASE_URL points
 * at. Uses Prisma's connection (rather than psql) so it works in any
 * environment where the server tests can run.
 *
 * Use cases:
 *   1. Pre-deploy: run against the target env's DATABASE_URL to see if
 *      `prisma migrate deploy` will need to apply anything.
 *   2. Local dev: confirm your local DB is in sync after pulling main.
 *   3. CI smoke-test: catches "PR adds a migration but no env applies it."
 *
 * Exit codes:
 *   0 — every migration directory has a finished, successfully-applied row
 *   1 — drift detected (named in stderr)
 *   2 — environment / connection problem
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/check-migrations.ts
 *   ... --quiet   # no output on the success path
 */

import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const QUIET = process.argv.includes('--quiet');
const log = (...args: unknown[]) => { if (!QUIET) console.log(...args); };
const warn = (...args: unknown[]) => console.warn(...args);

// __dirname is server/scripts/ — the migrations live one level up.
const SERVER_ROOT = resolve(__dirname, '..');
const MIGRATIONS_DIR = join(SERVER_ROOT, 'prisma', 'migrations');

if (!process.env.DATABASE_URL) {
  warn('✗ DATABASE_URL is not set. Migration check needs a connection string.');
  process.exit(2);
}

interface PrismaMigrationRow {
  migration_name: string;
  applied_steps_count: number;
  finished_at: Date | null;
}

async function main() {
  const fsMigrations: string[] = readdirSync(MIGRATIONS_DIR)
    .filter((name) => {
      const stat = statSync(join(MIGRATIONS_DIR, name));
      return stat.isDirectory();
    })
    .sort();

  if (fsMigrations.length === 0) {
    log('✓ No migration directories present — nothing to check.');
    return 0;
  }

  const prisma = new PrismaClient();
  try {
    // _prisma_migrations is Prisma's internal tracking table. Schema:
    //   id, checksum, finished_at, migration_name, logs, rolled_back_at,
    //   started_at, applied_steps_count.
    //
    // Success condition: finished_at IS NOT NULL AND rolled_back_at IS NULL.
    // We deliberately do NOT require applied_steps_count > 0 — that field
    // is 0 for migrations marked via `prisma migrate resolve --applied`
    // (the recovery path you use when a migration was applied out-of-band,
    // e.g. via `prisma db execute`). Those rows are still "applied" for
    // our purposes; the strict step-count check would false-positive them.
    const applied = await prisma.$queryRawUnsafe<PrismaMigrationRow[]>(`
      SELECT migration_name, applied_steps_count, finished_at
        FROM _prisma_migrations
       WHERE finished_at IS NOT NULL
         AND rolled_back_at IS NULL
      ORDER BY migration_name
    `);
    const appliedSet = new Set(applied.map((r) => r.migration_name));

    const pending = fsMigrations.filter((m) => !appliedSet.has(m));
    const orphan = applied.map((r) => r.migration_name).filter((m) => !fsMigrations.includes(m));

    if (pending.length > 0) {
      warn('✗ DRIFT: the following migrations exist in the repo but are NOT applied:');
      for (const m of pending) warn(`    - ${m}`);
      warn('');
      warn("Run 'cd server && npx prisma migrate deploy' against this DATABASE_URL to apply them.");
      return 1;
    }

    if (orphan.length > 0) {
      log('⚠ NOTE: the following migrations are applied in the DB but missing from the repo:');
      for (const m of orphan) log(`    - ${m}`);
      log('(Usually means someone deleted a migration file post-deploy. Not a failure, but worth investigating.)');
    }

    log(`✓ All ${fsMigrations.length} migrations are applied.`);
    return 0;
  } catch (err) {
    warn('✗ Failed to query _prisma_migrations. Common causes:');
    warn('  - DATABASE_URL points at a DB that was never initialized by Prisma');
    warn('  - Network / TLS / auth failure to the DB');
    warn(`Error: ${(err as Error).message}`);
    return 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  warn(err);
  process.exit(2);
});
