// Aggregate queries over the api_usage table. Separated from the
// route handler so the same queries can be reused by:
//   - GET /api/admin/usage          (operational dashboard)
//   - GET /api/users/me/usage       (per-user self-service surface)
//   - A future scheduled summary    (Pino log emit, Slack ping, etc.)
//
// All queries roll up by endpoint AND total so callers can render
// per-SKU bars + a single headline number. Costs are stored in the DB
// as Decimal cents (truncated to 4 decimal places by the column type);
// we convert to plain JS numbers at the boundary because dashboards
// don't need decimal precision — being off by a hundredth of a cent
// is meaningless when we're looking at $-scale numbers.

import { Prisma } from '@prisma/client';
import prisma from './prisma';
import { GOOGLE_COST_CENTS, type GoogleEndpoint } from './apiUsage';

export interface EndpointBreakdown {
  endpoint: GoogleEndpoint;
  callCount: number;     // billable upstream calls (cache misses)
  cacheHits: number;     // requests served from server-side cache
  estCostCents: number;  // billable spend
  // Cache hit rate as a 0-1 fraction. Computed from cacheHits / (cacheHits + callCount)
  // so it answers "of all requests for this endpoint, what fraction skipped Google?"
  // 0 when no traffic on this endpoint.
  cacheHitRate: number;
}

export interface UsageSummary {
  // YYYY-MM-DD strings (UTC) bounding the window — inclusive.
  startDate: string;
  endDate:   string;
  // Per-endpoint rollups + a synthesized 'total' row.
  byEndpoint: EndpointBreakdown[];
  totalCallCount: number;
  totalCacheHits: number;
  totalCostCents: number;
  cacheHitRate:   number;  // overall, weighted by request volume
}

export interface TopSpender {
  userId: number;          // 0 = anonymous (photo proxy)
  username: string | null; // null when userId=0 OR the user has been deleted
  callCount: number;
  cacheHits: number;
  estCostCents: number;
}

export interface DailyPoint {
  date: string;          // YYYY-MM-DD (UTC)
  callCount: number;
  cacheHits: number;
  estCostCents: number;
}

// ── Window helpers ────────────────────────────────────────────────

// Pin a Date to UTC midnight. We bucket usage rows by UTC date so the
// rollup math doesn't fight timezones — the dashboard can convert to
// local time at the presentation layer if it ever needs to.
function utcMidnight(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Resolve a `daysBack` integer into an inclusive [start, end] window of
// UTC dates anchored at today. `daysBack=0` is just today; `daysBack=6`
// is the last 7 calendar days.
export function windowFromDaysBack(daysBack: number): { start: Date; end: Date } {
  const end = utcMidnight(new Date());
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(0, daysBack));
  return { start, end };
}

// ── Aggregates ────────────────────────────────────────────────────

/**
 * Roll up usage across all users for a given UTC date range, broken
 * down by endpoint plus a synthesized total. Bounded by date column
 * (which has a btree index for `day`) — fast even at long lookbacks.
 */
export async function getUsageSummary(start: Date, end: Date): Promise<UsageSummary> {
  // groupBy day-windowed sum per endpoint. Decimal handling: Prisma
  // returns the sum as a Prisma.Decimal; convert via .toNumber() at
  // the boundary so we ship plain JSON. Loss of precision at the
  // fractional-cent level is acceptable for ops dashboards.
  const rows = await prisma.apiUsage.groupBy({
    by: ['endpoint'],
    where: { day: { gte: start, lte: end } },
    _sum: { callCount: true, cacheHits: true, estCostCents: true },
  });

  const byEndpoint: EndpointBreakdown[] = (Object.keys(GOOGLE_COST_CENTS) as GoogleEndpoint[])
    .map((endpoint) => {
      const row = rows.find((r) => r.endpoint === endpoint);
      const callCount = row?._sum.callCount    ?? 0;
      const cacheHits = row?._sum.cacheHits    ?? 0;
      const costCents = row?._sum.estCostCents ? Number(row._sum.estCostCents) : 0;
      const total = callCount + cacheHits;
      const cacheHitRate = total > 0 ? cacheHits / total : 0;
      return { endpoint, callCount, cacheHits, estCostCents: costCents, cacheHitRate };
    })
    .sort((a, b) => b.estCostCents - a.estCostCents); // most expensive endpoint first

  const totalCallCount = byEndpoint.reduce((sum, r) => sum + r.callCount, 0);
  const totalCacheHits = byEndpoint.reduce((sum, r) => sum + r.cacheHits, 0);
  const totalCostCents = byEndpoint.reduce((sum, r) => sum + r.estCostCents, 0);
  const totalReq       = totalCallCount + totalCacheHits;
  const cacheHitRate   = totalReq > 0 ? totalCacheHits / totalReq : 0;

  return {
    startDate: isoDate(start),
    endDate:   isoDate(end),
    byEndpoint,
    totalCallCount,
    totalCacheHits,
    totalCostCents,
    cacheHitRate,
  };
}

/**
 * Top N users by billable spend in the given window. userId=0 (the
 * unauthenticated photo proxy bucket) is included so an "anonymous
 * users are eating my budget" signal is visible; the route layer
 * can choose to surface it differently in the UI.
 */
export async function getTopSpenders(
  start: Date,
  end:   Date,
  limit: number = 20,
): Promise<TopSpender[]> {
  // Group by user, sum cost, sort by sum desc. The aggregator runs in
  // the DB so we don't pull every row to the app layer for a window
  // that could span months × N users.
  const rows = await prisma.apiUsage.groupBy({
    by: ['userId'],
    where: { day: { gte: start, lte: end } },
    _sum: { callCount: true, cacheHits: true, estCostCents: true },
    orderBy: { _sum: { estCostCents: 'desc' } },
    take: limit,
  });

  // Bulk-resolve usernames so the response carries human-readable
  // identifiers without N+1 queries.
  const realUserIds = rows.map((r) => r.userId).filter((id) => id > 0);
  const users = realUserIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: realUserIds } },
        select: { id: true, username: true },
      })
    : [];
  const usernameById = new Map(users.map((u) => [u.id, u.username]));

  return rows.map((r) => ({
    userId:       r.userId,
    username:     r.userId === 0 ? null : (usernameById.get(r.userId) ?? null),
    callCount:    r._sum.callCount    ?? 0,
    cacheHits:    r._sum.cacheHits    ?? 0,
    estCostCents: r._sum.estCostCents ? Number(r._sum.estCostCents) : 0,
  }));
}

/**
 * Daily timeline of total usage across the window. Chart-ready
 * (one point per day, ordered by date asc). Sparse days don't appear
 * as rows in api_usage — we backfill zeros for missing days so the
 * frontend can render a continuous timeline without gap-handling.
 */
export async function getDailyTimeline(start: Date, end: Date): Promise<DailyPoint[]> {
  const rows = await prisma.apiUsage.groupBy({
    by: ['day'],
    where: { day: { gte: start, lte: end } },
    _sum: { callCount: true, cacheHits: true, estCostCents: true },
    orderBy: { day: 'asc' },
  });

  const byDate = new Map<string, DailyPoint>();
  for (const r of rows) {
    byDate.set(isoDate(r.day), {
      date:         isoDate(r.day),
      callCount:    r._sum.callCount    ?? 0,
      cacheHits:    r._sum.cacheHits    ?? 0,
      estCostCents: r._sum.estCostCents ? Number(r._sum.estCostCents) : 0,
    });
  }

  // Walk the full date range and fill zeros for any missing days.
  const out: DailyPoint[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    const key = isoDate(cursor);
    out.push(byDate.get(key) ?? { date: key, callCount: 0, cacheHits: 0, estCostCents: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Per-user usage for a window — used by both the admin drill-in and
 * the self-service `/me/usage` endpoint. Same shape as
 * `getUsageSummary` so the frontend can render either view with one
 * component. Returns null when the user has zero rows in the window
 * (the caller can decide whether that's a 404 or an empty-state).
 */
export async function getUserUsage(
  userId: number,
  start: Date,
  end: Date,
): Promise<UsageSummary | null> {
  // Whitelist the userId condition explicitly — defense-in-depth so a
  // typo in a caller can't accidentally drop the filter and aggregate
  // every user together.
  const whereClause: Prisma.ApiUsageWhereInput = {
    userId,
    day: { gte: start, lte: end },
  };

  const rows = await prisma.apiUsage.groupBy({
    by: ['endpoint'],
    where: whereClause,
    _sum: { callCount: true, cacheHits: true, estCostCents: true },
  });

  if (rows.length === 0) return null;

  const byEndpoint: EndpointBreakdown[] = (Object.keys(GOOGLE_COST_CENTS) as GoogleEndpoint[])
    .map((endpoint) => {
      const row = rows.find((r) => r.endpoint === endpoint);
      const callCount = row?._sum.callCount    ?? 0;
      const cacheHits = row?._sum.cacheHits    ?? 0;
      const costCents = row?._sum.estCostCents ? Number(row._sum.estCostCents) : 0;
      const total = callCount + cacheHits;
      const cacheHitRate = total > 0 ? cacheHits / total : 0;
      return { endpoint, callCount, cacheHits, estCostCents: costCents, cacheHitRate };
    })
    .filter((r) => r.callCount + r.cacheHits > 0)
    .sort((a, b) => b.estCostCents - a.estCostCents);

  const totalCallCount = byEndpoint.reduce((sum, r) => sum + r.callCount, 0);
  const totalCacheHits = byEndpoint.reduce((sum, r) => sum + r.cacheHits, 0);
  const totalCostCents = byEndpoint.reduce((sum, r) => sum + r.estCostCents, 0);
  const totalReq       = totalCallCount + totalCacheHits;
  const cacheHitRate   = totalReq > 0 ? totalCacheHits / totalReq : 0;

  return {
    startDate: isoDate(start),
    endDate:   isoDate(end),
    byEndpoint,
    totalCallCount,
    totalCacheHits,
    totalCostCents,
    cacheHitRate,
  };
}
