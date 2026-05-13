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

describe('POST /api/users/me/selections/:restaurantId', () => {
  it('returns 201 when selection is added', async () => {
    (mockPrisma.userSelection.upsert as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .post('/api/users/me/selections/7')
      .set('Cookie', authCookie());

    expect(res.status).toBe(201);
  });
});

describe('DELETE /api/users/me/selections/:restaurantId', () => {
  it('returns 200 and removes the selection', async () => {
    (mockPrisma.userSelection.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const res = await request(buildApp())
      .delete('/api/users/me/selections/7')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/users/me', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).delete('/api/users/me');
    expect(res.status).toBe(401);
  });

  it('deletes the user, clears the token cookie, and returns 200', async () => {
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
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.userFavorite.deleteMany).toHaveBeenCalledWith({ where: { userId: 1, restaurantId: 5 } });
    expect(mockPrisma.userSelection.deleteMany).toHaveBeenCalledWith({ where: { userId: 1, restaurantId: 5 } });
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
    (mockPrisma.review.groupBy as jest.Mock).mockResolvedValue([
      { userId: 1, _avg: { rating: 4 } },
      { userId: 2, _avg: { rating: 5 } },
    ]);
    (mockPrisma.restaurant.update as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .post('/api/users/me/reviews')
      .set('Cookie', authCookie())
      .send({ restaurantId: 5, rating: 4, content: 'Solid' });

    expect(res.status).toBe(201);
    expect(res.body.review.id).toBe(42);

    // recomputeCommunityRating fires async — wait a tick for it to run
    await new Promise((r) => setImmediate(r));
    expect(mockPrisma.review.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ['userId'],
      where: { restaurantId: 5 },
    }));
    expect(mockPrisma.restaurant.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { communityRating: 4.5 }, // (4 + 5) / 2
    });
  });

  it('sets communityRating to null when no reviews remain after delete', async () => {
    (mockPrisma.review.findFirst as jest.Mock).mockResolvedValue({ restaurantId: 7 });
    (mockPrisma.review.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
    (mockPrisma.review.groupBy as jest.Mock).mockResolvedValue([]); // no reviewers left
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
      favorites: [], selections: [], accepted: [],
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
      favorites: [{ restaurantId: 1 }], selections: [], accepted: [],
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
      favorites: [{ restaurantId: 1 }], selections: [], accepted: [],
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
      favorites: [{ restaurantId: 1 }, { restaurantId: 2 }], selections: [], accepted: [],
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
});
