// GET /api/admin/usage — operational dashboard for Google Places spend.
//
// Returns rollups over a configurable date window so an admin can
// answer:
//   - How much did we spend yesterday / this week / this month?
//   - What's our overall cache hit rate? Per-endpoint?
//   - Who are the top 20 spenders? (Catching scrapers / runaway clients)
//   - What's the daily timeline look like? (Anomalies, trends)
//   - Drill into one user's usage when something looks off.
//
// All endpoints gated by requireAuth + requireAdmin (mounted upstream).
// No pagination: even at 10k users × 365 days, the groupBy result fits
// trivially; top-N is capped at 100 to keep the response sane.

import { Router, Request, Response } from 'express';
import {
  getUsageSummary,
  getTopSpenders,
  getDailyTimeline,
  getUserUsage,
  windowFromDaysBack,
} from '../../lib/usageQueries';

const router = Router();

// Default lookback windows. Pinned to small list rather than free-form
// `?days=N` to keep the response cacheable + bound query load.
const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_LOOKBACK_DAYS     = 365;

function parseLookback(raw: unknown): number {
  if (typeof raw !== 'string') return DEFAULT_LOOKBACK_DAYS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_LOOKBACK_DAYS;
  return Math.min(parsed, MAX_LOOKBACK_DAYS);
}

// GET /api/admin/usage?days=N
// Headline summary: total spend, cache hit rate, per-endpoint breakdown.
router.get('/', async (req: Request, res: Response) => {
  const daysBack = parseLookback(req.query.days);
  const { start, end } = windowFromDaysBack(daysBack);
  const summary = await getUsageSummary(start, end);
  res.json({ lookbackDays: daysBack, summary });
});

// GET /api/admin/usage/top?days=N&limit=M
// Top spenders by billable cost. Default 20 users, max 100.
router.get('/top', async (req: Request, res: Response) => {
  const daysBack = parseLookback(req.query.days);
  const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
  const limit    = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 100) : 20;
  const { start, end } = windowFromDaysBack(daysBack);
  const topSpenders = await getTopSpenders(start, end, limit);
  res.json({ lookbackDays: daysBack, limit, topSpenders });
});

// GET /api/admin/usage/daily?days=N
// Chart-ready daily timeline. Backfills zeros for sparse days.
router.get('/daily', async (req: Request, res: Response) => {
  const daysBack = parseLookback(req.query.days);
  const { start, end } = windowFromDaysBack(daysBack);
  const timeline = await getDailyTimeline(start, end);
  res.json({ lookbackDays: daysBack, timeline });
});

// GET /api/admin/usage/user/:userId?days=N
// Drill into a single user's usage. Returns 404 when the user has
// zero rows in the window — distinct from 0-spend (which is a valid
// summary). Pass userId=0 to inspect the anonymous photo-proxy bucket.
router.get('/user/:userId', async (req: Request, res: Response) => {
  const userId  = parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId) || userId < 0) {
    res.status(400).json({ error: 'Invalid userId' });
    return;
  }
  const daysBack = parseLookback(req.query.days);
  const { start, end } = windowFromDaysBack(daysBack);
  const usage = await getUserUsage(userId, start, end);
  if (!usage) {
    res.status(404).json({ error: 'No usage recorded for this user in the window' });
    return;
  }
  res.json({ lookbackDays: daysBack, userId, usage });
});

export default router;
