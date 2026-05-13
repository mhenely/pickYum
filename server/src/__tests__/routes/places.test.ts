import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import placesRouter from '../../routes/places';

const SECRET = process.env.JWT_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/places', placesRouter);
  return app;
}

const authCookie = (userId = 1) => `token=${jwt.sign({ userId }, SECRET)}`;

describe('GET /api/places/text-search', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/places/text-search?q=pizza');
    expect(res.status).toBe(401);
  });

  it('returns 400 when q is fewer than 2 characters', async () => {
    const res = await request(buildApp())
      .get('/api/places/text-search?q=a')
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2 characters/);
  });

  it('returns unconfigured response when API key is absent', async () => {
    const saved = process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.GOOGLE_PLACES_API_KEY;

    const res = await request(buildApp())
      .get('/api/places/text-search?q=pizza')
      .set('Cookie', authCookie());

    process.env.GOOGLE_PLACES_API_KEY = saved;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ restaurants: [], configured: false });
  });

  it('returns filtered restaurants from Places API', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        places: [
          {
            id: 'gplace1',
            displayName: { text: 'Tasty Slice' },
            rating: 4.5,
            priceLevel: 'PRICE_LEVEL_MODERATE',
            formattedAddress: '123 Main St',
            primaryTypeDisplayName: { text: 'Pizza' },
            currentOpeningHours: { openNow: true },
            takeout: true,
            delivery: false,
            businessStatus: 'OPERATIONAL',
          },
          {
            id: 'gplace2',
            displayName: { text: 'Closed Forever' },
            businessStatus: 'CLOSED_PERMANENTLY',
          },
        ],
      }),
    });

    const res = await request(buildApp())
      .get('/api/places/text-search?q=pizza')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.restaurants).toHaveLength(1);
    expect(res.body.restaurants[0].name).toBe('Tasty Slice');
    expect(res.body.restaurants[0].priceLevel).toBe(2);
    expect(res.body.restaurants[0].openNow).toBe(true);
  });
});

describe('GET /api/places/nearby', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp())
      .get('/api/places/nearby?address=NYC&radiusMeters=1000');
    expect(res.status).toBe(401);
  });

  it('returns 400 when address is missing', async () => {
    const res = await request(buildApp())
      .get('/api/places/nearby?radiusMeters=1000')
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
  });

  it('returns 400 when radiusMeters is missing', async () => {
    const res = await request(buildApp())
      .get('/api/places/nearby?address=NYC')
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
  });

  it('returns 400 when radiusMeters is not a positive number', async () => {
    const res = await request(buildApp())
      .get('/api/places/nearby?address=NYC&radiusMeters=-100')
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
  });

  it('returns unconfigured response when API key is absent', async () => {
    const saved = process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.GOOGLE_PLACES_API_KEY;

    const res = await request(buildApp())
      .get('/api/places/nearby?address=NYC&radiusMeters=1000')
      .set('Cookie', authCookie());

    process.env.GOOGLE_PLACES_API_KEY = saved;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ restaurants: [], configured: false });
  });
});
