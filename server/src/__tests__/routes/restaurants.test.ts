import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { DeepMockProxy } from 'jest-mock-extended';

jest.mock('../../lib/prisma');

import prisma from '../../lib/prisma';
import restaurantsRouter from '../../routes/restaurants';

const mockPrisma = prisma as unknown as DeepMockProxy<PrismaClient>;
const SECRET = process.env.JWT_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/restaurants', restaurantsRouter);
  return app;
}

const authCookie = (userId = 1) => `token=${jwt.sign({ userId }, SECRET)}`;

const fakeRestaurant = {
  id: 1,
  name: 'Burger Joint',
  googlePlaceId: null,
  cuisineType: 'American',
  priceLevel: 2,
  hours: '11am–10pm',
  phone: null,
  website: null,
  yelpUrl: null,
  takeout: true,
  delivery: false,
  googleRating: null,
  createdBy: 1,
  createdAt: new Date(),
};

describe('GET /api/restaurants', () => {
  it('returns a paginated list of restaurants', async () => {
    (mockPrisma.restaurant.findMany as jest.Mock).mockResolvedValue([fakeRestaurant]);
    (mockPrisma.restaurant.count as jest.Mock).mockResolvedValue(1);

    const res = await request(buildApp()).get('/api/restaurants');

    expect(res.status).toBe(200);
    expect(res.body.restaurants).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });
});

describe('GET /api/restaurants/:id', () => {
  it('returns 200 with the restaurant when found', async () => {
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue(fakeRestaurant);

    const res = await request(buildApp()).get('/api/restaurants/1');

    expect(res.status).toBe(200);
    expect(res.body.restaurant.name).toBe('Burger Joint');
  });

  it('returns 404 when restaurant does not exist', async () => {
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(buildApp()).get('/api/restaurants/999');

    expect(res.status).toBe(404);
  });
});

describe('POST /api/restaurants', () => {
  it('returns 401 when not authenticated', async () => {
    const res = await request(buildApp())
      .post('/api/restaurants')
      .send({ name: 'New Place' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(buildApp())
      .post('/api/restaurants')
      .set('Cookie', authCookie())
      .send({});

    expect(res.status).toBe(400);
  });

  it('creates a restaurant and returns 201', async () => {
    (mockPrisma.restaurant.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.restaurant.create as jest.Mock).mockResolvedValue(fakeRestaurant);

    const res = await request(buildApp())
      .post('/api/restaurants')
      .set('Cookie', authCookie())
      .send({ name: 'Burger Joint' });

    expect(res.status).toBe(201);
    expect(res.body.restaurant.name).toBe('Burger Joint');
  });

  it('returns the existing restaurant (200, no create) when name already exists (case-insensitive)', async () => {
    // The route is now strict find-or-create: existing rows are returned untouched
    // (no field overwrite). 200 vs 201 lets callers distinguish "found" from
    // "created" — and importantly, restaurant.create must not be invoked.
    (mockPrisma.restaurant.findFirst as jest.Mock).mockResolvedValue(fakeRestaurant);

    const res = await request(buildApp())
      .post('/api/restaurants')
      .set('Cookie', authCookie())
      .send({ name: 'burger joint' });

    expect(res.status).toBe(200);
    expect(mockPrisma.restaurant.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/restaurants/:id/match-settings', () => {
  // The opt-out toggle is auth-gated, creator-gated, and rejects
  // Google-sourced rows. Each branch gets a focused test below.

  it('returns 401 when not authenticated', async () => {
    const res = await request(buildApp())
      .patch('/api/restaurants/1/match-settings')
      .send({ excludeFromPlaceMatching: true });
    expect(res.status).toBe(401);
  });

  it('returns 400 when excludeFromPlaceMatching is missing or not a boolean', async () => {
    const r1 = await request(buildApp())
      .patch('/api/restaurants/1/match-settings')
      .set('Cookie', authCookie())
      .send({});
    expect(r1.status).toBe(400);

    const r2 = await request(buildApp())
      .patch('/api/restaurants/1/match-settings')
      .set('Cookie', authCookie())
      .send({ excludeFromPlaceMatching: 'yes' });
    expect(r2.status).toBe(400);
  });

  it('returns 404 when the restaurant does not exist', async () => {
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(buildApp())
      .patch('/api/restaurants/999/match-settings')
      .set('Cookie', authCookie())
      .send({ excludeFromPlaceMatching: true });
    expect(res.status).toBe(404);
  });

  it('returns 403 when caller is not the creator', async () => {
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
      id: 1, createdBy: 99, googlePlaceId: null,
    });
    const res = await request(buildApp())
      .patch('/api/restaurants/1/match-settings')
      .set('Cookie', authCookie(1))
      .send({ excludeFromPlaceMatching: true });
    expect(res.status).toBe(403);
    expect(mockPrisma.restaurant.update).not.toHaveBeenCalled();
  });

  it('returns 400 when the row is Google-sourced (has googlePlaceId)', async () => {
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
      id: 1, createdBy: 1, googlePlaceId: 'ChIJxxx',
    });
    const res = await request(buildApp())
      .patch('/api/restaurants/1/match-settings')
      .set('Cookie', authCookie(1))
      .send({ excludeFromPlaceMatching: true });
    expect(res.status).toBe(400);
    expect(mockPrisma.restaurant.update).not.toHaveBeenCalled();
  });

  it('flips the flag for a custom row owned by the caller', async () => {
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
      id: 1, createdBy: 1, googlePlaceId: null,
    });
    (mockPrisma.restaurant.update as jest.Mock).mockResolvedValue({
      id: 1, excludeFromPlaceMatching: true,
    });
    const res = await request(buildApp())
      .patch('/api/restaurants/1/match-settings')
      .set('Cookie', authCookie(1))
      .send({ excludeFromPlaceMatching: true });
    expect(res.status).toBe(200);
    expect(res.body.restaurant).toEqual({ id: 1, excludeFromPlaceMatching: true });
    expect(mockPrisma.restaurant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data:  { excludeFromPlaceMatching: true },
      }),
    );
  });
});

describe('POST /api/restaurants/:customId/link-to-place', () => {
  // The merge endpoint is the riskiest write surface in this file —
  // it migrates user collection references inside a transaction and
  // conditionally deletes the source row. Tests cover ownership +
  // shape validation (cheap), then walk the collision branches
  // (favorites/options/archives each have a unique constraint) and
  // confirm the source-row delete only happens when private +
  // unreferenced.

  // Helper: a typical $transaction mock that runs the inner callback
  // against the same prisma mock. Lets us assert on individual table
  // calls without a separate test fixture.
  const wireTransaction = () => {
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: typeof mockPrisma) => Promise<unknown>)(mockPrisma);
      }
      return undefined;
    });
  };

  beforeEach(() => {
    wireTransaction();
    // Default mocks for the no-collision happy path — individual
    // tests override as needed.
    (mockPrisma.userFavorite.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.userOption.findUnique   as jest.Mock).mockResolvedValue(null);
    (mockPrisma.userArchive.findUnique  as jest.Mock).mockResolvedValue(null);
    (mockPrisma.userFavorite.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.userFavorite.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.userOption.updateMany   as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.userOption.deleteMany   as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.userArchive.updateMany  as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.userArchive.deleteMany  as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.userAccepted.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.review.updateMany       as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.userFavorite.count as jest.Mock).mockResolvedValue(0);
    (mockPrisma.userOption.count   as jest.Mock).mockResolvedValue(0);
    (mockPrisma.userArchive.count  as jest.Mock).mockResolvedValue(0);
    (mockPrisma.userAccepted.count as jest.Mock).mockResolvedValue(0);
    (mockPrisma.review.count       as jest.Mock).mockResolvedValue(0);
    (mockPrisma.restaurant.delete  as jest.Mock).mockResolvedValue({ id: 1 });
  });

  // Wire up the precondition findUniques. First call resolves the
  // custom row, second resolves the place row — both fired in a
  // Promise.all so they're called sequentially against the mock.
  const wireRows = (custom: unknown, place: unknown) => {
    (mockPrisma.restaurant.findUnique as jest.Mock)
      .mockResolvedValueOnce(custom)
      .mockResolvedValueOnce(place);
  };

  it('returns 401 when not authenticated', async () => {
    const res = await request(buildApp())
      .post('/api/restaurants/1/link-to-place')
      .send({ placeRestaurantId: 2 });
    expect(res.status).toBe(401);
  });

  it('returns 400 when placeRestaurantId is missing or invalid', async () => {
    const r1 = await request(buildApp())
      .post('/api/restaurants/1/link-to-place')
      .set('Cookie', authCookie())
      .send({});
    expect(r1.status).toBe(400);

    const r2 = await request(buildApp())
      .post('/api/restaurants/1/link-to-place')
      .set('Cookie', authCookie())
      .send({ placeRestaurantId: 'not-a-number' });
    expect(r2.status).toBe(400);
  });

  it('returns 400 when customId equals placeRestaurantId', async () => {
    const res = await request(buildApp())
      .post('/api/restaurants/1/link-to-place')
      .set('Cookie', authCookie())
      .send({ placeRestaurantId: 1 });
    expect(res.status).toBe(400);
  });

  it('returns 404 when custom row does not exist', async () => {
    wireRows(null, { id: 2, googlePlaceId: 'ChIJ-target' });
    const res = await request(buildApp())
      .post('/api/restaurants/1/link-to-place')
      .set('Cookie', authCookie())
      .send({ placeRestaurantId: 2 });
    expect(res.status).toBe(404);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 404 when place row does not exist', async () => {
    wireRows(
      { id: 1, createdBy: 1, googlePlaceId: null, private: true },
      null,
    );
    const res = await request(buildApp())
      .post('/api/restaurants/1/link-to-place')
      .set('Cookie', authCookie())
      .send({ placeRestaurantId: 2 });
    expect(res.status).toBe(404);
  });

  it('returns 403 when caller is not the custom row creator', async () => {
    wireRows(
      { id: 1, createdBy: 99, googlePlaceId: null, private: true },
      { id: 2, googlePlaceId: 'ChIJ-target' },
    );
    const res = await request(buildApp())
      .post('/api/restaurants/1/link-to-place')
      .set('Cookie', authCookie(1))
      .send({ placeRestaurantId: 2 });
    expect(res.status).toBe(403);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 400 when source row already has a googlePlaceId (not custom)', async () => {
    wireRows(
      { id: 1, createdBy: 1, googlePlaceId: 'ChIJ-something', private: false },
      { id: 2, googlePlaceId: 'ChIJ-target' },
    );
    const res = await request(buildApp())
      .post('/api/restaurants/1/link-to-place')
      .set('Cookie', authCookie(1))
      .send({ placeRestaurantId: 2 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when target row has no googlePlaceId (not a Place row)', async () => {
    wireRows(
      { id: 1, createdBy: 1, googlePlaceId: null, private: true },
      { id: 2, googlePlaceId: null },
    );
    const res = await request(buildApp())
      .post('/api/restaurants/1/link-to-place')
      .set('Cookie', authCookie(1))
      .send({ placeRestaurantId: 2 });
    expect(res.status).toBe(400);
  });

  it('migrates user collection refs and deletes the custom row on the happy path', async () => {
    // Private custom row with no other-user references → fully
    // migrated AND deleted at the end.
    wireRows(
      { id: 1, createdBy: 1, googlePlaceId: null, private: true },
      { id: 2, googlePlaceId: 'ChIJ-target' },
    );
    const res = await request(buildApp())
      .post('/api/restaurants/1/link-to-place')
      .set('Cookie', authCookie(1))
      .send({ placeRestaurantId: 2 });
    expect(res.status).toBe(200);
    expect(res.body.mergedRestaurantId).toBe(2);
    // All four migration tables saw an updateMany.
    expect(mockPrisma.userFavorite.updateMany).toHaveBeenCalledWith({
      where: { userId: 1, restaurantId: 1 },
      data:  { restaurantId: 2 },
    });
    expect(mockPrisma.userOption.updateMany).toHaveBeenCalledWith({
      where: { userId: 1, restaurantId: 1 },
      data:  { restaurantId: 2 },
    });
    expect(mockPrisma.userArchive.updateMany).toHaveBeenCalledWith({
      where: { userId: 1, restaurantId: 1 },
      data:  { restaurantId: 2 },
    });
    expect(mockPrisma.userAccepted.updateMany).toHaveBeenCalledWith({
      where: { userId: 1, restaurantId: 1 },
      data:  { restaurantId: 2 },
    });
    expect(mockPrisma.review.updateMany).toHaveBeenCalledWith({
      where: { userId: 1, restaurantId: 1 },
      data:  { restaurantId: 2 },
    });
    // Custom row deleted at the end since private + no other refs.
    expect(mockPrisma.restaurant.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it('deletes the custom-side favorite (instead of re-pointing) when user already has the place favorited', async () => {
    // Collision: user has BOTH the custom and the place in favorites.
    // The unique (userId, restaurantId) constraint means we can't
    // updateMany the custom-side row to place-side — it would
    // duplicate-key. Branch should deleteMany the custom-side row
    // and leave the place-side intact.
    wireRows(
      { id: 1, createdBy: 1, googlePlaceId: null, private: true },
      { id: 2, googlePlaceId: 'ChIJ-target' },
    );
    (mockPrisma.userFavorite.findUnique as jest.Mock).mockResolvedValue({ userId: 1 });

    const res = await request(buildApp())
      .post('/api/restaurants/1/link-to-place')
      .set('Cookie', authCookie(1))
      .send({ placeRestaurantId: 2 });
    expect(res.status).toBe(200);
    // Custom-side favorite deleted, NOT updateMany'd.
    expect(mockPrisma.userFavorite.deleteMany).toHaveBeenCalledWith({
      where: { userId: 1, restaurantId: 1 },
    });
    expect(mockPrisma.userFavorite.updateMany).not.toHaveBeenCalled();
    // Other tables still re-pointed normally.
    expect(mockPrisma.userOption.updateMany).toHaveBeenCalled();
  });

  it('deletes the custom-side option when user already has the place in options', async () => {
    wireRows(
      { id: 1, createdBy: 1, googlePlaceId: null, private: true },
      { id: 2, googlePlaceId: 'ChIJ-target' },
    );
    (mockPrisma.userOption.findUnique as jest.Mock).mockResolvedValue({ userId: 1 });

    const res = await request(buildApp())
      .post('/api/restaurants/1/link-to-place')
      .set('Cookie', authCookie(1))
      .send({ placeRestaurantId: 2 });
    expect(res.status).toBe(200);
    expect(mockPrisma.userOption.deleteMany).toHaveBeenCalledWith({
      where: { userId: 1, restaurantId: 1 },
    });
    expect(mockPrisma.userOption.updateMany).not.toHaveBeenCalled();
  });

  it('deletes the custom-side archive when user already has the place archived', async () => {
    wireRows(
      { id: 1, createdBy: 1, googlePlaceId: null, private: true },
      { id: 2, googlePlaceId: 'ChIJ-target' },
    );
    (mockPrisma.userArchive.findUnique as jest.Mock).mockResolvedValue({ userId: 1 });

    const res = await request(buildApp())
      .post('/api/restaurants/1/link-to-place')
      .set('Cookie', authCookie(1))
      .send({ placeRestaurantId: 2 });
    expect(res.status).toBe(200);
    expect(mockPrisma.userArchive.deleteMany).toHaveBeenCalledWith({
      where: { userId: 1, restaurantId: 1 },
    });
    expect(mockPrisma.userArchive.updateMany).not.toHaveBeenCalled();
  });

  it('preserves the custom row when public (someone else might reference it)', async () => {
    // Public custom row — the row was shared via a group, so other
    // users may still see it. Refs are migrated but the row stays.
    wireRows(
      { id: 1, createdBy: 1, googlePlaceId: null, private: false },
      { id: 2, googlePlaceId: 'ChIJ-target' },
    );
    const res = await request(buildApp())
      .post('/api/restaurants/1/link-to-place')
      .set('Cookie', authCookie(1))
      .send({ placeRestaurantId: 2 });
    expect(res.status).toBe(200);
    // Migration ran but delete did NOT.
    expect(mockPrisma.userFavorite.updateMany).toHaveBeenCalled();
    expect(mockPrisma.restaurant.delete).not.toHaveBeenCalled();
  });

  it('preserves a private custom row that still has references from someone else', async () => {
    // Edge case: a private row that another user shouldn't be able
    // to reference, but defensively we still check. If any count is
    // non-zero we skip the delete to avoid yanking a row out from
    // under a co-creator.
    wireRows(
      { id: 1, createdBy: 1, googlePlaceId: null, private: true },
      { id: 2, googlePlaceId: 'ChIJ-target' },
    );
    // Simulate a leftover reference (e.g. another user has it favorited).
    (mockPrisma.userFavorite.count as jest.Mock).mockResolvedValue(1);

    const res = await request(buildApp())
      .post('/api/restaurants/1/link-to-place')
      .set('Cookie', authCookie(1))
      .send({ placeRestaurantId: 2 });
    expect(res.status).toBe(200);
    expect(mockPrisma.restaurant.delete).not.toHaveBeenCalled();
  });
});

describe('GET /api/restaurants/:id/reviews', () => {
  it('returns reviews and community rating', async () => {
    // First findUnique is the visibility short-circuit: public row → keep going.
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({ private: false, createdBy: null });
    (mockPrisma.review.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.review.aggregate as jest.Mock).mockResolvedValue({ _avg: { rating: null }, _count: 0 });
    (mockPrisma.review.groupBy as jest.Mock).mockResolvedValue([]);

    const res = await request(buildApp()).get('/api/restaurants/1/reviews');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('reviews');
    expect(res.body).toHaveProperty('communityRating');
    expect(res.body.averageRating).toBeNull();
    expect(res.body.total).toBe(0);
  });

  it('returns 404 for a private restaurant when the viewer is not the creator', async () => {
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({ private: true, createdBy: 99 });
    const res = await request(buildApp()).get('/api/restaurants/1/reviews');
    expect(res.status).toBe(404);
    // The expensive aggregate query must not run if visibility short-circuits.
    expect(mockPrisma.review.findMany).not.toHaveBeenCalled();
  });
});
