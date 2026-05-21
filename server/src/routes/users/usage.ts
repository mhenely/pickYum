// GET /api/users/me/usage — per-user self-service usage rollup.
//
// Mirrors the admin drill-in endpoint but always scoped to the
// requesting user. Foundation for future free-tier limit UX:
//   - "You've used 12 of your 30 nearby searches today" badge
//   - "Upgrade to Pro for unlimited" upsell in the search panel
//   - In-app dashboard if we ever surface usage to users
//
// Lookback defaults to 30 days; supports `?days=N` like the admin
// endpoints. No admin gate — users can always see their own data.

import { Router, Request, Response } from 'express';
import { getUserUsage, windowFromDaysBack } from '../../lib/usageQueries';

const router = Router();

const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_LOOKBACK_DAYS     = 365;

function parseLookback(raw: unknown): number {
  if (typeof raw !== 'string') return DEFAULT_LOOKBACK_DAYS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_LOOKBACK_DAYS;
  return Math.min(parsed, MAX_LOOKBACK_DAYS);
}

router.get('/me/usage', async (req: Request, res: Response) => {
  // requireAuth in the parent router populated req.userId — type
  // assertion is safe because the middleware short-circuits with 401
  // before this handler runs if userId is missing.
  const userId = req.userId as number;
  const daysBack = parseLookback(req.query.days);
  const { start, end } = windowFromDaysBack(daysBack);
  const usage = await getUserUsage(userId, start, end);
  // For first-time users with no calls yet, return a zeroed summary
  // (not 404) so the frontend can render an empty state without
  // distinguishing "you have no data" from "you don't exist."
  if (!usage) {
    res.json({
      lookbackDays: daysBack,
      usage: {
        startDate: start.toISOString().slice(0, 10),
        endDate:   end.toISOString().slice(0, 10),
        byEndpoint: [],
        totalCallCount: 0,
        totalCacheHits: 0,
        totalCostCents: 0,
        cacheHitRate: 0,
      },
    });
    return;
  }
  res.json({ lookbackDays: daysBack, usage });
});

export default router;
