import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { DeepMockProxy } from 'jest-mock-extended';

jest.mock('../../lib/prisma');

import prisma from '../../lib/prisma';
import usersRouter from '../../routes/users';

const mockPrisma = prisma as unknown as DeepMockProxy<PrismaClient>;
const SECRET = process.env.JWT_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/users', usersRouter);
  return app;
}

const authCookie = (userId = 1) => `token=${jwt.sign({ userId }, SECRET)}`;

// Default safety mocks for the new privacy + transactional code paths:
//   1. The privacy gate on /me/favorites, /me/options, /me/archived,
//      /me/accepted, /me/reviews calls `prisma.restaurant.findUnique`.
//      Without a mock it'd resolve to undefined and every write returns
//      404. Default to a public row; gate-specific tests can override.
//   2. recomputeCommunityRating now runs inside `prisma.$transaction`
//      with an advisory lock. Tests that mock `review.groupBy` etc.
//      expect to see calls on the same mock client. We re-route the
//      interactive form so the inner callback runs against `mockPrisma`;
//      the array form is left to return undefined (tests that depend on
//      its result still mock explicitly).
beforeEach(() => {
  (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
    id: 1, private: false, createdBy: null,
  });
  (mockPrisma.$transaction as jest.Mock).mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: typeof mockPrisma) => Promise<unknown>)(mockPrisma);
    }
    return undefined;
  });
  // The advisory-lock SELECT is a no-op for tests; just resolve.
  (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(0);
  // Drop the per-restaurant refresh locks so a test that hits
  // refreshOnePlace(restaurantId=N) doesn't leave a lock around to
  // block the next test from doing the same. Production code never
  // calls this — the locks just naturally expire after 5 min.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('../../routes/users') as { _resetRefreshLocksForTests: () => void })
    ._resetRefreshLocksForTests();
});

describe('POST /api/users/me/flip', () => {
  it('returns 401 without a token', async () => {
    const res = await request(buildApp()).post('/api/users/me/flip');
    expect(res.status).toBe(401);
  });

  it('increments flipCount and returns it', async () => {
    (mockPrisma.user.update as jest.Mock).mockResolvedValue({ flipCount: 5 });

    const res = await request(buildApp())
      .post('/api/users/me/flip')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.flipCount).toBe(5);
  });
});

// ── Split bootstrap endpoints ────────────────────────────────
// /me/identity + /me/data replace /me/all (which is now a deprecated alias).
// Identity is the fast critical-path (user + favoriteIds + defaultListId);
// data is everything else. Modern client fires both in parallel; old
// clients still get /me/all as a back-compat shim.

describe('GET /api/users/me/identity', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/users/me/identity');
    expect(res.status).toBe(401);
  });

  it('returns the user identity + defaultListId + favoriteIds', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 1, email: 'a@b.c', username: 'alice', flipCount: 7,
      avatarUrl: null, role: 'user', emailVerified: true,
    });
    (mockPrisma.favoriteList.findFirst as jest.Mock).mockResolvedValue({
      id: 42, entries: [{ restaurantId: 10 }, { restaurantId: 11 }],
    });

    const res = await request(buildApp())
      .get('/api/users/me/identity')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 1, username: 'alice', flipCount: 7 });
    expect(res.body.defaultListId).toBe(42);
    expect(res.body.favoriteIds).toEqual([10, 11]);
  });

  it('creates a default list when none exists (bootstrap)', async () => {
    // A legacy account (or a freshly-deleted-everything case) should
    // still get a valid defaultListId — ensureDefaultFavoriteList runs.
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 2, email: 'b@c.d', username: 'bob', flipCount: 0,
      avatarUrl: null, role: 'user', emailVerified: false,
    });
    (mockPrisma.favoriteList.findFirst as jest.Mock)
      .mockResolvedValueOnce(null) // none exists initially
      .mockResolvedValueOnce({ id: 99, isDefault: true, userId: 2, name: 'My Favorites' }); // ensureDefault's lookup
    (mockPrisma.favoriteList.create as jest.Mock).mockResolvedValue({ id: 99 });

    const res = await request(buildApp())
      .get('/api/users/me/identity')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.defaultListId).toBeGreaterThan(0);
    expect(res.body.favoriteIds).toEqual([]);
  });

  it('returns 404 when the user row vanishes mid-flight', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.favoriteList.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(buildApp())
      .get('/api/users/me/identity')
      .set('Cookie', authCookie());

    expect(res.status).toBe(404);
  });
});

describe('GET /api/users/me/data', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/users/me/data');
    expect(res.status).toBe(401);
  });

  it('returns the extended payload (restaurants + all collections)', async () => {
    // Shared fixtures for every collection query the route fires.
    (mockPrisma.userFavorite.findMany   as jest.Mock).mockResolvedValue([]);
    (mockPrisma.userOption.findMany     as jest.Mock).mockResolvedValue([]);
    (mockPrisma.userAccepted.findMany   as jest.Mock).mockResolvedValue([]);
    (mockPrisma.userArchive.findMany    as jest.Mock).mockResolvedValue([]);
    (mockPrisma.review.findMany         as jest.Mock).mockResolvedValue([]);
    (mockPrisma.savedAddress.findMany   as jest.Mock).mockResolvedValue([]);
    (mockPrisma.favoriteList.findMany   as jest.Mock).mockResolvedValue([
      { id: 1, userId: 1, groupId: null, name: 'My Favorites', description: null,
        color: null, isDefault: true, position: 0, createdAt: new Date(),
        entries: [] },
    ]);
    (mockPrisma.restaurant.findMany     as jest.Mock).mockResolvedValue([]);

    const res = await request(buildApp())
      .get('/api/users/me/data')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.apiVersion).toBe(2);
    expect(res.body).toHaveProperty('restaurants');
    expect(res.body).toHaveProperty('favoriteIds');
    expect(res.body).toHaveProperty('optionIds');
    expect(res.body).toHaveProperty('archivedIds');
    expect(res.body).toHaveProperty('acceptedEntries');
    expect(res.body).toHaveProperty('reviews');
    expect(res.body).toHaveProperty('addresses');
    expect(res.body).toHaveProperty('favoriteLists');
    // Does NOT include identity fields — those live on /me/identity.
    expect(res.body).not.toHaveProperty('user');
    expect(res.body).not.toHaveProperty('email');
  });
});

describe('POST /api/users/me/favorites/:restaurantId', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).post('/api/users/me/favorites/1');
    expect(res.status).toBe(401);
  });

  it('returns 400 for a non-integer restaurantId', async () => {
    const res = await request(buildApp())
      .post('/api/users/me/favorites/abc')
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
  });

  it('returns 201 when favorite is added', async () => {
    (mockPrisma.userFavorite.upsert as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .post('/api/users/me/favorites/10')
      .set('Cookie', authCookie());

    expect(res.status).toBe(201);
  });
});

describe('DELETE /api/users/me/favorites/:restaurantId', () => {
  it('returns 200 and removes the favorite', async () => {
    (mockPrisma.userFavorite.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const res = await request(buildApp())
      .delete('/api/users/me/favorites/10')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
  });
});

describe('POST /api/users/me/options/:restaurantId', () => {
  it('returns 201 when option is added', async () => {
    (mockPrisma.userOption.upsert as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .post('/api/users/me/options/7')
      .set('Cookie', authCookie());

    expect(res.status).toBe(201);
  });
});

describe('DELETE /api/users/me/options/:restaurantId', () => {
  it('returns 200 and removes the option', async () => {
    (mockPrisma.userOption.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const res = await request(buildApp())
      .delete('/api/users/me/options/7')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/users/me', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).delete('/api/users/me');
    expect(res.status).toBe(401);
  });

  it('deletes the user, clears the token cookie, and returns 200', async () => {
    (mockPrisma.review.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.user.delete as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .delete('/api/users/me')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Account deleted');
    expect(mockPrisma.user.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    // Must clear the cookie under the same name auth.ts sets it ('token'),
    // not the old 'sid' name that left orphaned JWTs.
    const setCookie = res.headers['set-cookie'] as unknown as string[] | string;
    const headerStr = Array.isArray(setCookie) ? setCookie.join('\n') : (setCookie ?? '');
    expect(headerStr).toMatch(/^token=/m);
    expect(headerStr).not.toMatch(/^sid=/m);
  });

  it('anonymizes reviews by default (no review.deleteMany before user.delete)', async () => {
    (mockPrisma.review.findMany as jest.Mock).mockResolvedValue([
      { restaurantId: 11 },
      { restaurantId: 22 },
    ]);
    (mockPrisma.user.delete as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .delete('/api/users/me')
      .set('Cookie', authCookie())
      .send({});

    expect(res.status).toBe(200);
    // No explicit review delete — the FK cascade (SetNull) handles anonymization
    expect(mockPrisma.review.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.user.delete).toHaveBeenCalled();
  });

  it('retracts reviews when retractReviews=true (deletes review rows before user.delete)', async () => {
    (mockPrisma.review.findMany as jest.Mock).mockResolvedValue([
      { restaurantId: 11 },
    ]);
    (mockPrisma.review.deleteMany as jest.Mock).mockResolvedValue({ count: 3 });
    (mockPrisma.user.delete as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .delete('/api/users/me')
      .set('Cookie', authCookie())
      .send({ retractReviews: true });

    expect(res.status).toBe(200);
    // Server should delete reviews up front so they don't hit the SetNull cascade
    expect(mockPrisma.review.deleteMany).toHaveBeenCalledWith({ where: { userId: 1 } });
    expect(mockPrisma.user.delete).toHaveBeenCalled();
  });

  it('triggers communityRating recompute for every distinct restaurant the user reviewed', async () => {
    (mockPrisma.review.findMany as jest.Mock).mockResolvedValue([
      { restaurantId: 11 },
      { restaurantId: 22 },
      { restaurantId: 33 },
    ]);
    (mockPrisma.review.groupBy as jest.Mock).mockResolvedValue([]);
    (mockPrisma.user.delete as jest.Mock).mockResolvedValue({});
    (mockPrisma.restaurant.update as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .delete('/api/users/me')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    // findMany on review is called twice per restaurant (one for the route's
    // "what did this user touch" pass, three for recomputeCommunityRating's
    // orphan-row lookup). Asserting on restaurant.update is the cleanest
    // signal: one update per distinct restaurant the user reviewed.
    // Use await + tiny tick so the fire-and-forget recomputes settle.
    await new Promise((r) => setTimeout(r, 10));
    const updatedRestaurantIds = (mockPrisma.restaurant.update as jest.Mock).mock.calls
      .map((args: [{ where: { id: number } }]) => args[0].where.id)
      .sort();
    expect(updatedRestaurantIds).toEqual([11, 22, 33]);
  });
});

describe('DELETE /api/users/me/history/:restaurantId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).delete('/api/users/me/history/5');
    expect(res.status).toBe(401);
  });

  it('returns 400 for non-integer restaurant id', async () => {
    const res = await request(buildApp())
      .delete('/api/users/me/history/abc')
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
  });

  it('atomically deletes from all five tables in a transaction', async () => {
    (mockPrisma.review.count as jest.Mock).mockResolvedValue(2);
    (mockPrisma.$transaction as jest.Mock).mockResolvedValue([{}, {}, {}, {}, {}]);
    (mockPrisma.review.groupBy as jest.Mock).mockResolvedValue([]);
    (mockPrisma.restaurant.update as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .delete('/api/users/me/history/5')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Removed from history');
    // The five table-deletes ride in one `$transaction([...])`. We don't
    // assert on the total $transaction call count anymore — the recompute
    // now fires a separate interactive transaction in the background, so
    // the count is non-deterministic at this synchronous assertion point.
    expect(mockPrisma.userFavorite.deleteMany).toHaveBeenCalledWith({ where: { userId: 1, restaurantId: 5 } });
    expect(mockPrisma.userOption.deleteMany).toHaveBeenCalledWith({ where: { userId: 1, restaurantId: 5 } });
    expect(mockPrisma.userArchive.deleteMany).toHaveBeenCalledWith({ where: { userId: 1, restaurantId: 5 } });
    expect(mockPrisma.userAccepted.deleteMany).toHaveBeenCalledWith({ where: { userId: 1, restaurantId: 5 } });
    expect(mockPrisma.review.deleteMany).toHaveBeenCalledWith({ where: { userId: 1, restaurantId: 5 } });
  });

  it('skips community-rating recompute when the user had no reviews', async () => {
    (mockPrisma.review.count as jest.Mock).mockResolvedValue(0);
    (mockPrisma.$transaction as jest.Mock).mockResolvedValue([{}, {}, {}, {}, {}]);

    const res = await request(buildApp())
      .delete('/api/users/me/history/5')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    // No recompute fired — review.groupBy is the first call inside it
    expect(mockPrisma.review.groupBy).not.toHaveBeenCalled();
  });
});

describe('POST /api/users/me/reviews — community rating side effect', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 for missing required fields', async () => {
    const res = await request(buildApp())
      .post('/api/users/me/reviews')
      .set('Cookie', authCookie())
      .send({ restaurantId: 1 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for out-of-range rating', async () => {
    const res = await request(buildApp())
      .post('/api/users/me/reviews')
      .set('Cookie', authCookie())
      .send({ restaurantId: 1, rating: 6 });
    expect(res.status).toBe(400);
  });

  it('creates the review and fires recomputeCommunityRating in the background', async () => {
    (mockPrisma.review.create as jest.Mock).mockResolvedValue({
      id: 42, userId: 1, restaurantId: 5, rating: 4, content: 'Solid', createdAt: new Date(),
      restaurant: { id: 5, name: 'Pizza Place' },
    });
    // Per-user averages for currently-registered users.
    (mockPrisma.review.groupBy as jest.Mock).mockResolvedValue([
      { userId: 1, _avg: { rating: 4 } },
      { userId: 2, _avg: { rating: 5 } },
    ]);
    // Orphan reviews (from deleted accounts) — none in this scenario.
    (mockPrisma.review.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.restaurant.update as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .post('/api/users/me/reviews')
      .set('Cookie', authCookie())
      .send({ restaurantId: 5, rating: 4, content: 'Solid' });

    expect(res.status).toBe(201);
    expect(res.body.review.id).toBe(42);

    // recomputeCommunityRating fires async — wait a tick for it to run
    await new Promise((r) => setImmediate(r));
    // The new groupBy filters out null-user rows (those are handled separately
    // as orphans). Existing test pre-rollout asserted on the un-filtered shape.
    expect(mockPrisma.review.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ['userId'],
      where: { restaurantId: 5, userId: { not: null } },
    }));
    expect(mockPrisma.restaurant.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { communityRating: 4.5 }, // (4 + 5) / 2
    });
  });

  it('mixes orphan reviews into the community average (one bucket per orphan row)', async () => {
    (mockPrisma.review.create as jest.Mock).mockResolvedValue({
      id: 99, userId: 1, restaurantId: 5, rating: 5, content: null, createdAt: new Date(),
      restaurant: { id: 5, name: 'Pizza Place' },
    });
    // Two real users (avg 4 each) plus two orphan rows from deleted accounts.
    (mockPrisma.review.groupBy as jest.Mock).mockResolvedValue([
      { userId: 1, _avg: { rating: 4 } },
      { userId: 2, _avg: { rating: 4 } },
    ]);
    (mockPrisma.review.findMany as jest.Mock).mockResolvedValue([
      { rating: 5 },
      { rating: 3 },
    ]);
    (mockPrisma.restaurant.update as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .post('/api/users/me/reviews')
      .set('Cookie', authCookie())
      .send({ restaurantId: 5, rating: 5 });

    expect(res.status).toBe(201);
    await new Promise((r) => setImmediate(r));
    // (4 + 4 + 5 + 3) / 4 = 4.0 — orphans count individually, real users group.
    expect(mockPrisma.restaurant.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { communityRating: 4 },
    });
  });

  it('sets communityRating to null when no reviews remain after delete', async () => {
    (mockPrisma.review.findFirst as jest.Mock).mockResolvedValue({ restaurantId: 7 });
    (mockPrisma.review.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
    (mockPrisma.review.groupBy as jest.Mock).mockResolvedValue([]); // no reviewers left
    (mockPrisma.review.findMany as jest.Mock).mockResolvedValue([]); // no orphans either
    (mockPrisma.restaurant.update as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .delete('/api/users/me/reviews/42')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(mockPrisma.restaurant.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { communityRating: null },
    });
  });
});

describe('PATCH /api/users/me/dietary-tags', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockPrisma.user.update as jest.Mock).mockImplementation(async (args) => ({
      id: 1,
      dietaryTags: args.data.dietaryTags?.set ?? [],
    }));
  });

  it('persists a clean list and echoes back what the server stored', async () => {
    const res = await request(buildApp())
      .patch('/api/users/me/dietary-tags')
      .set('Cookie', authCookie())
      .send({ tags: ['vegan', 'gluten-free'] });

    expect(res.status).toBe(200);
    expect(res.body.user.dietaryTags).toEqual(['vegan', 'gluten-free']);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 1 },
      data:  { dietaryTags: { set: ['vegan', 'gluten-free'] } },
    }));
  });

  it('normalizes input: trims, lowercases, and dedupes', async () => {
    const res = await request(buildApp())
      .patch('/api/users/me/dietary-tags')
      .set('Cookie', authCookie())
      .send({ tags: ['  VEGAN  ', 'vegan', 'Vegan', 'gluten-free'] });

    expect(res.status).toBe(200);
    const call = (mockPrisma.user.update as jest.Mock).mock.calls[0][0];
    expect(call.data.dietaryTags.set).toEqual(['vegan', 'gluten-free']);
  });

  it('drops empty / whitespace-only entries silently', async () => {
    const res = await request(buildApp())
      .patch('/api/users/me/dietary-tags')
      .set('Cookie', authCookie())
      .send({ tags: ['halal', '', '   ', 'kosher'] });

    expect(res.status).toBe(200);
    const call = (mockPrisma.user.update as jest.Mock).mock.calls[0][0];
    expect(call.data.dietaryTags.set).toEqual(['halal', 'kosher']);
  });

  it('drops non-string entries instead of failing the whole request', async () => {
    const res = await request(buildApp())
      .patch('/api/users/me/dietary-tags')
      .set('Cookie', authCookie())
      // 42, null, true → filtered out; only 'vegan' survives.
      .send({ tags: [42, null, true, 'vegan'] });

    expect(res.status).toBe(200);
    const call = (mockPrisma.user.update as jest.Mock).mock.calls[0][0];
    expect(call.data.dietaryTags.set).toEqual(['vegan']);
  });

  it('drops tags longer than 40 characters', async () => {
    const tooLong = 'a'.repeat(41);
    const res = await request(buildApp())
      .patch('/api/users/me/dietary-tags')
      .set('Cookie', authCookie())
      .send({ tags: ['vegan', tooLong] });

    expect(res.status).toBe(200);
    const call = (mockPrisma.user.update as jest.Mock).mock.calls[0][0];
    expect(call.data.dietaryTags.set).toEqual(['vegan']);
  });

  it('rejects payloads over the 10-tag cap before touching the DB', async () => {
    const elevenTags = Array.from({ length: 11 }, (_, i) => `tag-${i}`);
    const res = await request(buildApp())
      .patch('/api/users/me/dietary-tags')
      .set('Cookie', authCookie())
      .send({ tags: elevenTags });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maximum of 10/i);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('accepts an empty array to clear all tags', async () => {
    const res = await request(buildApp())
      .patch('/api/users/me/dietary-tags')
      .set('Cookie', authCookie())
      .send({ tags: [] });

    expect(res.status).toBe(200);
    expect(res.body.user.dietaryTags).toEqual([]);
  });

  it('rejects 400 when `tags` is not an array', async () => {
    const res = await request(buildApp())
      .patch('/api/users/me/dietary-tags')
      .set('Cookie', authCookie())
      .send({ tags: 'vegan' });

    expect(res.status).toBe(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('returns 401 without an auth cookie', async () => {
    const res = await request(buildApp())
      .patch('/api/users/me/dietary-tags')
      .send({ tags: ['vegan'] });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/users/me/export', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The /me/export route makes ~13 parallel prisma queries. Every one
    // is hit via Promise.all, so leaving any unmocked surfaces as
    // "TypeError: fn is not a function" and fails the whole route. Stub
    // each to an empty list / minimal happy-path shape; individual tests
    // override the bits they care about.
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 1, email: 'alice@example.com', username: 'alice',
      dietaryTags: ['vegan'], avatarUrl: null, emailVerified: true,
      flipCount: 7, createdAt: new Date('2026-01-01'),
    });
    (mockPrisma.userFavorite.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.userOption.findMany   as jest.Mock).mockResolvedValue([]);
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.userArchive.findMany  as jest.Mock).mockResolvedValue([]);
    (mockPrisma.review.findMany       as jest.Mock).mockResolvedValue([]);
    (mockPrisma.savedAddress.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.favoriteList.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.group.findMany        as jest.Mock).mockResolvedValue([]);
    (mockPrisma.groupMember.findMany  as jest.Mock).mockResolvedValue([]);
    (mockPrisma.trip.findMany         as jest.Mock).mockResolvedValue([]);
    (mockPrisma.tripMember.findMany   as jest.Mock).mockResolvedValue([]);
    (mockPrisma.recommendation.findMany as jest.Mock).mockResolvedValue([]);
  });

  it('returns a downloadable JSON attachment with a date-stamped filename', async () => {
    const res = await request(buildApp())
      .get('/api/users/me/export')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    // Content-Disposition is the load-bearing piece: without it, browsers
    // render the JSON inline instead of saving to disk.
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="pickyum-export-\d{4}-\d{2}-\d{2}\.json"$/);
    // schemaVersion lets clients (or future migration scripts) detect the
    // export format. Bumping it is the contract for any breaking change.
    expect(res.body.schemaVersion).toBe(1);
    expect(typeof res.body.exportedAt).toBe('string');
  });

  it('includes the user profile + all known collections (empty by default)', async () => {
    const res = await request(buildApp())
      .get('/api/users/me/export')
      .set('Cookie', authCookie());

    expect(res.body.profile).toMatchObject({
      id: 1, email: 'alice@example.com', username: 'alice',
      dietaryTags: ['vegan'], emailVerified: true,
    });
    // Top-level keys are the GDPR-relevant categories — if any go missing
    // a future "missing fields" complaint will land here first.
    for (const key of [
      'favorites', 'options', 'accepted', 'archived', 'reviews',
      'savedAddresses', 'favoriteLists',
    ]) {
      expect(res.body[key]).toEqual([]);
    }
    expect(res.body.groups).toEqual({ hosted: [], member: [] });
    expect(res.body.trips).toEqual({ hosted: [], member: [] });
    expect(res.body.recommendations).toEqual({ outgoing: [], incoming: [] });
  });

  it('separates hosted groups from member groups in the output', async () => {
    (mockPrisma.group.findMany as jest.Mock).mockResolvedValue([
      {
        id: 5, name: 'Lunch crew', archivedAt: null, createdAt: new Date(),
        members: [{ user: { username: 'bob' } }, { user: { username: 'carol' } }],
        events:  [],
      },
    ]);
    (mockPrisma.groupMember.findMany as jest.Mock).mockResolvedValue([
      {
        joinedAt: new Date(),
        group: {
          id: 9, name: 'Pizza Friday', archivedAt: null,
          host: { username: 'dan' },
          events: [],
        },
      },
    ]);

    const res = await request(buildApp())
      .get('/api/users/me/export')
      .set('Cookie', authCookie());

    expect(res.body.groups.hosted).toHaveLength(1);
    expect(res.body.groups.hosted[0]).toMatchObject({
      id: 5, name: 'Lunch crew',
      members: ['bob', 'carol'],
    });
    expect(res.body.groups.member).toHaveLength(1);
    expect(res.body.groups.member[0]).toMatchObject({
      id: 9, name: 'Pizza Friday', host: 'dan',
    });
  });

  it('separates hosted trips from member trips and includes anchors', async () => {
    (mockPrisma.trip.findMany as jest.Mock).mockResolvedValue([
      {
        id: 5, name: 'Italy 2026', destination: 'Rome',
        startDate: null, endDate: null, archivedAt: null,
        members: [{ user: { username: 'bob' } }],
        anchors: [{ label: 'Hotel', address: 'Rome' }],
        events:  [],
      },
    ]);
    (mockPrisma.tripMember.findMany as jest.Mock).mockResolvedValue([
      {
        joinedAt: new Date(),
        trip: {
          id: 9, name: 'NYC weekend', destination: 'New York',
          host: { username: 'dan' }, events: [],
        },
      },
    ]);

    const res = await request(buildApp())
      .get('/api/users/me/export')
      .set('Cookie', authCookie());

    expect(res.body.trips.hosted).toHaveLength(1);
    expect(res.body.trips.hosted[0]).toMatchObject({
      id: 5, name: 'Italy 2026', destination: 'Rome',
      members: ['bob'],
      anchors: [{ label: 'Hotel', address: 'Rome' }],
    });
    expect(res.body.trips.member).toHaveLength(1);
    expect(res.body.trips.member[0]).toMatchObject({
      id: 9, host: 'dan',
    });
  });

  it('returns 401 when no auth cookie is present', async () => {
    const res = await request(buildApp()).get('/api/users/me/export');
    expect(res.status).toBe(401);
  });

  it('returns 404 when the user row vanishes between auth and export', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(buildApp())
      .get('/api/users/me/export')
      .set('Cookie', authCookie());
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/users/me/avatar', () => {
  // Mirror the production body-parser layering: the path-scoped 200KB
  // parser runs BEFORE the 32KB global so avatar payloads aren't truncated
  // by the global cap. The default buildApp uses the 100KB express.json
  // default which would also pass valid avatars, but we recreate the prod
  // ordering here so a regression in app.ts (someone "tidies up" the
  // path-scoped parser) is caught by the test suite, not in prod.
  function buildAvatarApp() {
    const app = express();
    app.use('/api/users/me/avatar', express.json({ limit: '200kb' }));
    app.use(express.json({ limit: '32kb' }));
    app.use(cookieParser());
    app.use('/api/users', usersRouter);
    return app;
  }

  // Smallest valid-looking PNG: 8 magic bytes + 4 zero bytes of trailing
  // junk. The endpoint's isRecognizedImage() only checks the prefix, so
  // anything past byte 12 is irrelevant. base64-encoded for transport.
  const PNG_MAGIC  = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
  const JPEG_MAGIC = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const GIF_MAGIC  = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
  const WEBP_MAGIC = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const dataUrl = (mime: string, buf: Buffer) => `data:${mime};base64,${buf.toString('base64')}`;

  beforeEach(() => {
    (mockPrisma.user.update as jest.Mock).mockResolvedValue({
      id: 1, avatarUrl: 'data:image/png;base64,iVBORw0KGgo=',
    });
  });

  it('accepts a valid PNG data URL and stores it on the user row', async () => {
    const url = dataUrl('image/png', PNG_MAGIC);
    const res = await request(buildAvatarApp())
      .patch('/api/users/me/avatar')
      .set('Cookie', authCookie())
      .send({ dataUrl: url });

    expect(res.status).toBe(200);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 1 },
      data:  { avatarUrl: url },
    }));
  });

  it('accepts JPEG, GIF, and WebP magic bytes', async () => {
    for (const [mime, buf] of [
      ['image/jpeg', JPEG_MAGIC],
      ['image/gif',  GIF_MAGIC],
      ['image/webp', WEBP_MAGIC],
    ] as const) {
      const res = await request(buildAvatarApp())
        .patch('/api/users/me/avatar')
        .set('Cookie', authCookie())
        .send({ dataUrl: dataUrl(mime, buf) });
      expect(res.status).toBe(200);
    }
  });

  it('clears avatarUrl when dataUrl is null', async () => {
    (mockPrisma.user.update as jest.Mock).mockResolvedValue({ id: 1, avatarUrl: null });
    const res = await request(buildAvatarApp())
      .patch('/api/users/me/avatar')
      .set('Cookie', authCookie())
      .send({ dataUrl: null });

    expect(res.status).toBe(200);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { avatarUrl: null },
    }));
  });

  it('rejects non-string dataUrl with 400', async () => {
    const res = await request(buildAvatarApp())
      .patch('/api/users/me/avatar')
      .set('Cookie', authCookie())
      .send({ dataUrl: 42 });

    expect(res.status).toBe(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects non-image MIME types (defense against javascript: URLs etc.)', async () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html;base64,SGVsbG8=',
      'data:application/pdf;base64,JVBERi0xLg==',
      'http://example.com/a.png',
      'not-a-url',
    ]) {
      const res = await request(buildAvatarApp())
        .patch('/api/users/me/avatar')
        .set('Cookie', authCookie())
        .send({ dataUrl: bad });
      expect(res.status).toBe(400);
    }
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects a payload with valid MIME header but bytes that fail magic-byte sniff', async () => {
    // Claims PNG but the bytes are clearly not PNG. Defends against an
    // attacker stashing an arbitrary payload behind a permissive header.
    const fakePng = Buffer.from('this is not really a PNG just some text bytes');
    const res = await request(buildAvatarApp())
      .patch('/api/users/me/avatar')
      .set('Cookie', authCookie())
      .send({ dataUrl: dataUrl('image/png', fakePng) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects payloads over the 100KB decoded cap', async () => {
    // 101KB of arbitrary bytes — slightly over the cap. Magic bytes are
    // valid PNG so we know we're testing the size gate, not the format
    // gate.
    const oversized = Buffer.concat([PNG_MAGIC.slice(0, 8), Buffer.alloc(101 * 1024)]);
    const res = await request(buildAvatarApp())
      .patch('/api/users/me/avatar')
      .set('Cookie', authCookie())
      .send({ dataUrl: dataUrl('image/png', oversized) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds/i);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects an empty data payload', async () => {
    const res = await request(buildAvatarApp())
      .patch('/api/users/me/avatar')
      .set('Cookie', authCookie())
      .send({ dataUrl: 'data:image/png;base64,' });

    expect(res.status).toBe(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('returns 401 when the request has no auth cookie', async () => {
    const res = await request(buildAvatarApp())
      .patch('/api/users/me/avatar')
      .send({ dataUrl: dataUrl('image/png', PNG_MAGIC) });

    expect(res.status).toBe(401);
  });

  describe('per-user rate limit (avatarUpdateLimiter)', () => {
    // The limiter has a `skip: NODE_ENV === 'test'` clause so the suite
    // doesn't trip over normal test traffic. Flip NODE_ENV mid-test to
    // exercise the actual limit, then restore. Each test gets its own
    // fresh app instance so the in-process limiter store starts empty.
    const originalNodeEnv = process.env.NODE_ENV;
    beforeEach(() => { process.env.NODE_ENV = 'production'; });
    afterEach(()  => { process.env.NODE_ENV = originalNodeEnv; });

    function freshApp() {
      // Re-import the rate-limits + users modules so the limiter middleware
      // captures the new NODE_ENV at construction time. Without this,
      // rate-limits was loaded during the suite's first import (NODE_ENV
      // === 'test'), and even though we flip NODE_ENV, the limiter's
      // closure already captured the test-mode skip.
      let app!: express.Express;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const router = require('../../routes/users').default;
        app = express();
        app.use('/api/users/me/avatar', express.json({ limit: '200kb' }));
        app.use(express.json({ limit: '32kb' }));
        app.use(cookieParser());
        app.use('/api/users', router);
      });
      return app;
    }

    it('429s the 21st request from the same user within the 1-hour window', async () => {
      const app = freshApp();
      const url = dataUrl('image/png', PNG_MAGIC);

      // 20 should succeed (the configured cap). The 21st must be rate-limited.
      // Serial rather than parallel so the limiter's counter is deterministic.
      for (let i = 0; i < 20; i++) {
        const res = await request(app)
          .patch('/api/users/me/avatar')
          .set('Cookie', authCookie())
          .send({ dataUrl: url });
        expect(res.status).toBe(200);
      }

      const blocked = await request(app)
        .patch('/api/users/me/avatar')
        .set('Cookie', authCookie())
        .send({ dataUrl: url });

      expect(blocked.status).toBe(429);
      expect(blocked.body.error).toMatch(/too many avatar updates/i);
    });

    it('isolates the limit per user — user A hitting the cap does not block user B', async () => {
      const app = freshApp();
      const url = dataUrl('image/png', PNG_MAGIC);

      // Exhaust user 1's quota.
      for (let i = 0; i < 20; i++) {
        await request(app)
          .patch('/api/users/me/avatar')
          .set('Cookie', authCookie(1))
          .send({ dataUrl: url });
      }
      const userBlocked = await request(app)
        .patch('/api/users/me/avatar')
        .set('Cookie', authCookie(1))
        .send({ dataUrl: url });
      expect(userBlocked.status).toBe(429);

      // User 2's bucket is untouched — the limiter's keyGenerator returns
      // the userId, so each account is isolated. If we ever regress to
      // IP-keyed, this test fails because both users share supertest's
      // loopback IP.
      const userOk = await request(app)
        .patch('/api/users/me/avatar')
        .set('Cookie', authCookie(2))
        .send({ dataUrl: url });
      expect(userOk.status).toBe(200);
    });
  });
});

describe('PATCH /api/users/me/reviews/:reviewId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates rating + content and recomputes when rating changed', async () => {
    (mockPrisma.review.findFirst as jest.Mock).mockResolvedValue({ restaurantId: 7, rating: 3 });
    (mockPrisma.review.update as jest.Mock).mockResolvedValue({
      id: 42, restaurantId: 7, rating: 5, content: 'updated', userId: 1, createdAt: new Date(),
    });
    // Recompute side effect — minimal mocks to let the recompute pass without erroring.
    (mockPrisma.review.groupBy as jest.Mock).mockResolvedValue([{ restaurantId: 7, _avg: { rating: 5 } }]);
    (mockPrisma.review.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.restaurant.update as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .patch('/api/users/me/reviews/42')
      .set('Cookie', authCookie())
      .send({ rating: 5, content: 'updated' });

    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({ id: 42, rating: 5, content: 'updated' });
    expect(mockPrisma.review.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 42 },
      data: { rating: 5, content: 'updated' },
    }));
  });

  it('skips recompute when only content changed', async () => {
    (mockPrisma.review.findFirst as jest.Mock).mockResolvedValue({ restaurantId: 7, rating: 4 });
    (mockPrisma.review.update as jest.Mock).mockResolvedValue({
      id: 42, restaurantId: 7, rating: 4, content: 'fixed typo', userId: 1, createdAt: new Date(),
    });

    const res = await request(buildApp())
      .patch('/api/users/me/reviews/42')
      .set('Cookie', authCookie())
      .send({ content: 'fixed typo' });

    expect(res.status).toBe(200);
    // recomputeCommunityRating calls review.groupBy — if it ran, this would
    // have been invoked. We never set the mock, so a call would throw "fn is
    // not a function" and the test would fail. The fact that we get a clean
    // 200 confirms the recompute branch was skipped.
    expect(mockPrisma.review.groupBy).not.toHaveBeenCalled();
  });

  it('returns 404 when the review does not belong to the caller', async () => {
    (mockPrisma.review.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await request(buildApp())
      .patch('/api/users/me/reviews/42')
      .set('Cookie', authCookie())
      .send({ rating: 4 });
    expect(res.status).toBe(404);
  });

  it('rejects out-of-range ratings', async () => {
    (mockPrisma.review.findFirst as jest.Mock).mockResolvedValue({ restaurantId: 7, rating: 3 });
    const res = await request(buildApp())
      .patch('/api/users/me/reviews/42')
      .set('Cookie', authCookie())
      .send({ rating: 6 });
    expect(res.status).toBe(400);
  });

  it('rejects empty body', async () => {
    (mockPrisma.review.findFirst as jest.Mock).mockResolvedValue({ restaurantId: 7, rating: 3 });
    const res = await request(buildApp())
      .patch('/api/users/me/reviews/42')
      .set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/users/me/refresh-places', () => {
  const ORIGINAL_FETCH = global.fetch;
  const ORIGINAL_KEY = process.env.GOOGLE_PLACES_API_KEY;

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    process.env.GOOGLE_PLACES_API_KEY = ORIGINAL_KEY;
  });

  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).post('/api/users/me/refresh-places');
    expect(res.status).toBe(401);
  });

  it('short-circuits to empty updates when API key is unset', async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    const res = await request(buildApp())
      .post('/api/users/me/refresh-places')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([]);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns empty when the user has no linked restaurants', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      favorites: [], options: [], accepted: [], archives: [],
    });
    const res = await request(buildApp())
      .post('/api/users/me/refresh-places')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([]);
    expect(mockPrisma.restaurant.findMany).not.toHaveBeenCalled();
  });

  it('returns empty when no linked restaurants are stale', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      favorites: [{ restaurantId: 1 }], options: [], accepted: [], archives: [],
    });
    (mockPrisma.restaurant.findMany as jest.Mock).mockResolvedValue([]);
    const res = await request(buildApp())
      .post('/api/users/me/refresh-places')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([]);
  });

  it('refreshes a stale restaurant by fetching Place Details and merging fields', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      favorites: [{ restaurantId: 1 }], options: [], accepted: [], archives: [],
    });
    (mockPrisma.restaurant.findMany as jest.Mock).mockResolvedValue([
      { id: 1, googlePlaceId: 'gp-1', name: 'Old Name' },
    ]);
    (mockPrisma.restaurant.update as jest.Mock).mockImplementation(async ({ data }) => ({
      id: 1, googlePlaceId: 'gp-1', name: 'Old Name', ...data,
    }));

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rating: 4.7, priceLevel: 'PRICE_LEVEL_MODERATE', takeout: true, websiteUri: 'https://x.test' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await request(buildApp())
      .post('/api/users/me/refresh-places')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.body.updated).toHaveLength(1);
    expect(mockPrisma.restaurant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          googleRating: 4.7,
          priceLevel: 2,
          takeout: true,
          website: 'https://x.test',
        }),
      }),
    );
  });

  it('continues past a failed Place Details lookup without aborting the batch', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      favorites: [{ restaurantId: 1 }, { restaurantId: 2 }], options: [], accepted: [], archives: [],
    });
    (mockPrisma.restaurant.findMany as jest.Mock).mockResolvedValue([
      { id: 1, googlePlaceId: 'gp-1', name: 'A' },
      { id: 2, googlePlaceId: 'gp-2', name: 'B' },
    ]);
    (mockPrisma.restaurant.update as jest.Mock).mockResolvedValue({ id: 2 });

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rating: 3.9 }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await request(buildApp())
      .post('/api/users/me/refresh-places')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.updated).toHaveLength(1); // only the second one
  });
});

describe('POST /api/users/me/accepted', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when restaurantId is missing', async () => {
    const res = await request(buildApp())
      .post('/api/users/me/accepted')
      .set('Cookie', authCookie())
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 201 with the acceptance record', async () => {
    const fakeAccepted = {
      id: 1,
      userId: 1,
      restaurantId: 5,
      acceptedAt: new Date(),
      restaurant: { id: 5, name: 'Pizza Place' },
    };
    (mockPrisma.userAccepted.create as jest.Mock).mockResolvedValue(fakeAccepted);

    const res = await request(buildApp())
      .post('/api/users/me/accepted')
      .set('Cookie', authCookie())
      .send({ restaurantId: 5 });

    expect(res.status).toBe(201);
    expect(res.body.accepted.restaurantId).toBe(5);
  });

  it('persists optionsSnapshot + chooseMethod when provided', async () => {
    (mockPrisma.userAccepted.create as jest.Mock).mockResolvedValue({
      id: 2, userId: 1, restaurantId: 5, acceptedAt: new Date(), restaurant: {},
    });

    const res = await request(buildApp())
      .post('/api/users/me/accepted')
      .set('Cookie', authCookie())
      .send({
        restaurantId: 5,
        optionsSnapshot: ['5', '6', '7'],
        chooseMethod: 'flip',
      });

    expect(res.status).toBe(201);
    expect(mockPrisma.userAccepted.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 1,
          restaurantId: 5,
          optionsSnapshot: ['5', '6', '7'],
          chooseMethod: 'flip',
        }),
      }),
    );
  });

  it('rejects an invalid chooseMethod value', async () => {
    const res = await request(buildApp())
      .post('/api/users/me/accepted')
      .set('Cookie', authCookie())
      .send({ restaurantId: 5, chooseMethod: 'nonsense' });
    expect(res.status).toBe(400);
  });

  it('rejects a optionsSnapshot that exceeds the size cap', async () => {
    const oversized = Array.from({ length: 101 }, (_, i) => String(i));
    const res = await request(buildApp())
      .post('/api/users/me/accepted')
      .set('Cookie', authCookie())
      .send({ restaurantId: 5, optionsSnapshot: oversized });
    expect(res.status).toBe(400);
  });

  it('coerces non-string snapshot entries to strings and drops empties', async () => {
    (mockPrisma.userAccepted.create as jest.Mock).mockResolvedValue({
      id: 3, userId: 1, restaurantId: 5, acceptedAt: new Date(), restaurant: {},
    });

    const res = await request(buildApp())
      .post('/api/users/me/accepted')
      .set('Cookie', authCookie())
      .send({ restaurantId: 5, optionsSnapshot: [5, '6', '', 7] });

    expect(res.status).toBe(201);
    const args = (mockPrisma.userAccepted.create as jest.Mock).mock.calls[0][0];
    expect(args.data.optionsSnapshot).toEqual(['5', '6', '7']);
  });

  it('leaves optionsSnapshot unset when caller omits it (legacy clients)', async () => {
    (mockPrisma.userAccepted.create as jest.Mock).mockResolvedValue({
      id: 4, userId: 1, restaurantId: 5, acceptedAt: new Date(), restaurant: {},
    });

    await request(buildApp())
      .post('/api/users/me/accepted')
      .set('Cookie', authCookie())
      .send({ restaurantId: 5 });

    const args = (mockPrisma.userAccepted.create as jest.Mock).mock.calls[0][0];
    expect(args.data.optionsSnapshot).toBeUndefined();
    expect(args.data.chooseMethod).toBeNull();
  });

  it('persists excludeFromInsights when provided', async () => {
    (mockPrisma.userAccepted.create as jest.Mock).mockResolvedValue({
      id: 5, userId: 1, restaurantId: 5, acceptedAt: new Date(),
      excludeFromInsights: true, restaurant: {},
    });

    const res = await request(buildApp())
      .post('/api/users/me/accepted')
      .set('Cookie', authCookie())
      .send({ restaurantId: 5, excludeFromInsights: true });

    expect(res.status).toBe(201);
    const args = (mockPrisma.userAccepted.create as jest.Mock).mock.calls[0][0];
    expect(args.data.excludeFromInsights).toBe(true);
  });

  it('rejects a non-boolean excludeFromInsights', async () => {
    const res = await request(buildApp())
      .post('/api/users/me/accepted')
      .set('Cookie', authCookie())
      .send({ restaurantId: 5, excludeFromInsights: 'yes' });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/users/me/accepted/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without auth', async () => {
    const res = await request(buildApp())
      .patch('/api/users/me/accepted/42')
      .send({ excludeFromInsights: true });
    expect(res.status).toBe(401);
  });

  it('returns 400 on a non-numeric id', async () => {
    const res = await request(buildApp())
      .patch('/api/users/me/accepted/not-a-number')
      .set('Cookie', authCookie())
      .send({ excludeFromInsights: true });
    expect(res.status).toBe(400);
  });

  it('returns 400 when excludeFromInsights is missing or not boolean', async () => {
    const noBody = await request(buildApp())
      .patch('/api/users/me/accepted/42')
      .set('Cookie', authCookie())
      .send({});
    expect(noBody.status).toBe(400);

    const badType = await request(buildApp())
      .patch('/api/users/me/accepted/42')
      .set('Cookie', authCookie())
      .send({ excludeFromInsights: 'true' });
    expect(badType.status).toBe(400);
  });

  it('returns 404 when the row does not belong to the user (count === 0)', async () => {
    // updateMany with the userId filter returns count=0 both for "row
    // doesn't exist" and "row exists but belongs to someone else" —
    // both surface as 404 to avoid leaking row existence across users.
    (mockPrisma.userAccepted.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    const res = await request(buildApp())
      .patch('/api/users/me/accepted/9999')
      .set('Cookie', authCookie())
      .send({ excludeFromInsights: true });
    expect(res.status).toBe(404);
  });

  it('updates excludeFromInsights and returns the refreshed row', async () => {
    (mockPrisma.userAccepted.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (mockPrisma.userAccepted.findUnique as jest.Mock).mockResolvedValue({
      id: 42, userId: 1, restaurantId: 7, acceptedAt: new Date(),
      excludeFromInsights: true, restaurant: { id: 7, name: 'Group Pick' },
    });

    const res = await request(buildApp())
      .patch('/api/users/me/accepted/42')
      .set('Cookie', authCookie())
      .send({ excludeFromInsights: true });

    expect(res.status).toBe(200);
    expect(res.body.accepted.excludeFromInsights).toBe(true);
    expect(mockPrisma.userAccepted.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 42, userId: 1 },
        data: { excludeFromInsights: true },
      }),
    );
  });

  // ── wouldPickAgain regret-toggle support ────────────────────
  //
  // The PATCH endpoint accepts a `wouldPickAgain` boolean (or null to
  // clear) in addition to (or instead of) excludeFromInsights. Tests
  // assert each value round-trips, that the field type is validated,
  // and that supplying both fields in one request works.

  it('accepts wouldPickAgain: true', async () => {
    (mockPrisma.userAccepted.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (mockPrisma.userAccepted.findUnique as jest.Mock).mockResolvedValue({
      id: 42, userId: 1, restaurantId: 7, acceptedAt: new Date(),
      excludeFromInsights: false, wouldPickAgain: true,
      restaurant: { id: 7, name: 'A spot' },
    });

    const res = await request(buildApp())
      .patch('/api/users/me/accepted/42')
      .set('Cookie', authCookie())
      .send({ wouldPickAgain: true });

    expect(res.status).toBe(200);
    expect(res.body.accepted.wouldPickAgain).toBe(true);
    expect(mockPrisma.userAccepted.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { wouldPickAgain: true } }),
    );
  });

  it('accepts wouldPickAgain: false (regret signal)', async () => {
    (mockPrisma.userAccepted.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (mockPrisma.userAccepted.findUnique as jest.Mock).mockResolvedValue({
      id: 42, userId: 1, restaurantId: 7, acceptedAt: new Date(),
      excludeFromInsights: false, wouldPickAgain: false,
      restaurant: { id: 7, name: 'A spot' },
    });

    const res = await request(buildApp())
      .patch('/api/users/me/accepted/42')
      .set('Cookie', authCookie())
      .send({ wouldPickAgain: false });

    expect(res.status).toBe(200);
    expect(res.body.accepted.wouldPickAgain).toBe(false);
  });

  it('accepts wouldPickAgain: null (user undoes their answer)', async () => {
    // Null is the explicit "no answer yet" state — the UI sends it when
    // the user un-toggles their thumb. The route must accept null
    // distinctly from omitting the field (which would no-op the column).
    (mockPrisma.userAccepted.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (mockPrisma.userAccepted.findUnique as jest.Mock).mockResolvedValue({
      id: 42, userId: 1, restaurantId: 7, acceptedAt: new Date(),
      excludeFromInsights: false, wouldPickAgain: null,
      restaurant: { id: 7, name: 'A spot' },
    });

    const res = await request(buildApp())
      .patch('/api/users/me/accepted/42')
      .set('Cookie', authCookie())
      .send({ wouldPickAgain: null });

    expect(res.status).toBe(200);
    expect(res.body.accepted.wouldPickAgain).toBeNull();
    expect(mockPrisma.userAccepted.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { wouldPickAgain: null } }),
    );
  });

  it('returns 400 when wouldPickAgain is the wrong type (string)', async () => {
    const res = await request(buildApp())
      .patch('/api/users/me/accepted/42')
      .set('Cookie', authCookie())
      .send({ wouldPickAgain: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/wouldPickAgain/i);
  });

  it('accepts both fields in a single request', async () => {
    // Combined updates must merge into one Prisma data object — splitting
    // into two updateMany calls would risk a partial write if the second
    // one fails.
    (mockPrisma.userAccepted.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (mockPrisma.userAccepted.findUnique as jest.Mock).mockResolvedValue({
      id: 42, userId: 1, restaurantId: 7, acceptedAt: new Date(),
      excludeFromInsights: true, wouldPickAgain: true,
      restaurant: { id: 7, name: 'A spot' },
    });

    const res = await request(buildApp())
      .patch('/api/users/me/accepted/42')
      .set('Cookie', authCookie())
      .send({ excludeFromInsights: true, wouldPickAgain: true });

    expect(res.status).toBe(200);
    expect(mockPrisma.userAccepted.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.userAccepted.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { excludeFromInsights: true, wouldPickAgain: true },
      }),
    );
  });
});

describe('GET /api/users/me/insights', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/users/me/insights');
    expect(res.status).toBe(401);
  });

  it('aggregates considerations, wins, and method counts across acceptances', async () => {
    // 3 acceptances: pizza (winner) considered alongside sushi+pho twice,
    // sushi (winner) once. Pho is in two consideration sets but never wins.
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([
      {
        restaurantId: 1, acceptedAt: new Date('2026-05-01'),
        optionsSnapshot: ['1', '2', '3'], chooseMethod: 'flip',
        restaurant: { id: 1, name: 'Pizza Place', cuisineType: 'Italian' },
      },
      {
        restaurantId: 1, acceptedAt: new Date('2026-05-02'),
        optionsSnapshot: ['1', '3'], chooseMethod: 'spin',
        restaurant: { id: 1, name: 'Pizza Place', cuisineType: 'Italian' },
      },
      {
        restaurantId: 2, acceptedAt: new Date('2026-05-03'),
        optionsSnapshot: ['1', '2'], chooseMethod: 'vote',
        restaurant: { id: 2, name: 'Sushi Bar', cuisineType: 'Japanese' },
      },
    ]);
    // Pho (id 3) appears only in snapshots — never as a winner. Mock its name lookup.
    (mockPrisma.restaurant.findMany as jest.Mock).mockResolvedValue([
      { id: 3, name: 'Pho 99', cuisineType: 'Vietnamese' },
    ]);

    const res = await request(buildApp())
      .get('/api/users/me/insights')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.totalDecisions).toBe(3);
    expect(res.body.distinctChosen).toBe(2); // pizza + sushi
    expect(res.body.methodCounts).toEqual({ flip: 1, spin: 1, vote: 1 });

    // Pizza was considered 3 times (in all 3 snapshots) and won twice
    const pizza = res.body.topConsidered.find((r: { restaurantId: string }) => r.restaurantId === '1');
    expect(pizza).toMatchObject({ name: 'Pizza Place', considered: 3, wins: 2 });

    // Pho appears in 2 snapshots, 0 wins — should show in "oftenSkipped"
    const skipped = res.body.oftenSkipped.find((r: { restaurantId: string }) => r.restaurantId === '3');
    expect(skipped).toMatchObject({ name: 'Pho 99', considered: 2, wins: 0 });
  });

  it('returns empty rollups for a user with no acceptance history', async () => {
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(buildApp())
      .get('/api/users/me/insights')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalDecisions: 0,
      distinctChosen: 0,
      methodCounts: {},
      topConsidered: [],
      oftenSkipped: [],
      recent: [],
    });
  });

  it('filters out rows with excludeFromInsights=true at the WHERE clause', async () => {
    // We don't need the rows themselves to do this test — just need to
    // assert that the query Prisma sees includes the filter. The route
    // sets `excludeFromInsights: false` in `where`; Prisma then excludes
    // rows where the column is true. The behavioral promise is "excluded
    // rows never reach the rollup," and the cheapest place to assert
    // that is at the query boundary.
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([]);

    await request(buildApp())
      .get('/api/users/me/insights')
      .set('Cookie', authCookie());

    const findManyCalls = (mockPrisma.userAccepted.findMany as jest.Mock).mock.calls;
    expect(findManyCalls.length).toBeGreaterThan(0);
    // The main rollup query must carry the filter — drift here would
    // silently re-include opted-out rows in totals/cuisine trends/etc.
    expect(findManyCalls[0][0].where).toMatchObject({
      userId: 1,
      excludeFromInsights: false,
    });
  });

  it('treats null optionsSnapshot as no considerations (legacy rows)', async () => {
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([
      {
        restaurantId: 5, acceptedAt: new Date(),
        optionsSnapshot: null, chooseMethod: null,
        restaurant: { id: 5, name: 'Pizza Place', cuisineType: 'Italian' },
      },
    ]);

    const res = await request(buildApp())
      .get('/api/users/me/insights')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    // Pizza is in topConsidered with 0 considerations + 1 win (the only winner)
    expect(res.body.topConsidered).toEqual([]);  // considered=0 filtered out
    expect(res.body.distinctChosen).toBe(1);
    expect(res.body.methodCounts).toEqual({ unknown: 1 });
  });

  it('returns weekdayCounts shaped as a 7-element array bucketed by UTC day', async () => {
    // 2026-05-01 is a Friday (UTC), 2026-05-03 is a Sunday. Two Fridays + one
    // Sunday → counts[5] === 2, counts[0] === 1.
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([
      { restaurantId: 1, acceptedAt: new Date('2026-05-01T18:00:00Z'),
        optionsSnapshot: ['1'], chooseMethod: 'flip',
        restaurant: { id: 1, name: 'A', cuisineType: null } },
      { restaurantId: 1, acceptedAt: new Date('2026-05-08T18:00:00Z'),
        optionsSnapshot: ['1'], chooseMethod: 'flip',
        restaurant: { id: 1, name: 'A', cuisineType: null } },
      { restaurantId: 2, acceptedAt: new Date('2026-05-03T18:00:00Z'),
        optionsSnapshot: ['2'], chooseMethod: 'flip',
        restaurant: { id: 2, name: 'B', cuisineType: null } },
    ]);

    const res = await request(buildApp())
      .get('/api/users/me/insights')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.weekdayCounts)).toBe(true);
    expect(res.body.weekdayCounts).toHaveLength(7);
    expect(res.body.weekdayCounts[0]).toBe(1);  // Sunday
    expect(res.body.weekdayCounts[5]).toBe(2);  // Friday
    // Other days unchanged
    expect(res.body.weekdayCounts.reduce((a: number, b: number) => a + b, 0)).toBe(3);
  });

  it('honors the `since` query param by restricting acceptedAt at the DB layer', async () => {
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(buildApp())
      .get('/api/users/me/insights?since=week')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.since).toBe('week');
    // The route should have filtered on acceptedAt >= (now - 7 days). We can't
    // pin the exact timestamp without freezing time, but we can assert the
    // shape of the where-clause.
    const args = (mockPrisma.userAccepted.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where.acceptedAt).toBeDefined();
    expect(args.where.acceptedAt.gte).toBeInstanceOf(Date);
  });

  it('ignores unknown `since` values and falls back to the all-time cap', async () => {
    // Previously this test asserted "no acceptedAt filter applied" because
    // the route used an unbounded all-time query. The route now caps all-
    // time at 5 years (INSIGHTS_ALL_TIME_CAP_DAYS — see TIER_2_3_PLAN.md
    // #12). Unknown `since` values fall through to the same cap, so the
    // filter IS applied — just with a 5-year window.
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(buildApp())
      .get('/api/users/me/insights?since=bogus')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.since).toBe('bogus'); // echoed back as-is — no harm
    const args = (mockPrisma.userAccepted.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where.acceptedAt).toBeDefined();
    expect(args.where.acceptedAt.gte).toBeInstanceOf(Date);
    // Verify the cap is roughly 5 years back, not a tighter window.
    const ms = Date.now() - (args.where.acceptedAt.gte as Date).getTime();
    expect(ms).toBeGreaterThan(4 * 365 * 24 * 60 * 60 * 1000);
    expect(ms).toBeLessThan(6 * 365 * 24 * 60 * 60 * 1000);
  });

  it('computes varietyScore as distinctChosen / totalDecisions × 10', async () => {
    // 3 decisions across 2 distinct restaurants → 2/3 × 10 = 6.666... → 6.7
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([
      { restaurantId: 1, acceptedAt: new Date('2026-05-01'), optionsSnapshot: null, chooseMethod: 'flip', restaurant: { id: 1, name: 'A', cuisineType: null } },
      { restaurantId: 1, acceptedAt: new Date('2026-05-02'), optionsSnapshot: null, chooseMethod: 'flip', restaurant: { id: 1, name: 'A', cuisineType: null } },
      { restaurantId: 2, acceptedAt: new Date('2026-05-03'), optionsSnapshot: null, chooseMethod: 'flip', restaurant: { id: 2, name: 'B', cuisineType: null } },
    ]);

    const res = await request(buildApp())
      .get('/api/users/me/insights')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.totalDecisions).toBe(3);
    expect(res.body.distinctChosen).toBe(2);
    expect(res.body.varietyScore).toBeCloseTo(6.7, 1);
  });

  it('varietyScore is 0 when there are no decisions (avoids divide-by-zero)', async () => {
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/users/me/insights').set('Cookie', authCookie());
    expect(res.body.varietyScore).toBe(0);
  });

  it('returns neglected favorites: favorited + never picked OR last-pick older than threshold', async () => {
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([]);
    // Three favorites: A (never chosen) → neglected; B (chosen yesterday) → not
    // neglected; C (chosen 90 days ago) → neglected. Server's threshold is 60d.
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    (mockPrisma.userFavorite.findMany as jest.Mock).mockResolvedValue([
      { restaurantId: 1, restaurant: { id: 1, name: 'Never Joe',  cuisineType: 'Pizza' } },
      { restaurantId: 2, restaurant: { id: 2, name: 'Recent Tom', cuisineType: 'Thai'  } },
      { restaurantId: 3, restaurant: { id: 3, name: 'Old Pete',   cuisineType: 'Sushi' } },
    ]);
    (mockPrisma.userAccepted.groupBy as jest.Mock).mockResolvedValue([
      { restaurantId: 2, _max: { acceptedAt: new Date() } },
      { restaurantId: 3, _max: { acceptedAt: ninetyDaysAgo } },
    ]);

    const res = await request(buildApp())
      .get('/api/users/me/insights')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.neglectedFavorites)).toBe(true);
    expect(res.body.neglectedFavorites).toHaveLength(2);
    // Never-chosen ranks first (most neglected); 90-day-old second
    expect(res.body.neglectedFavorites[0].name).toBe('Never Joe');
    expect(res.body.neglectedFavorites[0].lastChosenAt).toBeNull();
    expect(res.body.neglectedFavorites[1].name).toBe('Old Pete');
    expect(res.body.neglectedFavorites[1].lastChosenAt).not.toBeNull();
  });

  it('neglectedFavorites is empty when user has no favorites at all', async () => {
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.userFavorite.findMany as jest.Mock).mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/users/me/insights').set('Cookie', authCookie());
    expect(res.body.neglectedFavorites).toEqual([]);
    // And no groupBy call needs to have run — the route should short-circuit
    expect(mockPrisma.userAccepted.groupBy).not.toHaveBeenCalled();
  });

  it('returns previousPeriodCount only when `since` is windowed', async () => {
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.userAccepted.count as jest.Mock).mockResolvedValue(7);

    // since=all → null
    const allRes = await request(buildApp()).get('/api/users/me/insights').set('Cookie', authCookie());
    expect(allRes.body.previousPeriodCount).toBeNull();

    // since=month → server should run a count() bounded by (now - 60d, now - 30d)
    const monthRes = await request(buildApp()).get('/api/users/me/insights?since=month').set('Cookie', authCookie());
    expect(monthRes.body.previousPeriodCount).toBe(7);
    const countArgs = (mockPrisma.userAccepted.count as jest.Mock).mock.calls[0][0];
    expect(countArgs.where.acceptedAt.gte).toBeInstanceOf(Date);
    expect(countArgs.where.acceptedAt.lt).toBeInstanceOf(Date);
    // The window width matches the `since` value
    const widthDays = (countArgs.where.acceptedAt.lt.getTime() - countArgs.where.acceptedAt.gte.getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.round(widthDays)).toBe(30);
  });

  it('cuisineWeeklyCounts bucket totals match the number of recent rows per cuisine', async () => {
    const now = new Date();
    // 3 Italian + 1 Thai acceptances in the last few weeks (all inside the 12-week window).
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([
      { restaurantId: 1, acceptedAt: now, optionsSnapshot: null, chooseMethod: 'flip', restaurant: { id: 1, name: 'A', cuisineType: 'Italian' }, eventId: null, event: null },
      { restaurantId: 1, acceptedAt: new Date(now.getTime() - 5 * 86_400_000), optionsSnapshot: null, chooseMethod: 'flip', restaurant: { id: 1, name: 'A', cuisineType: 'Italian' }, eventId: null, event: null },
      { restaurantId: 1, acceptedAt: new Date(now.getTime() - 8 * 86_400_000), optionsSnapshot: null, chooseMethod: 'flip', restaurant: { id: 1, name: 'A', cuisineType: 'Italian' }, eventId: null, event: null },
      { restaurantId: 2, acceptedAt: new Date(now.getTime() - 3 * 86_400_000), optionsSnapshot: null, chooseMethod: 'flip', restaurant: { id: 2, name: 'B', cuisineType: 'Thai' },    eventId: null, event: null },
    ]);

    const res = await request(buildApp()).get('/api/users/me/insights').set('Cookie', authCookie());
    expect(res.body.cuisineWeeklyCounts).toBeDefined();
    expect(res.body.cuisineWeeklyCounts.Italian).toHaveLength(12);
    expect(res.body.cuisineWeeklyCounts.Italian.reduce((a: number, b: number) => a + b, 0)).toBe(3);
    expect(res.body.cuisineWeeklyCounts.Thai.reduce((a: number, b: number) => a + b, 0)).toBe(1);
  });

  it('surfaces eventId + groupId on recent rows when the acceptance came from a group vote', async () => {
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([
      // Solo flip — no event link
      { restaurantId: 1, acceptedAt: new Date(), optionsSnapshot: null, chooseMethod: 'flip',
        restaurant: { id: 1, name: 'Solo', cuisineType: null },
        eventId: null, event: null },
      // Group vote — both ids surfaced
      { restaurantId: 2, acceptedAt: new Date(), optionsSnapshot: null, chooseMethod: 'vote',
        restaurant: { id: 2, name: 'Group Pick', cuisineType: null },
        eventId: 42, event: { groupId: 7 } },
    ]);

    const res = await request(buildApp()).get('/api/users/me/insights').set('Cookie', authCookie());
    expect(res.body.recent).toHaveLength(2);
    expect(res.body.recent[0]).toMatchObject({ name: 'Solo',       eventId: null, groupId: null });
    expect(res.body.recent[1]).toMatchObject({ name: 'Group Pick', eventId: 42,   groupId: 7    });
  });

  // ── Regret toggle (wouldPickAgain) aggregation ──────────────
  //
  // The /me/insights response surfaces two regret-related fields:
  //   - regretAnswered: count of acceptances where wouldPickAgain !== null
  //   - regretRate:     percentage of answered rows marked false (regret).
  //                     Null when fewer than 3 rows have been answered so
  //                     a single thumbs-down doesn't headline "50% regret".
  // Tests below check both branches (suppressed-below-threshold + active).

  it('returns regretRate=null and regretAnswered count when below the 3-answer floor', async () => {
    // 2 answered (1 yes, 1 no), 1 unanswered. Below the 3-row floor →
    // regretRate stays null so the UI hides the stat.
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([
      { id: 1, restaurantId: 1, acceptedAt: new Date('2026-05-01'),
        optionsSnapshot: null, chooseMethod: 'flip', wouldPickAgain: true,
        eventId: null, event: null, restaurant: { id: 1, name: 'A', cuisineType: 'Italian' } },
      { id: 2, restaurantId: 2, acceptedAt: new Date('2026-05-02'),
        optionsSnapshot: null, chooseMethod: 'flip', wouldPickAgain: false,
        eventId: null, event: null, restaurant: { id: 2, name: 'B', cuisineType: 'Thai' } },
      { id: 3, restaurantId: 3, acceptedAt: new Date('2026-05-03'),
        optionsSnapshot: null, chooseMethod: 'flip', wouldPickAgain: null,
        eventId: null, event: null, restaurant: { id: 3, name: 'C', cuisineType: 'Mexican' } },
    ]);

    const res = await request(buildApp()).get('/api/users/me/insights').set('Cookie', authCookie());

    expect(res.body.regretAnswered).toBe(2);
    expect(res.body.regretRate).toBeNull();
  });

  it('computes regretRate as an integer percentage once 3+ rows are answered', async () => {
    // 4 answered: 1 true, 3 false → 75% regret rate. Crosses the 3-row floor
    // and the route should return the integer percentage (no decimals).
    const rows = [
      { id: 1, wouldPickAgain: true  },
      { id: 2, wouldPickAgain: false },
      { id: 3, wouldPickAgain: false },
      { id: 4, wouldPickAgain: false },
    ].map((r, i) => ({
      ...r,
      restaurantId: i + 1,
      acceptedAt: new Date('2026-05-01'),
      optionsSnapshot: null,
      chooseMethod: 'flip',
      eventId: null,
      event: null,
      restaurant: { id: i + 1, name: `R${i}`, cuisineType: null },
    }));
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue(rows);

    const res = await request(buildApp()).get('/api/users/me/insights').set('Cookie', authCookie());

    expect(res.body.regretAnswered).toBe(4);
    expect(res.body.regretRate).toBe(75);
  });

  it('surfaces wouldPickAgain on recent rows alongside the id', async () => {
    // The UI wires the regret toggle by the acceptance row's id, so the
    // /insights response must include both `id` and the current answer.
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([
      { id: 99, restaurantId: 1, acceptedAt: new Date(),
        optionsSnapshot: null, chooseMethod: 'flip', wouldPickAgain: true,
        eventId: null, event: null, restaurant: { id: 1, name: 'A', cuisineType: null } },
      { id: 100, restaurantId: 2, acceptedAt: new Date(),
        optionsSnapshot: null, chooseMethod: 'flip', wouldPickAgain: null,
        eventId: null, event: null, restaurant: { id: 2, name: 'B', cuisineType: null } },
    ]);

    const res = await request(buildApp()).get('/api/users/me/insights').set('Cookie', authCookie());

    expect(res.body.recent[0]).toMatchObject({ id: 99,  wouldPickAgain: true });
    expect(res.body.recent[1]).toMatchObject({ id: 100, wouldPickAgain: null });
  });
});

// ── GET /api/users/me/insights/friends ────────────────────────
//
// Friend-by-friend cuisine comparison over the past year. The endpoint
// makes two Prisma calls:
//   1. friendRequest.findMany → discovers accepted friends (either direction)
//   2. userAccepted.findMany  → fetches viewer + friends' acceptances
//
// The compute then buckets by user → cuisine → count and surfaces:
//   - topShared:     cuisine you and they both pick, ranked by alignment
//   - theirFavorite: a cuisine they over-index on vs. you (≥ 3 picks, ≥ 2× yours)

describe('GET /api/users/me/insights/friends', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/users/me/insights/friends');
    expect(res.status).toBe(401);
  });

  it('returns an empty array when the user has no friends (short-circuits the second query)', async () => {
    (mockPrisma.friendRequest.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(buildApp())
      .get('/api/users/me/insights/friends').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.friends).toEqual([]);
    // No friends → no point fetching acceptances. Regression guard
    // against a refactor that drops the early return.
    expect(mockPrisma.userAccepted.findMany).not.toHaveBeenCalled();
  });

  it('computes topShared and theirFavorite over a one-year cuisine history', async () => {
    // Viewer is user 1; friend is user 2. Both have a one-year picture
    // populated below — Italian is the shared favorite; Thai is the
    // friend's strong over-index (3 picks vs the viewer's 0).
    (mockPrisma.friendRequest.findMany as jest.Mock).mockResolvedValue([
      {
        senderId: 1, receiverId: 2,
        sender:   { id: 1, username: 'me',  avatarUrl: null },
        receiver: { id: 2, username: 'bob', avatarUrl: null },
      },
    ]);
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([
      // Viewer's history — 3 Italian, 1 Mexican
      { userId: 1, restaurant: { cuisineType: 'Italian' } },
      { userId: 1, restaurant: { cuisineType: 'Italian' } },
      { userId: 1, restaurant: { cuisineType: 'Italian' } },
      { userId: 1, restaurant: { cuisineType: 'Mexican' } },
      // Bob's history — 2 Italian, 3 Thai
      { userId: 2, restaurant: { cuisineType: 'Italian' } },
      { userId: 2, restaurant: { cuisineType: 'Italian' } },
      { userId: 2, restaurant: { cuisineType: 'Thai' } },
      { userId: 2, restaurant: { cuisineType: 'Thai' } },
      { userId: 2, restaurant: { cuisineType: 'Thai' } },
    ]);

    const res = await request(buildApp())
      .get('/api/users/me/insights/friends').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.friends).toHaveLength(1);
    const bob = res.body.friends[0];

    expect(bob.username).toBe('bob');
    // Shared cuisine: Italian (3 mine vs 2 theirs). Alignment is min/max =
    // 2/3 ≈ 0.667; the only shared cuisine so it leads topShared.
    expect(bob.topShared).toMatchObject({
      cuisine:    'Italian',
      mineCount:  3,
      theirCount: 2,
    });
    // Thai: 3 of theirs vs 0 of mine → ratio infinity (treated as max), and
    // it clears the 3-pick floor. theirFavorite surfaces it.
    expect(bob.theirFavorite).toMatchObject({
      cuisine: 'Thai', theirCount: 3, mineCount: 0,
    });
  });

  it('returns the friend with theirFavorite=null when no cuisine over-indexes by 2×', async () => {
    // Bob and viewer both eat Italian 3 times — equal counts. theirFavorite
    // requires 2× viewer's count, so it should be null here. Catches a
    // regression where the threshold check accidentally allows ratio=1.
    (mockPrisma.friendRequest.findMany as jest.Mock).mockResolvedValue([
      {
        senderId: 1, receiverId: 2,
        sender:   { id: 1, username: 'me',  avatarUrl: null },
        receiver: { id: 2, username: 'bob', avatarUrl: null },
      },
    ]);
    (mockPrisma.userAccepted.findMany as jest.Mock).mockResolvedValue([
      { userId: 1, restaurant: { cuisineType: 'Italian' } },
      { userId: 1, restaurant: { cuisineType: 'Italian' } },
      { userId: 1, restaurant: { cuisineType: 'Italian' } },
      { userId: 2, restaurant: { cuisineType: 'Italian' } },
      { userId: 2, restaurant: { cuisineType: 'Italian' } },
      { userId: 2, restaurant: { cuisineType: 'Italian' } },
    ]);

    const res = await request(buildApp())
      .get('/api/users/me/insights/friends').set('Cookie', authCookie(1));

    expect(res.body.friends[0].theirFavorite).toBeNull();
  });
});

// ── Multi-list favorites ──────────────────────────────────────
//
// Covers the new favorite-lists endpoints introduced for the
// multi-list favorites sprint:
//   GET    /me/favorite-lists
//   POST   /me/favorite-lists
//   PATCH  /me/favorite-lists/:id
//   DELETE /me/favorite-lists/:id
//   POST   /me/favorite-lists/:id/default
//   POST   /me/favorite-lists/:id/entries
//   DELETE /me/favorite-lists/:id/entries/:rid
//   PATCH  /me/favorite-lists/positions
//
// jest-mock-extended returns undefined for unmocked prisma calls; we
// set explicit mocks per test to keep the contract obvious. Several
// endpoints make defensive bootstrap calls (ensureDefaultFavoriteList);
// those tests stub findFirst → null then create → the new row.

const sampleList = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 10,
  userId: 1,
  groupId: null,
  name: 'My Favorites',
  description: null,
  color: null,
  isDefault: true,
  position: 0,
  createdAt: new Date('2026-05-15T00:00:00Z'),
  entries: [],
  ...overrides,
});

describe('GET /api/users/me/favorite-lists', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/users/me/favorite-lists');
    expect(res.status).toBe(401);
  });

  it('returns hydrated lists with entries in position order', async () => {
    (mockPrisma.favoriteList.findMany as jest.Mock).mockResolvedValue([
      sampleList(),
      sampleList({ id: 11, name: 'Date Night', isDefault: false, position: 1 }),
    ]);
    const res = await request(buildApp())
      .get('/api/users/me/favorite-lists')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.lists).toHaveLength(2);
    expect(res.body.lists[0]).toMatchObject({ id: 10, name: 'My Favorites', isDefault: true });
    expect(res.body.lists[1]).toMatchObject({ id: 11, name: 'Date Night',    isDefault: false });
  });

  it('bootstraps a default list when the user has none yet', async () => {
    // First findMany returns []; ensureDefaultFavoriteList then queries
    // findFirst (returns null → no existing default), create runs and
    // returns the new row, and the second findMany picks it up.
    (mockPrisma.favoriteList.findMany as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([sampleList()]);
    (mockPrisma.favoriteList.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.favoriteList.create as jest.Mock).mockResolvedValue({ id: 10 });

    const res = await request(buildApp())
      .get('/api/users/me/favorite-lists')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(mockPrisma.favoriteList.create).toHaveBeenCalled();
    expect(res.body.lists).toHaveLength(1);
  });
});

describe('POST /api/users/me/favorite-lists', () => {
  it('returns 400 for missing name', async () => {
    const res = await request(buildApp())
      .post('/api/users/me/favorite-lists')
      .set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
  });

  it('returns 400 for a non-allowlist color', async () => {
    const res = await request(buildApp())
      .post('/api/users/me/favorite-lists')
      .set('Cookie', authCookie())
      .send({ name: 'Date Night', color: '#123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/color must be one of/i);
  });

  it('returns 400 past the per-user list cap', async () => {
    (mockPrisma.favoriteList.count as jest.Mock).mockResolvedValue(50);
    const res = await request(buildApp())
      .post('/api/users/me/favorite-lists')
      .set('Cookie', authCookie())
      .send({ name: 'Yet Another' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most/i);
  });

  it('creates a new list and returns the hydrated row', async () => {
    (mockPrisma.favoriteList.count as jest.Mock).mockResolvedValue(1);
    (mockPrisma.favoriteList.aggregate as jest.Mock).mockResolvedValue({ _max: { position: 0 } });
    (mockPrisma.favoriteList.create as jest.Mock).mockResolvedValue(
      sampleList({ id: 11, name: 'Date Night', isDefault: false, position: 1, color: '#ef4444' }),
    );
    const res = await request(buildApp())
      .post('/api/users/me/favorite-lists')
      .set('Cookie', authCookie())
      .send({ name: 'Date Night', color: '#EF4444' });
    expect(res.status).toBe(201);
    expect(res.body.list).toMatchObject({ name: 'Date Night', color: '#ef4444', position: 1 });
  });

  it('translates P2002 to a 409 conflict', async () => {
    (mockPrisma.favoriteList.count as jest.Mock).mockResolvedValue(1);
    (mockPrisma.favoriteList.aggregate as jest.Mock).mockResolvedValue({ _max: { position: 0 } });
    (mockPrisma.favoriteList.create as jest.Mock).mockRejectedValue({ code: 'P2002' });
    const res = await request(buildApp())
      .post('/api/users/me/favorite-lists')
      .set('Cookie', authCookie())
      .send({ name: 'Date Night' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already have a list/i);
  });
});

describe('PATCH /api/users/me/favorite-lists/:id', () => {
  it('404s when the list belongs to someone else', async () => {
    (mockPrisma.favoriteList.findUnique as jest.Mock).mockResolvedValue({
      id: 10, userId: 999, groupId: null, name: 'Theirs', isDefault: false, position: 0,
    });
    const res = await request(buildApp())
      .patch('/api/users/me/favorite-lists/10')
      .set('Cookie', authCookie())
      .send({ name: 'Mine now' });
    expect(res.status).toBe(404);
  });

  it('updates the list metadata and returns the new row', async () => {
    (mockPrisma.favoriteList.findUnique as jest.Mock).mockResolvedValue({
      id: 10, userId: 1, groupId: null, name: 'My Favorites', isDefault: true, position: 0,
    });
    (mockPrisma.favoriteList.update as jest.Mock).mockResolvedValue(
      sampleList({ name: 'Best Spots', color: '#10b981' }),
    );
    const res = await request(buildApp())
      .patch('/api/users/me/favorite-lists/10')
      .set('Cookie', authCookie())
      .send({ name: 'Best Spots', color: '#10B981' });
    expect(res.status).toBe(200);
    expect(res.body.list).toMatchObject({ name: 'Best Spots', color: '#10b981' });
  });
});

describe('DELETE /api/users/me/favorite-lists/:id', () => {
  it('400s on the default list', async () => {
    (mockPrisma.favoriteList.findUnique as jest.Mock).mockResolvedValue({
      id: 10, userId: 1, groupId: null, name: 'My Favorites', isDefault: true, position: 0,
    });
    const res = await request(buildApp())
      .delete('/api/users/me/favorite-lists/10')
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/default list/i);
  });

  it('400s when it would be the only list', async () => {
    (mockPrisma.favoriteList.findUnique as jest.Mock).mockResolvedValue({
      id: 11, userId: 1, groupId: null, name: 'Solo', isDefault: false, position: 0,
    });
    (mockPrisma.favoriteList.count as jest.Mock).mockResolvedValue(1);
    const res = await request(buildApp())
      .delete('/api/users/me/favorite-lists/11')
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only list/i);
  });

  it('deletes a non-default list with siblings remaining', async () => {
    (mockPrisma.favoriteList.findUnique as jest.Mock).mockResolvedValue({
      id: 11, userId: 1, groupId: null, name: 'Date Night', isDefault: false, position: 1,
    });
    (mockPrisma.favoriteList.count as jest.Mock).mockResolvedValue(2);
    (mockPrisma.favoriteList.delete as jest.Mock).mockResolvedValue({});
    const res = await request(buildApp())
      .delete('/api/users/me/favorite-lists/11')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(mockPrisma.favoriteList.delete).toHaveBeenCalledWith({ where: { id: 11 } });
  });
});

describe('POST /api/users/me/favorite-lists/:id/default', () => {
  it('promotes a non-default list and demotes others atomically', async () => {
    (mockPrisma.favoriteList.findUnique as jest.Mock).mockResolvedValue({
      id: 11, userId: 1, groupId: null, name: 'Date Night', isDefault: false, position: 1,
    });
    // $transaction(fn) — beforeEach already routes the callback at
    // mockPrisma so updateMany + update both hit the mock client.
    (mockPrisma.favoriteList.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (mockPrisma.favoriteList.update as jest.Mock).mockResolvedValue(
      sampleList({ id: 11, name: 'Date Night', isDefault: true }),
    );
    // syncLegacyFavorites fires post-response — stub the lookups so
    // its fire-and-forget Promise resolves cleanly.
    (mockPrisma.favoriteList.findFirst as jest.Mock).mockResolvedValue({ id: 11, entries: [] });
    (mockPrisma.userFavorite.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(buildApp())
      .post('/api/users/me/favorite-lists/11/default')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.list).toMatchObject({ id: 11, isDefault: true });
    expect(mockPrisma.favoriteList.updateMany).toHaveBeenCalledWith({
      where: { userId: 1, isDefault: true, NOT: { id: 11 } },
      data:  { isDefault: false },
    });
  });
});

describe('POST /api/users/me/favorite-lists/:id/entries', () => {
  it('400s for a non-integer restaurantId', async () => {
    (mockPrisma.favoriteList.findUnique as jest.Mock).mockResolvedValue({
      id: 10, userId: 1, groupId: null, name: 'My Favorites', isDefault: true, position: 0,
    });
    const res = await request(buildApp())
      .post('/api/users/me/favorite-lists/10/entries')
      .set('Cookie', authCookie())
      .send({ restaurantId: 'not-a-number' });
    expect(res.status).toBe(400);
  });

  it('upserts an entry and mirrors to UserFavorite on the default list', async () => {
    (mockPrisma.favoriteList.findUnique as jest.Mock).mockResolvedValue({
      id: 10, userId: 1, groupId: null, name: 'My Favorites', isDefault: true, position: 0,
    });
    (mockPrisma.favoriteListEntry.upsert as jest.Mock).mockResolvedValue({
      restaurantId: 42, note: null, addedAt: new Date('2026-05-15T00:00:00Z'),
    });
    (mockPrisma.userFavorite.upsert as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .post('/api/users/me/favorite-lists/10/entries')
      .set('Cookie', authCookie())
      .send({ restaurantId: 42 });
    expect(res.status).toBe(201);
    expect(res.body.entry).toMatchObject({ restaurantId: 42 });
    // Default-list mirror — keeps legacy user_favorites + the
    // /me/all derived favoriteIds in sync.
    expect(mockPrisma.userFavorite.upsert).toHaveBeenCalled();
  });

  it('does NOT mirror to UserFavorite on a non-default list', async () => {
    (mockPrisma.favoriteList.findUnique as jest.Mock).mockResolvedValue({
      id: 11, userId: 1, groupId: null, name: 'Date Night', isDefault: false, position: 1,
    });
    (mockPrisma.favoriteListEntry.upsert as jest.Mock).mockResolvedValue({
      restaurantId: 42, note: 'try omakase', addedAt: new Date(),
    });
    const res = await request(buildApp())
      .post('/api/users/me/favorite-lists/11/entries')
      .set('Cookie', authCookie())
      .send({ restaurantId: 42, note: 'try omakase' });
    expect(res.status).toBe(201);
    expect(mockPrisma.userFavorite.upsert).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/users/me/favorite-lists/positions', () => {
  it('400s when the order array doesn\'t match the user\'s lists', async () => {
    (mockPrisma.favoriteList.findMany as jest.Mock).mockResolvedValue([
      { id: 10 }, { id: 11 },
    ]);
    const res = await request(buildApp())
      .patch('/api/users/me/favorite-lists/positions')
      .set('Cookie', authCookie())
      .send({ order: [10, 99] });
    expect(res.status).toBe(400);
  });

  it('rewrites positions when the order matches exactly', async () => {
    (mockPrisma.favoriteList.findMany as jest.Mock).mockResolvedValue([
      { id: 10 }, { id: 11 },
    ]);
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (arg: unknown) => {
      // PATCH /positions uses the array-form transaction; let it
      // resolve to a no-op array.
      if (Array.isArray(arg)) return arg.map(() => ({}));
      if (typeof arg === 'function') return arg(mockPrisma);
      return undefined;
    });
    const res = await request(buildApp())
      .patch('/api/users/me/favorite-lists/positions')
      .set('Cookie', authCookie())
      .send({ order: [11, 10] });
    expect(res.status).toBe(200);
  });
});
