import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { DeepMockProxy } from 'jest-mock-extended';

jest.mock('../../lib/prisma');

import prisma from '../../lib/prisma';
import socialRouter from '../../routes/social';

const mockPrisma = prisma as unknown as DeepMockProxy<PrismaClient>;
const SECRET = process.env.JWT_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/social', socialRouter);
  return app;
}

const authCookie = (userId = 1) => `token=${jwt.sign({ userId }, SECRET)}`;

describe('GET /api/social/search', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/social/search?q=alice');
    expect(res.status).toBe(401);
  });

  it('returns empty array for an empty or missing query', async () => {
    const res = await request(buildApp())
      .get('/api/social/search?q=')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
  });

  it('returns users with relationship context for a matching query', async () => {
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
      { id: 2, username: 'bob', avatarUrl: null },
    ]);
    (mockPrisma.follow.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.friendRequest.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(buildApp())
      .get('/api/social/search?q=bob')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].username).toBe('bob');
    expect(res.body.users[0].isFollowing).toBe(false);
    expect(res.body.users[0].friendStatus).toBe('none');
  });

  it('marks a user as isFollowing when a Follow record exists', async () => {
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
      { id: 2, username: 'bob', avatarUrl: null },
    ]);
    (mockPrisma.follow.findMany as jest.Mock).mockResolvedValue([
      { followerId: 1, followingId: 2 },
    ]);
    (mockPrisma.friendRequest.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(buildApp())
      .get('/api/social/search?q=bob')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.users[0].isFollowing).toBe(true);
  });
});

describe('GET /api/social/followers', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/social/followers');
    expect(res.status).toBe(401);
  });

  it('returns the list of followers', async () => {
    (mockPrisma.follow.findMany as jest.Mock).mockResolvedValue([
      { follower: { id: 2, username: 'bob', avatarUrl: null } },
    ]);

    const res = await request(buildApp())
      .get('/api/social/followers')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.followers).toHaveLength(1);
    expect(res.body.followers[0].username).toBe('bob');
  });
});

describe('GET /api/social/following', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/social/following');
    expect(res.status).toBe(401);
  });

  it('returns the list of users being followed', async () => {
    (mockPrisma.follow.findMany as jest.Mock).mockResolvedValue([
      { following: { id: 3, username: 'carol', avatarUrl: null } },
    ]);

    const res = await request(buildApp())
      .get('/api/social/following')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.following).toHaveLength(1);
    expect(res.body.following[0].username).toBe('carol');
  });
});

describe('GET /api/social/friends', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/social/friends');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/social/friend-requests/incoming', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/social/friend-requests/incoming');
    expect(res.status).toBe(401);
  });
});

// ── Recommendation × private restaurant privacy ─────────────────
describe('POST /api/social/recommendations/:restaurantId (privacy)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 404 when recommending a private restaurant owned by another user', async () => {
    // Restaurant exists, but is private and the creator is user 99 — caller is user 1.
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
      id: 7, private: true, createdBy: 99,
    });

    const res = await request(buildApp())
      .post('/api/social/recommendations/7')
      .set('Cookie', authCookie(1))
      .send({ tip: 'great pizza' });

    // 404 not 403 — don't reveal that the row exists at all
    expect(res.status).toBe(404);
    expect(mockPrisma.recommendation.upsert).not.toHaveBeenCalled();
  });

  it('auto-publishes a private restaurant when its creator recommends it', async () => {
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
      id: 7, private: true, createdBy: 1,
    });
    (mockPrisma.restaurant.update as jest.Mock).mockResolvedValue({ id: 7, private: false });
    (mockPrisma.recommendation.upsert as jest.Mock).mockResolvedValue({
      fromUserId: 1, restaurantId: 7, tip: 'great pizza',
    });

    const res = await request(buildApp())
      .post('/api/social/recommendations/7')
      .set('Cookie', authCookie(1))
      .send({ tip: 'great pizza' });

    expect(res.status).toBe(201);
    // Publish the row so the recommender's network can actually open it.
    expect(mockPrisma.restaurant.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { private: false },
    });
    expect(mockPrisma.recommendation.upsert).toHaveBeenCalled();
  });

  it('accepts a recommendation on a public restaurant without touching privacy', async () => {
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
      id: 7, private: false, createdBy: 99,
    });
    (mockPrisma.recommendation.upsert as jest.Mock).mockResolvedValue({
      fromUserId: 1, restaurantId: 7, tip: null,
    });

    const res = await request(buildApp())
      .post('/api/social/recommendations/7')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(201);
    expect(mockPrisma.restaurant.update).not.toHaveBeenCalled();
  });
});

// ── Recommendation lists ──────────────────────────────────────

describe('POST /api/social/lists', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockPrisma.recommendationList.count as jest.Mock).mockResolvedValue(0);
  });

  it('creates a list with default NETWORK visibility', async () => {
    (mockPrisma.recommendationList.create as jest.Mock).mockResolvedValue({
      id: 10, userId: 1, name: 'Date night', description: null, color: null,
      visibility: 'NETWORK', position: 0, entries: [],
    });
    const res = await request(buildApp())
      .post('/api/social/lists').set('Cookie', authCookie(1))
      .send({ name: 'Date night' });
    expect(res.status).toBe(201);
    expect(res.body.list.visibility).toBe('NETWORK');
    expect(mockPrisma.recommendationList.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'Date night', visibility: 'NETWORK' }) }),
    );
  });

  it('rejects empty name', async () => {
    const res = await request(buildApp())
      .post('/api/social/lists').set('Cookie', authCookie(1))
      .send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
  });

  it('rejects invalid visibility', async () => {
    const res = await request(buildApp())
      .post('/api/social/lists').set('Cookie', authCookie(1))
      .send({ name: 'OK', visibility: 'PUBLIC' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/visibility must be one of/i);
  });

  it('enforces per-user list cap', async () => {
    (mockPrisma.recommendationList.count as jest.Mock).mockResolvedValueOnce(50);
    const res = await request(buildApp())
      .post('/api/social/lists').set('Cookie', authCookie(1))
      .send({ name: 'Fifty-first' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 50/i);
  });
});

describe('DELETE /api/social/lists/:id', () => {
  it("returns 404 when the list isn't the caller's", async () => {
    (mockPrisma.recommendationList.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    const res = await request(buildApp())
      .delete('/api/social/lists/77').set('Cookie', authCookie(1));
    expect(res.status).toBe(404);
  });

  it('204s on success and scopes by userId', async () => {
    (mockPrisma.recommendationList.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
    const res = await request(buildApp())
      .delete('/api/social/lists/77').set('Cookie', authCookie(1));
    expect(res.status).toBe(204);
    expect(mockPrisma.recommendationList.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 77, userId: 1 } }),
    );
  });
});

describe('POST /api/social/lists/:id/share', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires the recipient to have visibility access', async () => {
    (mockPrisma.recommendationList.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 5, name: 'Date night', visibility: 'FRIENDS',
    });
    // Recipient is neither friend nor follower
    (mockPrisma.friendRequest.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.follow.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(buildApp())
      .post('/api/social/lists/5/share').set('Cookie', authCookie(1))
      .send({ friendUserId: 99 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot see/i);
  });

  it('rejects sharing with self', async () => {
    const res = await request(buildApp())
      .post('/api/social/lists/5/share').set('Cookie', authCookie(1))
      .send({ friendUserId: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/yourself/i);
  });

  it("returns 404 when the list isn't the caller's", async () => {
    (mockPrisma.recommendationList.findFirst as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(buildApp())
      .post('/api/social/lists/5/share').set('Cookie', authCookie(1))
      .send({ friendUserId: 99 });
    expect(res.status).toBe(404);
  });

  it('succeeds when the recipient is a friend (FRIENDS visibility)', async () => {
    // findFirst is called twice: once for the list lookup, once for the
    // friendship check inside viewerCanSeeList. Use mockResolvedValueOnce
    // chains so each call returns the right shape.
    (mockPrisma.recommendationList.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 5, name: 'Date night', visibility: 'FRIENDS',
    });
    (mockPrisma.friendRequest.findFirst as jest.Mock).mockResolvedValue({ id: 9 });

    const res = await request(buildApp())
      .post('/api/social/lists/5/share').set('Cookie', authCookie(1))
      .send({ friendUserId: 99 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // The follow check shouldn't fire — the FRIENDS branch short-circuits
    // once friendship is confirmed. If a future refactor breaks the
    // short-circuit, this catches the wasted DB hit.
    expect(mockPrisma.follow.findFirst).not.toHaveBeenCalled();
  });

  it('succeeds when the recipient follows the caller (FOLLOWERS visibility)', async () => {
    (mockPrisma.recommendationList.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 5, name: 'Faves', visibility: 'FOLLOWERS',
    });
    // FOLLOWERS skips the friendship branch entirely — only the follow
    // check runs. Setting friendRequest.findFirst to a non-null value
    // here would falsely "pass" the test even if the code path was
    // wrong, so we leave it unmocked (defaults to undefined) and
    // mock the follow lookup explicitly.
    (mockPrisma.follow.findFirst as jest.Mock).mockResolvedValue({ followerId: 99 });

    const res = await request(buildApp())
      .post('/api/social/lists/5/share').set('Cookie', authCookie(1))
      .send({ friendUserId: 99 });
    expect(res.status).toBe(200);
  });

  it('succeeds for NETWORK visibility when only the follow check passes', async () => {
    // NETWORK = friend OR follower. Verify the OR by passing only the
    // follow check; the friend lookup returns null first, then the code
    // falls through to follow.
    (mockPrisma.recommendationList.findFirst as jest.Mock).mockResolvedValueOnce({
      id: 5, name: 'Pizza spots', visibility: 'NETWORK',
    });
    (mockPrisma.friendRequest.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.follow.findFirst as jest.Mock).mockResolvedValue({ followerId: 99 });

    const res = await request(buildApp())
      .post('/api/social/lists/5/share').set('Cookie', authCookie(1))
      .send({ friendUserId: 99 });
    expect(res.status).toBe(200);
  });

  it('rejects a non-positive friendUserId', async () => {
    const res = await request(buildApp())
      .post('/api/social/lists/5/share').set('Cookie', authCookie(1))
      .send({ friendUserId: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/positive integer/i);
  });
});

describe('GET /api/social/lists/mine', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/social/lists/mine');
    expect(res.status).toBe(401);
  });

  it('returns every list the caller owns, scoped by userId', async () => {
    (mockPrisma.recommendationList.findMany as jest.Mock).mockResolvedValue([
      { id: 1, userId: 1, name: 'Date night', visibility: 'NETWORK', entries: [] },
      { id: 2, userId: 1, name: 'Quick lunch', visibility: 'FRIENDS',  entries: [] },
    ]);

    const res = await request(buildApp())
      .get('/api/social/lists/mine').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.lists).toHaveLength(2);
    // The where-clause scoping is the load-bearing piece — if a future
    // refactor drops the userId filter, a caller would see every user's
    // lists. Assert it explicitly.
    expect(mockPrisma.recommendationList.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 1 } }),
    );
  });
});

describe('PATCH /api/social/lists/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 on a non-numeric id', async () => {
    const res = await request(buildApp())
      .patch('/api/social/lists/not-a-number').set('Cookie', authCookie(1))
      .send({ name: 'New name' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when no fields are supplied', async () => {
    const res = await request(buildApp())
      .patch('/api/social/lists/5').set('Cookie', authCookie(1))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one field/i);
  });

  it('returns 400 on invalid visibility', async () => {
    const res = await request(buildApp())
      .patch('/api/social/lists/5').set('Cookie', authCookie(1))
      .send({ visibility: 'PUBLIC' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/visibility must be one of/i);
  });

  it('returns 400 on invalid color (non-hex)', async () => {
    const res = await request(buildApp())
      .patch('/api/social/lists/5').set('Cookie', authCookie(1))
      .send({ color: 'red' });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the list isn't the caller's (updateMany count=0)", async () => {
    (mockPrisma.recommendationList.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    const res = await request(buildApp())
      .patch('/api/social/lists/5').set('Cookie', authCookie(1))
      .send({ name: 'Renamed' });
    expect(res.status).toBe(404);
  });

  it('updates and returns the refreshed list scoped by userId', async () => {
    (mockPrisma.recommendationList.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (mockPrisma.recommendationList.findUnique as jest.Mock).mockResolvedValue({
      id: 5, userId: 1, name: 'Renamed', visibility: 'NETWORK', entries: [],
    });

    const res = await request(buildApp())
      .patch('/api/social/lists/5').set('Cookie', authCookie(1))
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.list.name).toBe('Renamed');
    expect(mockPrisma.recommendationList.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5, userId: 1 },
        data: { name: 'Renamed' },
      }),
    );
  });

  it('returns 409 on duplicate-name P2002', async () => {
    (mockPrisma.recommendationList.updateMany as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    const res = await request(buildApp())
      .patch('/api/social/lists/5').set('Cookie', authCookie(1))
      .send({ name: 'DupName' });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/social/lists/:id/entries/:restaurantId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 on non-integer ids', async () => {
    const res = await request(buildApp())
      .post('/api/social/lists/abc/entries/7').set('Cookie', authCookie(1));
    expect(res.status).toBe(400);
  });

  it('returns 400 when tip exceeds 500 chars', async () => {
    const res = await request(buildApp())
      .post('/api/social/lists/5/entries/7').set('Cookie', authCookie(1))
      .send({ tip: 'x'.repeat(501) });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the list isn't the caller's", async () => {
    (mockPrisma.recommendationList.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await request(buildApp())
      .post('/api/social/lists/5/entries/7').set('Cookie', authCookie(1));
    expect(res.status).toBe(404);
    // Critical: we must not upsert a recommendation when ownership fails —
    // otherwise the caller could create a Recommendation on any restaurant
    // by failing the list-ownership check first.
    expect(mockPrisma.recommendation.upsert).not.toHaveBeenCalled();
  });

  it('upserts the underlying recommendation and adds the entry', async () => {
    (mockPrisma.recommendationList.findFirst as jest.Mock).mockResolvedValue({ id: 5 });
    (mockPrisma.recommendation.upsert as jest.Mock).mockResolvedValue({ id: 42 });
    (mockPrisma.recommendationListEntry.count  as jest.Mock).mockResolvedValue(3);
    (mockPrisma.recommendationListEntry.create as jest.Mock).mockResolvedValue({
      listId: 5, recommendationId: 42, position: 3,
    });
    (mockPrisma.recommendationList.findUnique as jest.Mock).mockResolvedValue({
      id: 5, name: 'Faves', entries: [],
    });

    const res = await request(buildApp())
      .post('/api/social/lists/5/entries/7').set('Cookie', authCookie(1))
      .send({ tip: 'great pizza' });

    expect(res.status).toBe(200);
    expect(mockPrisma.recommendation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where:  { fromUserId_restaurantId: { fromUserId: 1, restaurantId: 7 } },
        create: { fromUserId: 1, restaurantId: 7, tip: 'great pizza' },
      }),
    );
    expect(mockPrisma.recommendationListEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { listId: 5, recommendationId: 42, position: 3 },
      }),
    );
  });

  it('treats P2002 on entry create as a no-op success (re-add safe)', async () => {
    (mockPrisma.recommendationList.findFirst   as jest.Mock).mockResolvedValue({ id: 5 });
    (mockPrisma.recommendation.upsert          as jest.Mock).mockResolvedValue({ id: 42 });
    (mockPrisma.recommendationListEntry.count  as jest.Mock).mockResolvedValue(0);
    (mockPrisma.recommendationListEntry.create as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    (mockPrisma.recommendationList.findUnique as jest.Mock).mockResolvedValue({
      id: 5, name: 'Faves', entries: [],
    });

    const res = await request(buildApp())
      .post('/api/social/lists/5/entries/7').set('Cookie', authCookie(1));

    // Adding the same restaurant twice is idempotent — re-add returns 200,
    // not 409. Otherwise the UI would have to error-handle a benign user
    // action ("I already added that one").
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/social/lists/:id/entries/:restaurantId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 on non-integer ids', async () => {
    const res = await request(buildApp())
      .delete('/api/social/lists/abc/entries/7').set('Cookie', authCookie(1));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the list isn't the caller's", async () => {
    (mockPrisma.recommendationList.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await request(buildApp())
      .delete('/api/social/lists/5/entries/7').set('Cookie', authCookie(1));
    expect(res.status).toBe(404);
    expect(mockPrisma.recommendationListEntry.deleteMany).not.toHaveBeenCalled();
  });

  it('204s without touching deleteMany when no Recommendation exists (already gone)', async () => {
    (mockPrisma.recommendationList.findFirst as jest.Mock).mockResolvedValue({ id: 5 });
    (mockPrisma.recommendation.findUnique     as jest.Mock).mockResolvedValue(null);

    const res = await request(buildApp())
      .delete('/api/social/lists/5/entries/7').set('Cookie', authCookie(1));
    expect(res.status).toBe(204);
    expect(mockPrisma.recommendationListEntry.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes the entry row but leaves the underlying Recommendation intact', async () => {
    (mockPrisma.recommendationList.findFirst as jest.Mock).mockResolvedValue({ id: 5 });
    (mockPrisma.recommendation.findUnique     as jest.Mock).mockResolvedValue({ id: 42 });
    (mockPrisma.recommendationListEntry.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const res = await request(buildApp())
      .delete('/api/social/lists/5/entries/7').set('Cookie', authCookie(1));

    expect(res.status).toBe(204);
    expect(mockPrisma.recommendationListEntry.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { listId: 5, recommendationId: 42 } }),
    );
    // The recommendation itself stays alive — removing a list entry isn't
    // the same as un-recommending the restaurant. Regression guard for a
    // refactor that decides to also drop the standalone rec.
    expect(mockPrisma.recommendation.delete).not.toHaveBeenCalled();
  });
});

describe('GET /api/social/users/:userId/lists', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 on a non-integer userId', async () => {
    const res = await request(buildApp())
      .get('/api/social/users/abc/lists').set('Cookie', authCookie(1));
    expect(res.status).toBe(400);
  });

  it('returns an empty array when the target owns no lists (short-circuits relationship checks)', async () => {
    (mockPrisma.recommendationList.findMany as jest.Mock).mockResolvedValue([]);
    const res = await request(buildApp())
      .get('/api/social/users/99/lists').set('Cookie', authCookie(1));
    expect(res.status).toBe(200);
    expect(res.body.lists).toEqual([]);
    // Empty case must NOT hit the relationship checks — those are
    // wasted DB queries when there's nothing to filter.
    expect(mockPrisma.friendRequest.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.follow.findFirst).not.toHaveBeenCalled();
  });

  it('filters out FRIENDS lists when the viewer is not a friend', async () => {
    (mockPrisma.recommendationList.findMany as jest.Mock).mockResolvedValue([
      { id: 1, userId: 99, name: 'For friends',   visibility: 'FRIENDS',   entries: [] },
      { id: 2, userId: 99, name: 'For followers', visibility: 'FOLLOWERS', entries: [] },
    ]);
    (mockPrisma.friendRequest.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.follow.findFirst        as jest.Mock).mockResolvedValue({ followerId: 1 });

    const res = await request(buildApp())
      .get('/api/social/users/99/lists').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    // Only the FOLLOWERS list is returned — FRIENDS is dropped silently
    // (not surfaced as "private", which would leak existence).
    expect(res.body.lists).toHaveLength(1);
    expect(res.body.lists[0].visibility).toBe('FOLLOWERS');
  });

  it('returns FOLLOWERS-tier lists to friends (cross-tier visibility)', async () => {
    // The route explicitly grants friends access to FOLLOWERS lists too
    // — see GET /users/:userId/lists at routes/social.ts. Friend status
    // is the strongest tier, so a friend who isn't following can still
    // see follower-tier content. Guard against a refactor that
    // accidentally tightens this back.
    (mockPrisma.recommendationList.findMany as jest.Mock).mockResolvedValue([
      { id: 1, userId: 99, name: 'For followers', visibility: 'FOLLOWERS', entries: [] },
    ]);
    (mockPrisma.friendRequest.findFirst as jest.Mock).mockResolvedValue({ id: 9 });
    (mockPrisma.follow.findFirst        as jest.Mock).mockResolvedValue(null);

    const res = await request(buildApp())
      .get('/api/social/users/99/lists').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.lists).toHaveLength(1);
  });

  it('returns all lists to the owner themselves (viewer === owner)', async () => {
    // When the viewer is asking for their own lists, every visibility
    // tier is returned without any relationship lookup.
    (mockPrisma.recommendationList.findMany as jest.Mock).mockResolvedValue([
      { id: 1, userId: 1, visibility: 'FRIENDS',   entries: [] },
      { id: 2, userId: 1, visibility: 'FOLLOWERS', entries: [] },
      { id: 3, userId: 1, visibility: 'NETWORK',   entries: [] },
    ]);

    const res = await request(buildApp())
      .get('/api/social/users/1/lists').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.lists).toHaveLength(3);
    expect(mockPrisma.friendRequest.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.follow.findFirst).not.toHaveBeenCalled();
  });
});
