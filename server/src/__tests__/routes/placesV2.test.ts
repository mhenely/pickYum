import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { DeepMockProxy } from 'jest-mock-extended';

jest.mock('../../lib/prisma');

import prisma from '../../lib/prisma';
import placesV2Router from '../../routes/placesV2';

const mockPrisma = prisma as unknown as DeepMockProxy<PrismaClient>;
const SECRET = process.env.JWT_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/places-v2', placesV2Router);
  return app;
}

const authCookie = (userId = 1) => `token=${jwt.sign({ userId }, SECRET)}`;

// Portland-ish rows. Distances from the test center (45.52, -122.68):
// pizza ≈ 0, cafe ≈ ~1.5km E, far diner ≈ ~20km.
const rows = [
  { sourceId: 'g1', name: 'Tasty Slice', categoryPrimary: 'pizza_restaurant',
    lat: 45.52, lng: -122.68, address: '123 SE Main St', locality: 'Portland',
    phone: null, website: null, confidence: 0.9 },
  { sourceId: 'g2', name: 'Bean There', categoryPrimary: 'coffee_shop',
    lat: 45.52, lng: -122.66, address: '456 SE Oak St', locality: 'Portland',
    phone: '+15035550000', website: 'https://beanthere.example.com', confidence: 0.7 },
  { sourceId: 'g3', name: 'Far Diner', categoryPrimary: 'diner',
    lat: 45.70, lng: -122.68, address: null, locality: null,
    phone: null, website: null, confidence: 0.8 },
];

describe('GET /api/places-v2/nearby', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without auth', async () => {
    const res = await request(buildApp())
      .get('/api/places-v2/nearby?lat=45.52&lng=-122.68&radiusMeters=8047');
    expect(res.status).toBe(401);
  });

  it('returns 400 without a radius', async () => {
    const res = await request(buildApp())
      .get('/api/places-v2/nearby?lat=45.52&lng=-122.68')
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
  });

  it('returns 400 with neither coords nor address', async () => {
    const res = await request(buildApp())
      .get('/api/places-v2/nearby?radiusMeters=8047')
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lat\+lng or an address/i);
  });

  it('serves rows within the radius, distance-sorted, in the v1 response shape — no Google call', async () => {
    (mockPrisma.openPlace.findMany as jest.Mock).mockResolvedValue(rows);

    const res = await request(buildApp())
      .get('/api/places-v2/nearby?lat=45.52&lng=-122.68&radiusMeters=8047')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('overture');
    // Far Diner (~20km) exceeds the 8km radius — the exact haversine
    // pass drops it even though the mocked findMany returned it.
    expect(res.body.restaurants).toHaveLength(2);
    expect(res.body.total).toBe(2);
    // Distance-sorted: pizza (0km) before cafe (~1.5km).
    expect(res.body.restaurants[0].name).toBe('Tasty Slice');
    expect(res.body.restaurants[1].name).toBe('Bean There');
    // v1-compatible row shape: same field names, nulls where Overture
    // has no data, plus overtureId provenance.
    expect(res.body.restaurants[0]).toMatchObject({
      googlePlaceId: null,
      overtureId: 'g1',
      googleRating: null,
      priceLevel: null,
      cuisineType: 'Pizza Restaurant',
      primaryType: 'pizza_restaurant',
      photos: [],
      address: '123 SE Main St, Portland',
    });
    expect(typeof res.body.restaurants[0].distanceKm).toBe('number');
    expect(typeof res.body.tookMs).toBe('number');
  });

  it('applies the bounding-box prefilter and confidence floor in the query', async () => {
    (mockPrisma.openPlace.findMany as jest.Mock).mockResolvedValue([]);

    await request(buildApp())
      .get('/api/places-v2/nearby?lat=45.52&lng=-122.68&radiusMeters=8047')
      .set('Cookie', authCookie());

    const where = (mockPrisma.openPlace.findMany as jest.Mock).mock.calls[0][0].where;
    // Box must straddle the center on both axes.
    expect(where.lat.gte).toBeLessThan(45.52);
    expect(where.lat.lte).toBeGreaterThan(45.52);
    expect(where.lng.gte).toBeLessThan(-122.68);
    expect(where.lng.lte).toBeGreaterThan(-122.68);
    // Default confidence floor rides along, keeping null-confidence rows.
    expect(where.AND).toEqual([
      { OR: [{ confidence: null }, { confidence: { gte: 0.4 } }] },
    ]);
  });

  it('combines confidence + cuisine filters without clobbering either (AND of two ORs)', async () => {
    (mockPrisma.openPlace.findMany as jest.Mock).mockResolvedValue([]);

    await request(buildApp())
      .get('/api/places-v2/nearby?lat=45.52&lng=-122.68&radiusMeters=8047&cuisineType=pizza_restaurant')
      .set('Cookie', authCookie());

    const where = (mockPrisma.openPlace.findMany as jest.Mock).mock.calls[0][0].where;
    // Regression guard: these were originally two spreads both named
    // `OR` — the cuisine spread silently replaced the confidence one.
    expect(where.AND).toHaveLength(2);
    expect(where.AND[0].OR).toEqual([{ confidence: null }, { confidence: { gte: 0.4 } }]);
    expect(where.AND[1].OR).toEqual([
      { categoryPrimary: 'pizza_restaurant' },
      { categories: { has: 'pizza_restaurant' } },
    ]);
  });

  it('reports truncation when more than MAX_RESULTS places match', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      sourceId: `g${i}`, name: `Place ${i}`, categoryPrimary: 'restaurant',
      lat: 45.52 + i * 0.0001, lng: -122.68, address: null, locality: null,
      phone: null, website: null, confidence: 0.9,
    }));
    (mockPrisma.openPlace.findMany as jest.Mock).mockResolvedValue(many);

    const res = await request(buildApp())
      .get('/api/places-v2/nearby?lat=45.52&lng=-122.68&radiusMeters=8047')
      .set('Cookie', authCookie());

    // The "no 20-result cap" payoff: 250 real matches, 200 shipped,
    // total tells the client the true count.
    expect(res.body.total).toBe(250);
    expect(res.body.restaurants).toHaveLength(200);
    expect(res.body.truncated).toBe(true);
  });
});
