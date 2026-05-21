// Insights aggregator:
//   - GET /me/insights?since=week|month|year|all
//
// Aggregate analytics over the user's acceptance history. Compute in one pass
// over UserAccepted: a single findMany + an in-memory rollup, which is fine
// for any realistic per-user history size (acceptances are sparse).
//
// Auth + writeLimiter are applied by the parent router in ./index.ts.

import { Router, Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { cacheRead, cacheKeyForUser } from '../../lib/serverCache';
import {
  INSIGHT_WINDOW_DAYS,
  INSIGHTS_ALL_TIME_CAP_DAYS,
  NEGLECT_THRESHOLD_DAYS,
  SPARKLINE_WEEKS,
  DAY_MS,
} from '../../config/insights';

// Insights payloads can be cached for ~60s without breaking UX. The
// rollup is over completed history (UserAccepted rows) — users don't
// typically look at insights immediately after accepting a meal, so
// staleness of a single acceptance for up to a minute is invisible.
// At our scale the per-user compute is 4 parallel Prisma queries +
// JS aggregation totalling 100-300ms; cached reads are sub-5ms.
const INSIGHTS_CACHE_TTL_S = 60;

// Re-export so existing tests / docs that import this from the users
// surface still work after the split.
export { INSIGHTS_ALL_TIME_CAP_DAYS };

const router = Router();

// First Sunday cell of the all-time sparkline window. Sunday of the week
// containing today, minus (SPARKLINE_WEEKS − 1) weeks. The current week
// is always the rightmost bucket, with prior weeks marching back in time.
// Aligning the start to Sunday keeps the week boundaries consistent
// across runs. Only used when `since=all` — windowed runs use the
// adaptive strategy in `sparklineWindow()` below.
function sparklineWindowStartUtc(): Date {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sundayOfThisWeek = new Date(todayUtc);
  sundayOfThisWeek.setUTCDate(sundayOfThisWeek.getUTCDate() - todayUtc.getUTCDay());
  const start = new Date(sundayOfThisWeek);
  start.setUTCDate(start.getUTCDate() - (SPARKLINE_WEEKS - 1) * 7);
  return start;
}

// Adaptive bucket strategy for the cuisine sparkline. Returns the start,
// bucket count, and days-per-bucket for the given `since` window so the
// trend line tracks the same time slice as the main rollup above —
// previously sparklines were a fixed 12-week window regardless of picker,
// which contradicted the table totals when the user selected a tighter
// window.
//
//   week  (7d)   → 7 daily buckets
//   month (30d)  → 6 buckets × 5 days
//   year  (365d) → 12 buckets × ~30 days (≈ months)
//   all          → 12 weekly buckets (legacy behavior preserved)
function sparklineWindow(windowDays: number | undefined): {
  start: Date;
  buckets: number;
  daysPerBucket: number;
} {
  if (!windowDays) {
    return { start: sparklineWindowStartUtc(), buckets: SPARKLINE_WEEKS, daysPerBucket: 7 };
  }
  let buckets: number;
  let daysPerBucket: number;
  if (windowDays <= 7) {
    buckets = 7;  daysPerBucket = 1;
  } else if (windowDays <= 30) {
    buckets = 6;  daysPerBucket = 5;
  } else {
    buckets = 12; daysPerBucket = Math.ceil(windowDays / 12);
  }
  // Anchor on UTC start-of-today so buckets are stable across a single
  // request's clock reads. The rightmost bucket includes today.
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = new Date(todayUtc - (buckets * daysPerBucket - 1) * DAY_MS);
  return { start, buckets, daysPerBucket };
}

// GET /api/users/me/insights?since=week|month|year|all
router.get('/me/insights', async (req: Request, res: Response) => {
  const userId = req.userId;
  const sinceParam = typeof req.query.since === 'string' ? req.query.since : 'all';

  // Per-user-per-window cache key. Two users with the same window
  // need separate entries (totally different data); the same user
  // viewing different windows ('week' vs 'month') also needs
  // separate entries.
  const key = cacheKeyForUser('insights', userId as number, sinceParam);
  const payload = await cacheRead(key, INSIGHTS_CACHE_TTL_S, () => computeInsights(userId as number, sinceParam));
  res.json(payload);
});

// Extracted compute function so the route stays a thin cache wrapper.
// All the previous handler logic (parallel fetches, single-pass rollup,
// roll-ups, sparkline binning) lives here unchanged — only the
// `res.json(...)` at the bottom became `return { ... }`.
async function computeInsights(userId: number, sinceParam: string) {
  const windowDays = INSIGHT_WINDOW_DAYS[sinceParam];
  // Resolve the lower-bound timestamp:
  //   - Explicit windowDays ('week'/'month'/'year') → slide from now.
  //   - 'all' (or any unknown value) → cap at INSIGHTS_ALL_TIME_CAP_DAYS
  //     so the rollup stays bounded. Previously this was null (unbounded);
  //     see TIER_2_3_PLAN.md #12 for the rationale.
  const effectiveWindowDays = windowDays ?? INSIGHTS_ALL_TIME_CAP_DAYS;
  const sinceDate = new Date(Date.now() - effectiveWindowDays * 24 * 60 * 60 * 1000);

  // ── Phase 1: kick off every independent query in parallel ────────────
  // These four queries don't depend on each other. Previously they ran
  // sequentially across the handler — for power users the first-paint
  // wait could exceed 400ms. Parallelizing collapses the wait to the
  // single slowest query.
  const sparklineCfg = sparklineWindow(windowDays);
  const sparklineStart = sparklineCfg.start;
  const prevStart = windowDays ? new Date(Date.now() - 2 * windowDays * DAY_MS) : null;
  const prevEnd   = windowDays ? new Date(Date.now() - windowDays * DAY_MS) : null;

  const [rows, favoriteRows, sparklineRows, previousPeriodCountRaw] = await Promise.all([
    prisma.userAccepted.findMany({
      where: {
        userId,
        acceptedAt: { gte: sinceDate },
        // Per-entry opt-out from insights. Excluded rows still appear in
        // History (the user wants the visit logged) but drop out of every
        // aggregation here — totals, breakdowns, weekday heatmap, cuisine
        // trends, sparklines. The other UserAccepted reads below
        // (previousPeriodCount, sparklineRows, neglectedFavorites'
        // lastChosenRows) MUST also filter on this flag or the numbers
        // disagree across panels.
        excludeFromInsights: false,
      },
      select: {
        restaurantId: true,
        acceptedAt: true,
        optionsSnapshot: true,
        chooseMethod: true,
        // Surface eventId + groupId so the Insights page can deep-link recent
        // group-vote acceptances to their ballot detail. Solo acceptances have
        // null event, in which case both fields fall through as null.
        eventId: true,
        event: { select: { groupId: true } },
        restaurant: { select: { id: true, name: true, cuisineType: true } },
      },
      orderBy: { acceptedAt: 'desc' },
    }),
    prisma.userFavorite.findMany({
      where: { userId },
      include: { restaurant: { select: { id: true, name: true, cuisineType: true } } },
    }),
    prisma.userAccepted.findMany({
      where: { userId, acceptedAt: { gte: sparklineStart }, excludeFromInsights: false },
      select: {
        acceptedAt: true,
        restaurant: { select: { cuisineType: true } },
      },
    }),
    // Previous-period count for the "this month vs last month" delta. Only
    // computed when the user is viewing a windowed slice — there's no
    // "previous all-time", so we return null and the UI hides the indicator.
    prevStart && prevEnd
      ? prisma.userAccepted.count({
          where: { userId, acceptedAt: { gte: prevStart, lt: prevEnd }, excludeFromInsights: false },
        })
      : Promise.resolve(0),
  ]);

  // Single-pass roll-up.
  //
  // The original code iterated rows twice — once for wins/considered/methods,
  // then a second pass purely for cuisine-considered totals (because the
  // cuisineType for non-winner snapshot ids wasn't known until after the
  // filler-restaurant lookup). We can fold both passes into one by:
  //   1. Pre-collecting every snapshot id (and the winner ids).
  //   2. Building a single restaurantId → cuisineType map up front, using
  //      the joined `row.restaurant` for winners and a SINGLE batched
  //      findMany for the rest. (One query — same DB cost.)
  //   3. A single pass over rows that bumps wins + considered AND rolls up
  //      cuisineConsidered / cuisineChosen / methodCounts / weekdayCounts
  //      all at once.
  // On a power user with 200 acceptances × 5-id snapshots, this halves the
  // JS-side work (~1000 → ~500 ops in the hot loop).
  type RestStat = { name: string | null; cuisineType: string | null; considered: number; wins: number };

  // 1. Pre-collect every restaurant id that will need cuisine resolution.
  const allReferencedIds = new Set<string>();
  for (const row of rows) {
    allReferencedIds.add(String(row.restaurantId));
    if (Array.isArray(row.optionsSnapshot)) {
      for (const id of row.optionsSnapshot as unknown[]) {
        const idStr = String(id);
        if (idStr) allReferencedIds.add(idStr);
      }
    }
  }

  // 2. Seed the metadata map from joined winners; whatever's left needs one
  // batched lookup. Numeric guard skips custom-string IDs that won't have
  // a Restaurant row anyway.
  const restaurantMeta = new Map<string, { name: string | null; cuisineType: string | null }>();
  for (const row of rows) {
    if (row.restaurant) {
      restaurantMeta.set(String(row.restaurantId), {
        name: row.restaurant.name,
        cuisineType: row.restaurant.cuisineType,
      });
    }
  }
  const missingNumericIds = [...allReferencedIds]
    .filter((id) => !restaurantMeta.has(id))
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (missingNumericIds.length > 0) {
    const fillers = await prisma.restaurant.findMany({
      where:  { id: { in: missingNumericIds } },
      select: { id: true, name: true, cuisineType: true },
    });
    for (const r of fillers) {
      restaurantMeta.set(String(r.id), { name: r.name, cuisineType: r.cuisineType });
    }
  }

  // 3. Single pass: wins + considered + method + cuisine + weekday all at once.
  const stats = new Map<string, RestStat>();
  const ensure = (id: string): RestStat => {
    let entry = stats.get(id);
    if (!entry) {
      const meta = restaurantMeta.get(id);
      entry = { name: meta?.name ?? null, cuisineType: meta?.cuisineType ?? null, considered: 0, wins: 0 };
      stats.set(id, entry);
    }
    return entry;
  };

  const methodCounts: Record<string, number> = {};
  const cuisineConsidered: Record<string, number> = {};
  const cuisineChosen: Record<string, number> = {};
  // Index 0=Sunday … 6=Saturday, matching JS getDay(). We bucket by UTC day
  // because acceptedAt is stored as UTC; this is "close enough" for most users
  // and we can revisit with a tz param later if it matters.
  const weekdayCounts: number[] = [0, 0, 0, 0, 0, 0, 0];

  for (const row of rows) {
    const winnerId = String(row.restaurantId);
    const winnerEntry = ensure(winnerId);
    winnerEntry.wins += 1;
    if (winnerEntry.cuisineType) {
      cuisineChosen[winnerEntry.cuisineType] = (cuisineChosen[winnerEntry.cuisineType] ?? 0) + 1;
    }

    if (Array.isArray(row.optionsSnapshot)) {
      for (const id of row.optionsSnapshot as unknown[]) {
        const idStr = String(id);
        if (!idStr) continue;
        const entry = ensure(idStr);
        entry.considered += 1;
        if (entry.cuisineType) {
          cuisineConsidered[entry.cuisineType] = (cuisineConsidered[entry.cuisineType] ?? 0) + 1;
        }
      }
    }

    const method = row.chooseMethod ?? 'unknown';
    methodCounts[method] = (methodCounts[method] ?? 0) + 1;
    weekdayCounts[row.acceptedAt.getUTCDay()] += 1;
  }

  // ── Roll-ups ──
  const all = [...stats.entries()]
    .filter(([, v]) => v.considered > 0 || v.wins > 0)
    .map(([id, v]) => ({
      restaurantId: id,
      name: v.name ?? `Restaurant #${id}`,
      cuisineType: v.cuisineType,
      considered: v.considered,
      wins: v.wins,
      winRate: v.considered > 0 ? v.wins / v.considered : (v.wins > 0 ? 1 : 0),
    }));

  const topConsidered = [...all]
    .filter((r) => r.considered > 0)
    .sort((a, b) => b.considered - a.considered)
    .slice(0, 5);

  // "Often considered, never chosen" — entries with ≥ 2 considerations and 0 wins.
  // A threshold of 2 filters out one-off pool entries and surfaces real avoidance.
  const oftenSkipped = [...all]
    .filter((r) => r.considered >= 2 && r.wins === 0)
    .sort((a, b) => b.considered - a.considered)
    .slice(0, 5);

  const recent = rows.slice(0, 8).map((r) => ({
    restaurantId: String(r.restaurantId),
    name: r.restaurant?.name ?? `Restaurant #${r.restaurantId}`,
    acceptedAt: r.acceptedAt,
    chooseMethod: r.chooseMethod ?? null,
    // Present only when the acceptance came from a group event (post-rollout).
    // The page uses both ids together to deep-link into the ballot modal.
    eventId: r.eventId ?? null,
    groupId: r.event?.groupId ?? null,
    competing: Array.isArray(r.optionsSnapshot)
      ? (r.optionsSnapshot as unknown[])
          .map(String)
          .filter((id) => id !== String(r.restaurantId))
          .map((id) => stats.get(id)?.name ?? `Restaurant #${id}`)
      : [],
  }));

  // ── Variety score ──────────────────────────────────────────
  // Ratio of distinct restaurants chosen to total decisions, scaled to 0–10
  // and rounded to one decimal. "10/10" means every decision was a different
  // restaurant; "1/10" means you keep going to the same place.
  const totalDecisions   = rows.length;
  const distinctChosen   = new Set(rows.map((r) => r.restaurantId)).size;
  const varietyScore = totalDecisions > 0
    ? Math.round((distinctChosen / totalDecisions) * 100) / 10
    : 0;

  // ── Neglected favorites ────────────────────────────────────
  // Restaurants the user has favorited but hasn't picked in NEGLECT_THRESHOLD_DAYS
  // (or has never picked at all). This is computed against ALL UserAccepted —
  // not the current `since` window — because the whole point is "you haven't
  // chosen this in a long time," which only makes sense over full history.
  // favoriteRows was prefetched in Phase 1 above.
  let neglectedFavorites: Array<{
    restaurantId: string;
    name: string;
    cuisineType: string | null;
    lastChosenAt: string | null;
  }> = [];

  if (favoriteRows.length > 0) {
    const favIds = favoriteRows.map((f) => f.restaurantId);
    const lastChosenRows = (await prisma.userAccepted.groupBy({
      by: ['restaurantId'],
      // Excluded picks shouldn't count as "you chose this" for the neglect
      // calculation — a user who marks every visit to a place as off-the-record
      // intends for the place to feel un-chosen here too.
      where: { userId, restaurantId: { in: favIds }, excludeFromInsights: false },
      _max: { acceptedAt: true },
    })) ?? [];
    const lastChosen = new Map<number, Date>();
    for (const row of lastChosenRows) {
      if (row._max.acceptedAt) lastChosen.set(row.restaurantId, row._max.acceptedAt);
    }

    const cutoff = Date.now() - NEGLECT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
    neglectedFavorites = favoriteRows
      .map((f) => {
        const last = lastChosen.get(f.restaurantId) ?? null;
        return {
          restaurantId: String(f.restaurantId),
          name: f.restaurant.name,
          cuisineType: f.restaurant.cuisineType,
          lastChosenAt: last ? last.toISOString() : null,
          // Stash the raw timestamp for sorting; stripped before sending out
          _sortKey: last ? last.getTime() : -Infinity,
        };
      })
      .filter((f) => f._sortKey < cutoff)
      // Oldest (or never-chosen) first — the most "neglected" entry leads.
      .sort((a, b) => a._sortKey - b._sortKey)
      .slice(0, 5)
      // Drop the sort-only field on the way out
      .map(({ _sortKey: _unused, ...rest }) => rest);
  }

  // ── Cuisine sparklines — adaptive buckets for the current window ───────
  // sparklineRows was prefetched in Phase 1 above. Bucket index 0 is the
  // oldest, so the sparkline reads left-to-right oldest→newest. Bucket
  // count / span comes from sparklineWindow() so the trend tracks the
  // same time slice as the rollup table — previously the sparkline was
  // hard-coded to 12 weeks regardless of `since`.
  const bucketMs = sparklineCfg.daysPerBucket * DAY_MS;
  const cuisineWeekly = new Map<string, number[]>();
  for (const row of sparklineRows) {
    const cuisine = row.restaurant?.cuisineType;
    if (!cuisine) continue; // skip uncategorized — the sparkline is per-cuisine
    if (!cuisineWeekly.has(cuisine)) {
      cuisineWeekly.set(cuisine, Array(sparklineCfg.buckets).fill(0));
    }
    const bucketIdx = Math.min(
      sparklineCfg.buckets - 1,
      Math.max(0, Math.floor((row.acceptedAt.getTime() - sparklineStart.getTime()) / bucketMs)),
    );
    cuisineWeekly.get(cuisine)![bucketIdx] += 1;
  }
  // Top 5 cuisines by total acceptances in the window — matches the cuisine
  // table above. Cuisines that appear in `cuisineChosen` but had zero
  // acceptances in the trend window are excluded (a flat-zero sparkline is
  // not informative).
  const cuisineWeeklyCounts: Record<string, number[]> = {};
  [...cuisineWeekly.entries()]
    .map(([cuisine, weeks]) => ({ cuisine, total: weeks.reduce((a, b) => a + b, 0), weeks }))
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .forEach((x) => { cuisineWeeklyCounts[x.cuisine] = x.weeks; });

  // ── Previous-period count (for "this month vs last month" delta) ──────
  // previousPeriodCountRaw was prefetched in Phase 1; the UI hides the
  // indicator when no window is in effect, so we surface null in that case.
  const previousPeriodCount: number | null = windowDays ? (previousPeriodCountRaw ?? 0) : null;

  return {
    totalDecisions,
    distinctChosen,
    varietyScore,
    since: sinceParam,
    previousPeriodCount,
    methodCounts,
    cuisineConsidered,
    cuisineChosen,
    cuisineWeeklyCounts,
    weekdayCounts,
    topConsidered,
    oftenSkipped,
    neglectedFavorites,
    recent,
  };
}

export default router;
