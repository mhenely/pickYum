import type { Request } from 'express';
import prisma from './prisma';
import { logger } from './logger';

// Cost-per-call (in cents) for each Google Places API endpoint we
// invoke. Values reflect the Pro-tier pricing we're on; cache hits
// are recorded at 0 since they don't reach Google. Estimated for
// internal accounting — compare against the Google Cloud Billing API
// for ground truth when needed.
//
// SKU references (current Google Places API pricing):
//   - searchNearby (Pro):     $32  / 1000 → 3.2¢/call
//   - searchText  (Pro):      $32  / 1000 → 3.2¢/call
//   - Place Photo (media):    $7   / 1000 → 0.7¢/call
//   - Place Details (Pro):    $17  / 1000 → 1.7¢/call
//   - Geocoding:              $5   / 1000 → 0.5¢/call
//
// Adding a new endpoint: add to the union type + the cost table.
// Both must match; TS will complain if a typed call site uses an
// endpoint not in the cost table.
export const GOOGLE_COST_CENTS = {
  nearby:        3.2,
  textSearch:    3.2,
  photo:         0.7,
  placeDetails:  1.7,
  geocode:       0.5,
} as const;

export type GoogleEndpoint = keyof typeof GOOGLE_COST_CENTS;

export interface TrackOptions {
  // True when the request was served from our server-side cache and
  // never touched Google. Recorded in cache_hits + costs 0¢; lets us
  // measure cache effectiveness vs raw call volume.
  cacheHit?: boolean;
  // 'error' bills nothing (failed Google calls aren't charged), but
  // we still want a log entry for visibility. Defaults to 'ok'.
  status?: 'ok' | 'error';
}

// One call: emits a structured log line (4A — for Sentry / log
// search) AND upserts a row in api_usage (4B — for queryable
// historical aggregates). Synchronous from the caller's perspective:
// log is sync, counter UPSERT is fire-and-forget so the actual
// request flow isn't blocked on a counter write.
//
// userId is read from req.userId; falls back to 0 for unauthenticated
// surfaces (the public photo proxy is the main one). userId=0
// buckets all anonymous calls together in api_usage.
//
// Safe to call from any request handler. Failures inside (log emit
// or DB write) are caught locally — instrumentation MUST NOT break
// the wrapped Google call.
export function trackGoogleCall(
  req: Request,
  endpoint: GoogleEndpoint,
  opts: TrackOptions = {},
): void {
  const cacheHit = opts.cacheHit === true;
  const status   = opts.status ?? 'ok';
  // Unauthenticated requests (photo proxy) → userId = 0. Real users
  // start at 1 (autoincrement), so 0 is a safe sentinel.
  const userId   = typeof req.userId === 'number' ? req.userId : 0;
  // No spend on cache hits or errored upstream calls.
  const costCents = (cacheHit || status === 'error') ? 0 : GOOGLE_COST_CENTS[endpoint];

  // ── 4A: structured log emission ─────────────────────────────
  // Pino merges the `google` object into the log entry so log sinks
  // (Sentry, Datadog, etc.) can filter/aggregate on `google.endpoint`,
  // `google.userId`, `google.costCents`, etc.
  try {
    (req.log ?? logger).info(
      { google: { endpoint, userId: userId || null, costCents, cacheHit, status } },
      'google api call',
    );
  } catch { /* log emit failure is non-fatal */ }

  // ── 4B: counter UPSERT (fire-and-forget) ────────────────────
  // Atomic per (userId, day, endpoint) via the composite PK. Day
  // bucket is UTC-midnight so the rollup is consistent across
  // timezones — the dashboard can convert to local time when
  // displaying. Increment-on-update guarantees concurrent calls
  // don't lose counts to last-write-wins.
  const dayUtc = new Date();
  dayUtc.setUTCHours(0, 0, 0, 0);
  // Promise.resolve() wrap defends against test environments where
  // prisma.apiUsage.upsert is mocked to a non-Promise return value
  // (jest-mock-extended returns undefined when no .mockResolvedValue
  // is set). Wrapping ensures `.catch` is always callable.
  Promise.resolve()
    .then(() => prisma.apiUsage.upsert({
      where: { userId_day_endpoint: { userId, day: dayUtc, endpoint } },
      create: {
        userId,
        day: dayUtc,
        endpoint,
        callCount: 1,
        cacheHits: cacheHit ? 1 : 0,
        estCostCents: costCents,
      },
      update: {
        callCount:    { increment: 1 },
        cacheHits:    { increment: cacheHit ? 1 : 0 },
        estCostCents: { increment: costCents },
      },
    }))
    .catch((err) => {
      // Non-fatal — counter loss is acceptable, breaking the wrapped
      // Google call is not. Surface in logs for investigation.
      try {
        (req.log ?? logger).warn(
          { err, endpoint, userId },
          'api_usage upsert failed',
        );
      } catch { /* nothing to do — log emit failed too */ }
    });
}
