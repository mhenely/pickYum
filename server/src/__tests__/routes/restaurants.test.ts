import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { DeepMockProxy } from 'jest-mock-extended';

jest.mock('../../lib/prisma');

// photoStorage talks to Supabase Storage + Google's signed CDN. Mocking
// here lets each test declare what `downloadAndStoreAll` returns without
// any real network I/O. The materialize handler treats `undefined` as
// "couldn't store" → skips the photos update step; an empty array does
// the same (filtered out before the update). A populated array triggers
// the post-create update with storage URLs.
jest.mock('../../lib/photoStorage', () => ({
  downloadAndStoreAll: jest.fn().mockResolvedValue([]),
}));

import prisma from '../../lib/prisma';
import restaurantsRouter from '../../routes/restaurants';
import { downloadAndStoreAll } from '../../lib/photoStorage';

const mockDownloadAndStoreAll = downloadAndStoreAll as jest.Mock;

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

  it('PERSISTS photos as Supabase Storage URLs when the client supplies Google refs', async () => {
    // Regression guard for the photo-storage migration. The materialize path
    // now does TWO writes for a new row with photos:
    //   1. prisma.restaurant.create — without photos (we don't have storage
    //      URLs yet; the upload needs the row's id for its deterministic
    //      storage path).
    //   2. prisma.restaurant.update — patches the photos column with the
    //      Supabase Storage URLs returned by downloadAndStoreAll.
    //
    // If this ever fails, either the create is being called with the raw
    // Google refs again (re-introducing the stale-ref bug) or the second
    // update isn't firing (cards stay photo-less even after a successful
    // upload).
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';

    const realPlacesPhotos = [
      { name: 'places/ChIJN1t_tDeuEmsRUsoyG83frY4/photos/AaA', widthPx: 4032, heightPx: 3024 },
      { name: 'places/ChIJN1t_tDeuEmsRUsoyG83frY4/photos/BbB', widthPx: 4032, heightPx: 3024 },
    ];
    const storedPhotos = [
      { name: 'https://test.supabase.co/storage/v1/object/public/restaurant-photos/42/0.jpg', widthPx: 4032, heightPx: 3024 },
      { name: 'https://test.supabase.co/storage/v1/object/public/restaurant-photos/42/1.jpg', widthPx: 4032, heightPx: 3024 },
    ];

    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.restaurant.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.restaurant.create as jest.Mock).mockImplementation(async ({ data }) => ({
      ...fakeRestaurant, ...data, id: 42, photos: null,
    }));
    (mockPrisma.restaurant.update as jest.Mock).mockImplementation(async ({ data }) => ({
      ...fakeRestaurant, id: 42, ...data,
    }));
    mockDownloadAndStoreAll.mockResolvedValueOnce(storedPhotos);

    const res = await request(buildApp())
      .post('/api/restaurants')
      .set('Cookie', authCookie())
      .send({
        name: 'Pho 99',
        googlePlaceId: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
        photos: realPlacesPhotos,
      });

    expect(res.status).toBe(201);

    // Photo storage was invoked with the sanitized incoming refs +
    // the freshly-created row's id (deterministic storage path).
    expect(mockDownloadAndStoreAll).toHaveBeenCalledWith(expect.objectContaining({
      restaurantId: 42,
      googlePhotos: expect.arrayContaining([
        expect.objectContaining({ name: 'places/ChIJN1t_tDeuEmsRUsoyG83frY4/photos/AaA' }),
      ]),
      apiKey: 'test-key',
    }));

    // The post-create update patched the row with Supabase URLs (NOT
    // Google refs). If this ever asserts the wrong field, the stale-ref
    // bug is back.
    expect(mockPrisma.restaurant.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 42 },
      data: expect.objectContaining({
        photos: expect.arrayContaining([
          expect.objectContaining({
            name: expect.stringContaining('supabase.co/storage/v1/object/public'),
          }),
        ]),
        googleDataUpdatedAt: expect.any(Date),
      }),
    }));

    // The response echoes the stored URLs back so the client's slice
    // mirror is correct on first paint.
    expect(res.body.restaurant.photos).toHaveLength(2);
    expect(res.body.restaurant.photos[0].name).toMatch(/^https:\/\/.*\/storage\/v1\/object\/public\//);
  });

  it('skips the photo-update step when storage returns undefined (graceful no-op)', async () => {
    // When downloadAndStoreAll returns undefined (no API key, all uploads
    // failed, etc.) the materialize must still succeed — the row just
    // stays photo-less. The next search for the same place hits the
    // existing-row backfill branch and retries the storage upload.
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';

    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.restaurant.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.restaurant.create as jest.Mock).mockImplementation(async ({ data }) => ({
      ...fakeRestaurant, ...data, id: 99, photos: null,
    }));
    mockDownloadAndStoreAll.mockResolvedValueOnce([]); // all uploads failed

    const res = await request(buildApp())
      .post('/api/restaurants')
      .set('Cookie', authCookie())
      .send({
        name: 'Some Place',
        googlePlaceId: 'ChIJxxx',
        photos: [{ name: 'places/ChIJxxx/photos/AaA', widthPx: 100, heightPx: 100 }],
      });

    expect(res.status).toBe(201);
    expect(mockDownloadAndStoreAll).toHaveBeenCalled();
    // Critical: no update was issued (avoids a wasted DB round-trip for
    // a no-op patch).
    expect(mockPrisma.restaurant.update).not.toHaveBeenCalled();
    // Row still returned, just photo-less.
    expect(res.body.restaurant.photos).toBeFalsy();
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

  describe('photo backfill on existing googlePlaceId match', () => {
    // Real Places photos shape — `name` is the Google ref that gets
    // downloaded to Supabase Storage. widthPx/heightPx ride through as-is.
    const incomingPhotos = [
      { name: 'places/ChIJxxx/photos/AaA', widthPx: 4032, heightPx: 3024 },
      { name: 'places/ChIJxxx/photos/BbB', widthPx: 4032, heightPx: 3024 },
    ];
    const storedPhotos = [
      { name: 'https://test.supabase.co/storage/v1/object/public/restaurant-photos/1/0.jpg', widthPx: 4032, heightPx: 3024 },
      { name: 'https://test.supabase.co/storage/v1/object/public/restaurant-photos/1/1.jpg', widthPx: 4032, heightPx: 3024 },
    ];

    beforeEach(() => {
      jest.clearAllMocks();
      process.env.GOOGLE_PLACES_API_KEY = 'test-key';
      // Default the mock back to empty so each test opts into a payload.
      mockDownloadAndStoreAll.mockResolvedValue([]);
    });

    it('PATCHES photos with Supabase URLs when existing row has none + request supplies refs', async () => {
      // The legacy/stale-refs row that's been sitting in someone's favorites.
      (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
        ...fakeRestaurant, googlePlaceId: 'place-xyz', photos: null,
      });
      (mockPrisma.restaurant.update as jest.Mock).mockImplementation(async ({ data }) => ({
        ...fakeRestaurant, googlePlaceId: 'place-xyz', ...data,
      }));
      mockDownloadAndStoreAll.mockResolvedValueOnce(storedPhotos);

      const res = await request(buildApp())
        .post('/api/restaurants')
        .set('Cookie', authCookie())
        .send({ name: 'Burger Joint', googlePlaceId: 'place-xyz', photos: incomingPhotos });

      expect(res.status).toBe(200);
      // The download/upload was called with the existing row's id (so the
      // storage path is <existing.id>/<idx>.jpg, not a freshly-minted id).
      expect(mockDownloadAndStoreAll).toHaveBeenCalledWith(expect.objectContaining({
        restaurantId: fakeRestaurant.id,
        apiKey: 'test-key',
      }));
      // The DB update lands the storage URLs, not the Google refs. Critical
      // — saving the refs would re-introduce the stale-ref bug.
      expect(mockPrisma.restaurant.update).toHaveBeenCalledWith({
        where: { id: fakeRestaurant.id },
        data: expect.objectContaining({
          photos: expect.arrayContaining([
            expect.objectContaining({
              name: expect.stringContaining('supabase.co/storage/v1/object/public'),
            }),
          ]),
          googleDataUpdatedAt: expect.any(Date),
        }),
      });
      expect(mockPrisma.restaurant.create).not.toHaveBeenCalled();
      expect(res.body.restaurant.photos).toHaveLength(2);
    });

    it('does NOT patch when the existing row already has photos (avoids clobbering)', async () => {
      // Idempotency: subsequent searches for the same place shouldn't burn
      // Google API budget re-downloading photos we already have stored.
      const cachedPhotos = [{ name: 'https://test.supabase.co/storage/.../cached.jpg', widthPx: 1, heightPx: 1 }];
      (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
        ...fakeRestaurant, googlePlaceId: 'place-xyz', photos: cachedPhotos,
      });

      const res = await request(buildApp())
        .post('/api/restaurants')
        .set('Cookie', authCookie())
        .send({ name: 'Burger Joint', googlePlaceId: 'place-xyz', photos: incomingPhotos });

      expect(res.status).toBe(200);
      // No re-download (saves cost); no DB write (idempotent).
      expect(mockDownloadAndStoreAll).not.toHaveBeenCalled();
      expect(mockPrisma.restaurant.update).not.toHaveBeenCalled();
      expect(mockPrisma.restaurant.create).not.toHaveBeenCalled();
      expect(res.body.restaurant.photos).toEqual(cachedPhotos);
    });

    it('does NOT patch when the request omits photos (existing-row passthrough)', async () => {
      // A materialize call without photos in the body (e.g. legacy client)
      // should not even attempt a storage download — `materializePhotosToStorage`
      // returns undefined for empty input, the update step short-circuits.
      (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
        ...fakeRestaurant, googlePlaceId: 'place-xyz', photos: null,
      });

      const res = await request(buildApp())
        .post('/api/restaurants')
        .set('Cookie', authCookie())
        .send({ name: 'Burger Joint', googlePlaceId: 'place-xyz' });

      expect(res.status).toBe(200);
      expect(mockDownloadAndStoreAll).not.toHaveBeenCalled();
      expect(mockPrisma.restaurant.update).not.toHaveBeenCalled();
    });

    it('does NOT patch when storage returns empty (download/upload failed)', async () => {
      // If every photo failed to upload, the existing row stays photo-less.
      // Next search for this place will retry; meanwhile we don't issue a
      // pointless DB write.
      (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
        ...fakeRestaurant, googlePlaceId: 'place-xyz', photos: null,
      });
      mockDownloadAndStoreAll.mockResolvedValueOnce([]);

      const res = await request(buildApp())
        .post('/api/restaurants')
        .set('Cookie', authCookie())
        .send({ name: 'Burger Joint', googlePlaceId: 'place-xyz', photos: incomingPhotos });

      expect(res.status).toBe(200);
      expect(mockDownloadAndStoreAll).toHaveBeenCalled();
      expect(mockPrisma.restaurant.update).not.toHaveBeenCalled();
    });
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
