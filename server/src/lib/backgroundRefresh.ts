import { Request } from 'express';
import prisma from './prisma';
import { logger } from './logger';
import { flags } from './flags';

// Nightly background job that refreshes the N oldest stale Google-
// sourced restaurant rows (TIER_2_3_PLAN.md #16).
//
// Why this exists: the existing refresh path is pull-based — a row
// only refreshes when a user opens its detail card. Rows nobody touches
// in 90 days stay stale forever, so hours / phone / website drift away
// from reality. This job pre-warms the worst offenders so the next
// user to open them sees fresh data.
//
// Cost control: capped at MAX_PER_RUN restaurants per execution, run
// once per RUN_INTERVAL_MS. Each refresh is one Place Details call
// (paid). The cap × interval limits the daily spend to a known
// constant — set both with the api_usage dashboard in front of you,
// not from guesswork.
//
// Why setInterval and not node-cron:
//   - One less dependency to keep secure-updated.
//   - We don't need precise time-of-day scheduling — "once every 24h
//     from server start" is fine. If we ever need cron-syntax precision
//     (e.g. "3 AM in the deploy region's TZ"), swap to node-cron then.
//
// Gate: the FLAG_BACKGROUND_REFRESH env var must be true (flag default
// is false). Lets us ship the code dark and flip it on after we've
// watched api_usage trends for a week.

// Tuning knobs — colocated here rather than in config/insights.ts
// because they're job-internal, not used by any route. Move to config
// if a second consumer ever needs them.
const MAX_PER_RUN     = 50;            // ≤50 rows per execution
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // ~daily
const STALE_DAYS      = 7;             // refresh anything not touched in 7+ days
const STARTUP_DELAY_MS = 60 * 1000;    // wait 60s after boot before first run

let timer: NodeJS.Timeout | null = null;

// We can't call refreshOnePlace directly without circular-import pain
// (it lives in routes/users.ts which imports from many places). Take a
// late-bound refresher as a callback; the route module wires it during
// app boot. Returns the count of rows successfully refreshed.
type RefreshFn = (
  row: { id: number; googlePlaceId: string | null },
  apiKey: string,
  req: Request,
) => Promise<unknown>;

let refresher: RefreshFn | null = null;

// Called from routes/users.ts at import time — registers the
// refreshOnePlace implementation without creating an import cycle.
export function registerBackgroundRefresher(fn: RefreshFn): void {
  refresher = fn;
}

async function runOnce(): Promise<void> {
  if (!flags.backgroundRefresh) {
    // Flag flipped off mid-run — skip silently. Cheap defensive check.
    return;
  }
  if (!refresher) {
    logger.warn('[bg-refresh] No refresher registered — skipping run');
    return;
  }
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    logger.warn('[bg-refresh] GOOGLE_PLACES_API_KEY unset — skipping run');
    return;
  }

  const staleThreshold = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

  // Pick the N oldest-stale Google-sourced rows. Custom user-typed rows
  // (googlePlaceId IS NULL) have nothing to refresh from.
  const rows = await prisma.restaurant.findMany({
    where: {
      googlePlaceId: { not: null },
      OR: [
        { googleDataUpdatedAt: null },
        { googleDataUpdatedAt: { lt: staleThreshold } },
      ],
    },
    orderBy: { googleDataUpdatedAt: 'asc' },
    take: MAX_PER_RUN,
    select: { id: true, googlePlaceId: true },
  });

  if (rows.length === 0) {
    logger.info('[bg-refresh] No stale rows to refresh');
    return;
  }

  logger.info({ count: rows.length }, '[bg-refresh] Refreshing stale rows');

  // Synthetic "system" Request — trackGoogleCall reads `userId` and
  // `log`; userId=0 is the documented sentinel for unauthenticated /
  // background calls (see lib/apiUsage.ts).
  const syntheticReq = { userId: 0, log: logger } as unknown as Request;

  // Sequential (not parallel) to keep the rate-limited Google API
  // happy. The interval lets us spread cost over days; we don't need
  // to burst through 50 calls in a second.
  let okCount = 0;
  for (const row of rows) {
    try {
      const result = await refresher(row, apiKey, syntheticReq);
      if (result) okCount += 1;
    } catch (err) {
      logger.error({ err, rowId: row.id }, '[bg-refresh] Refresh threw');
    }
  }

  logger.info({ attempted: rows.length, succeeded: okCount }, '[bg-refresh] Run complete');
}

/**
 * Start the periodic background refresh. Safe to call multiple times
 * (idempotent — second call is a no-op). Skip when the feature flag
 * is off; the timer never starts, so we don't even pay the setInterval
 * cost for disabled environments.
 *
 * Called from server/src/index.ts after the env validation but before
 * the listener starts accepting traffic.
 */
export function startBackgroundRefresh(): void {
  if (timer) return;                       // already running
  if (!flags.backgroundRefresh) return;    // disabled
  // Boot delay so the job doesn't compete with the initial spike of
  // user requests right after deploy.
  timer = setTimeout(() => {
    runOnce().catch((err) => logger.error({ err }, '[bg-refresh] Initial run failed'));
    timer = setInterval(() => {
      runOnce().catch((err) => logger.error({ err }, '[bg-refresh] Periodic run failed'));
    }, RUN_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
  logger.info(
    { intervalMs: RUN_INTERVAL_MS, maxPerRun: MAX_PER_RUN, staleDays: STALE_DAYS },
    '[bg-refresh] Scheduled',
  );
}

/**
 * Stop the periodic refresh. Used by tests + graceful shutdown.
 */
export function stopBackgroundRefresh(): void {
  if (timer) {
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }
}

// Test-only entry point. Lets a test drive one iteration without
// waiting for the interval to fire.
export const __testOnly = { runOnce };
