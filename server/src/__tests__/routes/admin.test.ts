import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

// Mock prisma BEFORE the route imports — the admin gate and the
// usage queries both reach into prisma. We control returns per test.
jest.mock('../../lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    apiUsage: { groupBy: jest.fn() },
  },
}));

// Side-effect-free Redis mock so the import chain doesn't connect.
jest.mock('../../lib/redis', () => ({ __esModule: true, default: null }));

import adminRouter from '../../routes/admin';
import prisma from '../../lib/prisma';

const mockPrisma = prisma as unknown as {
  user: { findUnique: jest.Mock; findMany: jest.Mock };
  apiUsage: { groupBy: jest.Mock };
};

const SECRET = process.env.JWT_SECRET!;
const authCookie = (userId = 1) => `token=${jwt.sign({ userId }, SECRET)}`;

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

beforeEach(() => jest.clearAllMocks());

// ── Gate behavior ──────────────────────────────────────────────────

describe('admin gate', () => {
  it('returns 401 without an auth cookie', async () => {
    const res = await request(buildApp()).get('/api/admin/usage');
    expect(res.status).toBe(401);
  });

  it('returns 403 when the user exists but is not admin', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'user' });
    const res = await request(buildApp())
      .get('/api/admin/usage')
      .set('Cookie', authCookie(1));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });

  it('returns 403 when the user no longer exists (defensive)', async () => {
    // A token signed for a deleted user shouldn't slip through —
    // requireAdmin's null-user branch catches it.
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await request(buildApp())
      .get('/api/admin/usage')
      .set('Cookie', authCookie(999));
    expect(res.status).toBe(403);
  });
});

// ── Summary endpoint ───────────────────────────────────────────────

describe('GET /api/admin/usage', () => {
  beforeEach(() => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'admin' });
  });

  it('returns a per-endpoint summary with cache hit rates', async () => {
    mockPrisma.apiUsage.groupBy.mockResolvedValue([
      { endpoint: 'nearby',     _sum: { callCount: 80, cacheHits: 20, estCostCents: 256 } },
      { endpoint: 'photo',      _sum: { callCount: 50, cacheHits: 950, estCostCents: 35  } },
      { endpoint: 'geocode',    _sum: { callCount: 10, cacheHits: 90, estCostCents: 5   } },
    ]);

    const res = await request(buildApp())
      .get('/api/admin/usage')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.lookbackDays).toBe(30); // default
    expect(res.body.summary.byEndpoint).toHaveLength(5); // one row per known endpoint
    // Most expensive endpoint comes first
    expect(res.body.summary.byEndpoint[0].endpoint).toBe('nearby');
    expect(res.body.summary.byEndpoint[0].estCostCents).toBe(256);
    // Cache hit rate = cacheHits / (cacheHits + callCount)
    expect(res.body.summary.byEndpoint[0].cacheHitRate).toBeCloseTo(20 / 100, 5);
    // Photo: 950 / 1000 = 0.95
    const photo = res.body.summary.byEndpoint.find((r: { endpoint: string }) => r.endpoint === 'photo');
    expect(photo.cacheHitRate).toBeCloseTo(0.95, 5);
    // Endpoints with no rows still appear, all zeros
    const text = res.body.summary.byEndpoint.find((r: { endpoint: string }) => r.endpoint === 'textSearch');
    expect(text.callCount).toBe(0);
    expect(text.cacheHitRate).toBe(0);
    // Totals roll up correctly
    expect(res.body.summary.totalCostCents).toBe(296);
  });

  it('honors ?days=N within bounds', async () => {
    mockPrisma.apiUsage.groupBy.mockResolvedValue([]);
    const res = await request(buildApp())
      .get('/api/admin/usage?days=7')
      .set('Cookie', authCookie(1));
    expect(res.status).toBe(200);
    expect(res.body.lookbackDays).toBe(7);
  });

  it('clamps absurd lookbacks to the max', async () => {
    mockPrisma.apiUsage.groupBy.mockResolvedValue([]);
    const res = await request(buildApp())
      .get('/api/admin/usage?days=999999')
      .set('Cookie', authCookie(1));
    expect(res.body.lookbackDays).toBe(365);
  });

  it('falls back to the default for negative/non-numeric input', async () => {
    mockPrisma.apiUsage.groupBy.mockResolvedValue([]);
    const res = await request(buildApp())
      .get('/api/admin/usage?days=-5')
      .set('Cookie', authCookie(1));
    expect(res.body.lookbackDays).toBe(30);
  });
});

// ── Top spenders endpoint ──────────────────────────────────────────

describe('GET /api/admin/usage/top', () => {
  beforeEach(() => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'admin' });
  });

  it('returns top spenders with usernames bulk-resolved', async () => {
    mockPrisma.apiUsage.groupBy.mockResolvedValue([
      { userId: 42, _sum: { callCount: 100, cacheHits: 20, estCostCents: 300 } },
      { userId: 7,  _sum: { callCount: 50,  cacheHits: 10, estCostCents: 150 } },
      { userId: 0,  _sum: { callCount: 25,  cacheHits: 75, estCostCents: 17  } },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 42, username: 'topspender' },
      { id: 7,  username: 'lessactive' },
    ]);

    const res = await request(buildApp())
      .get('/api/admin/usage/top')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.topSpenders).toHaveLength(3);
    expect(res.body.topSpenders[0]).toMatchObject({ userId: 42, username: 'topspender', estCostCents: 300 });
    // Anonymous bucket (userId=0) carries a null username, not a string lookup
    expect(res.body.topSpenders[2]).toMatchObject({ userId: 0, username: null });
  });

  it('caps the limit at 100', async () => {
    mockPrisma.apiUsage.groupBy.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([]);
    const res = await request(buildApp())
      .get('/api/admin/usage/top?limit=500')
      .set('Cookie', authCookie(1));
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
  });
});

// ── Daily timeline endpoint ────────────────────────────────────────

describe('GET /api/admin/usage/daily', () => {
  beforeEach(() => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'admin' });
  });

  it('backfills zeros for days with no usage', async () => {
    // Only one day has rows; the rest of the 7-day window should be
    // zero-filled so the chart renders a continuous timeline.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    mockPrisma.apiUsage.groupBy.mockResolvedValue([
      { day: today, _sum: { callCount: 5, cacheHits: 15, estCostCents: 16 } },
    ]);

    const res = await request(buildApp())
      .get('/api/admin/usage/daily?days=6')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    // 7 inclusive days (days=6 means 6 days back PLUS today)
    expect(res.body.timeline).toHaveLength(7);
    // Today's row carries the real numbers
    const todays = res.body.timeline.find((p: { callCount: number }) => p.callCount === 5);
    expect(todays).toBeDefined();
    // Other rows are zero-filled
    const empties = res.body.timeline.filter((p: { callCount: number }) => p.callCount === 0);
    expect(empties.length).toBe(6);
  });
});

// ── Per-user drill ─────────────────────────────────────────────────

describe('GET /api/admin/usage/user/:userId', () => {
  beforeEach(() => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'admin' });
  });

  it('returns 404 when the user has no recorded usage in the window', async () => {
    mockPrisma.apiUsage.groupBy.mockResolvedValue([]);
    const res = await request(buildApp())
      .get('/api/admin/usage/user/42')
      .set('Cookie', authCookie(1));
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-numeric userId', async () => {
    const res = await request(buildApp())
      .get('/api/admin/usage/user/notanumber')
      .set('Cookie', authCookie(1));
    expect(res.status).toBe(400);
  });

  it('returns the per-endpoint breakdown filtered to active endpoints only', async () => {
    mockPrisma.apiUsage.groupBy.mockResolvedValue([
      { endpoint: 'nearby', _sum: { callCount: 10, cacheHits: 5, estCostCents: 32 } },
    ]);
    const res = await request(buildApp())
      .get('/api/admin/usage/user/42')
      .set('Cookie', authCookie(1));
    expect(res.status).toBe(200);
    // Per-user drill filters to endpoints with > 0 traffic (unlike the
    // global summary which shows all known endpoints), so the response
    // doesn't carry four zero rows per user.
    expect(res.body.usage.byEndpoint).toHaveLength(1);
    expect(res.body.usage.byEndpoint[0].endpoint).toBe('nearby');
  });
});
