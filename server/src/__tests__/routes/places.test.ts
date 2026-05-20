import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

// Mock the photo-storage layer so background mirror calls don't try to
// hit real Supabase in tests. mirrorPhotoFromCdnUrl returns null →
// the mirror is a no-op (no flag set), keeping each test idempotent.
// proxyMirroredPublicUrl returns a deterministic stub URL so tests
// can assert on the redirect target without needing real env vars.
jest.mock('../../lib/photoStorage', () => ({
  mirrorPhotoFromCdnUrl: jest.fn().mockResolvedValue(null),
  proxyMirroredPublicUrl: jest.fn(
    (name: string, width: number) =>
      `https://test.supabase.co/storage/v1/object/public/restaurant-photos/proxy-cache/${name.replace(/[^A-Za-z0-9]/g, '_')}-${width}.jpg`,
  ),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import placesRouter, {
  _resetInMemCachesForTests,
  _setNearbyCacheEntryForTests,
} from '../../routes/places';
import { mirrorPhotoFromCdnUrl } from '../../lib/photoStorage';

const SECRET = process.env.JWT_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/places', placesRouter);
  return app;
}

const authCookie = (userId = 1) => `token=${jwt.sign({ userId }, SECRET)}`;

// ── Test helpers ───────────────────────────────────────────────
function mockGeocode(lat: number, lng: number, formattedAddress = 'Test Address'): void {
  mockFetch.mockResolvedValueOnce({
    json: async () => ({
      status: 'OK',
      results: [{ geometry: { location: { lat, lng } }, formatted_address: formattedAddress }],
    }),
  });
}

function mockNearbySlice(places: unknown[]): void {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ places }) });
}

function makePlace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'place-1',
    displayName: { text: 'Test Restaurant' },
    location: { latitude: 40.0, longitude: -74.0 },
    rating: 4.5,
    userRatingCount: 100,
    priceLevel: 'PRICE_LEVEL_MODERATE',
    primaryType: 'restaurant',
    primaryTypeDisplayName: { text: 'Restaurant' },
    formattedAddress: '1 Test St',
    businessStatus: 'OPERATIONAL',
    takeout: false,
    delivery: false,
    photos: [],
    types: ['restaurant'],
    ...overrides,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  (mirrorPhotoFromCdnUrl as jest.Mock).mockClear();
  (mirrorPhotoFromCdnUrl as jest.Mock).mockResolvedValue(null);
  _resetInMemCachesForTests();
});

// ── /text-search ────────────────────────────────────────────────
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

  it('forwards locationBias when valid lat/lng/radius provided', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ places: [] }) });

    await request(buildApp())
      .get('/api/places/text-search?q=pizza&lat=40.5&lng=-74.5&radius=5000')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body);
    expect(body.locationBias).toEqual({
      circle: { center: { latitude: 40.5, longitude: -74.5 }, radius: 5000 },
    });
  });

  it('omits locationBias when bias is partially specified', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ places: [] }) });

    // lat present, lng missing → global search
    await request(buildApp())
      .get('/api/places/text-search?q=pizza&lat=40.5')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse((init as { body: string }).body);
    expect(body.locationBias).toBeUndefined();
  });

  it('serves repeat queries from the cache (single Google call for two requests)', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ places: [{ id: 'cached-1', displayName: { text: 'Cached' }, businessStatus: 'OPERATIONAL' }] }),
    });

    await request(buildApp()).get('/api/places/text-search?q=cached-search').set('Cookie', authCookie());
    await request(buildApp()).get('/api/places/text-search?q=cached-search').set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ── /nearby — validation & error paths ──────────────────────────
describe('GET /api/places/nearby validation', () => {
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

  it('returns 400 with helpful message when geocoding is denied', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ status: 'REQUEST_DENIED', error_message: 'denied' }),
    });

    const res = await request(buildApp())
      .get('/api/places/nearby?address=Bogus&radiusMeters=1000')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Geocoding API denied/);
  });

  it('returns 400 when geocoding finds no results', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ status: 'ZERO_RESULTS', results: [] }),
    });

    const res = await request(buildApp())
      .get('/api/places/nearby?address=Mars&radiusMeters=1000')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/try a different address/);
  });

  it('returns 502 when every nearby slice fails', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockGeocode(40, -74, 'Failtown');
    // Both slices fail
    mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { status: 'INTERNAL', message: 'boom' } }) });
    mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { status: 'INTERNAL', message: 'boom' } }) });

    const res = await request(buildApp())
      .get('/api/places/nearby?address=Failtown&radiusMeters=1000')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/boom/);
  });

  it('returns helpful 502 message when API key is denied', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockGeocode(40, -74, 'Denied');
    mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'no' } }) });
    mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'no' } }) });

    const res = await request(buildApp())
      .get('/api/places/nearby?address=Denied&radiusMeters=1000')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/ensure "Places API \(New\)" is enabled/);
  });
});

// ── /nearby — transform & filters ───────────────────────────────
describe('GET /api/places/nearby transform', () => {
  it('drops CLOSED_PERMANENTLY places', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockGeocode(40, -74, 'Closedville');
    mockNearbySlice([
      makePlace({ id: 'open-1', displayName: { text: 'Open Spot' } }),
      makePlace({ id: 'closed-1', displayName: { text: 'Gone' }, businessStatus: 'CLOSED_PERMANENTLY' }),
    ]);
    mockNearbySlice([]); // second slice

    const res = await request(buildApp())
      .get('/api/places/nearby?address=Closedville&radiusMeters=1000')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(res.status).toBe(200);
    expect(res.body.restaurants).toHaveLength(1);
    expect(res.body.restaurants[0].name).toBe('Open Spot');
  });

  it('drops stragglers whose primaryType is in the deny-list', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockGeocode(40, -74, 'Strag');
    mockNearbySlice([
      makePlace({ id: 'real-restaurant', primaryType: 'restaurant' }),
      // Google returned this despite the excludedPrimaryTypes hint —
      // the response-side defensive filter should drop it.
      makePlace({ id: 'sneaky-stadium', displayName: { text: 'Yankee Stadium' }, primaryType: 'stadium' }),
      makePlace({ id: 'sneaky-hotel', displayName: { text: 'Marriott' }, primaryType: 'hotel' }),
    ]);
    mockNearbySlice([]);

    const res = await request(buildApp())
      .get('/api/places/nearby?address=Strag&radiusMeters=1000')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(res.body.restaurants.map((r: { googlePlaceId: string }) => r.googlePlaceId)).toEqual(['real-restaurant']);
  });

  it('dedupes places returned by multiple slices (first slice wins)', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockGeocode(40, -74, 'Dup');
    mockNearbySlice([makePlace({ id: 'shared', displayName: { text: 'From A' } })]);
    mockNearbySlice([makePlace({ id: 'shared', displayName: { text: 'From B' } })]);

    const res = await request(buildApp())
      .get('/api/places/nearby?address=Dup&radiusMeters=1000')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(res.body.restaurants).toHaveLength(1);
    expect(res.body.restaurants[0].name).toBe('From A');
  });

  it('sorts results by ascending distanceKm', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockGeocode(40, -74, 'Sorted');
    mockNearbySlice([
      makePlace({ id: 'far', location: { latitude: 41, longitude: -74 } }),       // ~111 km
      makePlace({ id: 'near', location: { latitude: 40.001, longitude: -74 } }), // ~0.1 km
      makePlace({ id: 'mid', location: { latitude: 40.05, longitude: -74 } }),   // ~5.5 km
    ]);
    mockNearbySlice([]);

    const res = await request(buildApp())
      .get('/api/places/nearby?address=Sorted&radiusMeters=1000')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(res.body.restaurants.map((r: { googlePlaceId: string }) => r.googlePlaceId)).toEqual(['near', 'mid', 'far']);
  });

  it('exposes lat/lng/distanceKm/photos on each result', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockGeocode(40, -74, 'Shape');
    mockNearbySlice([makePlace({
      id: 'shape-1',
      location: { latitude: 40.01, longitude: -74.01 },
      photos: [{ name: 'places/shape-1/photos/abc', widthPx: 800, heightPx: 600 }],
    })]);
    mockNearbySlice([]);

    const res = await request(buildApp())
      .get('/api/places/nearby?address=Shape&radiusMeters=1000')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    const r = res.body.restaurants[0];
    expect(r.lat).toBeCloseTo(40.01, 5);
    expect(r.lng).toBeCloseTo(-74.01, 5);
    expect(r.distanceKm).toBeGreaterThan(0);
    expect(r.photos[0]).toEqual({ name: 'places/shape-1/photos/abc', widthPx: 800, heightPx: 600 });
  });
});

// ── /nearby — cuisine pairing ───────────────────────────────────
describe('GET /api/places/nearby cuisine pairing', () => {
  it('issues 2 calls (cuisine + restaurant broadening) when cuisineType is set', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockGeocode(40, -74, 'Cuisine');
    mockNearbySlice([makePlace({ id: 'italian-1', primaryType: 'italian_restaurant', types: ['italian_restaurant', 'restaurant'] })]);
    mockNearbySlice([]);

    await request(buildApp())
      .get('/api/places/nearby?address=Cuisine&radiusMeters=1000&cuisineType=italian_restaurant')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    // 1 geocode + 2 nearby slices = 3 total fetches
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const [, init1] = mockFetch.mock.calls[1];
    const [, init2] = mockFetch.mock.calls[2];
    expect(JSON.parse((init1 as { body: string }).body).includedTypes).toEqual(['italian_restaurant']);
    expect(JSON.parse((init2 as { body: string }).body).includedTypes).toEqual(['restaurant']);
  });

  it('keeps broaden-slice results whose primaryType matches the cuisine', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockGeocode(40, -74, 'Match');
    mockNearbySlice([makePlace({ id: 'direct-italian', primaryType: 'italian_restaurant', types: ['italian_restaurant'] })]);
    mockNearbySlice([
      // primaryType matches → keep
      makePlace({ id: 'broaden-italian', primaryType: 'italian_restaurant', types: ['italian_restaurant', 'restaurant'] }),
      // non-italian via primaryType but types[] includes italian_restaurant → keep
      makePlace({ id: 'broaden-italian-via-types', primaryType: 'restaurant', types: ['restaurant', 'italian_restaurant'] }),
    ]);

    const res = await request(buildApp())
      .get('/api/places/nearby?address=Match&radiusMeters=1000&cuisineType=italian_restaurant')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    const ids = res.body.restaurants.map((r: { googlePlaceId: string }) => r.googlePlaceId);
    expect(ids).toContain('direct-italian');
    expect(ids).toContain('broaden-italian');
    expect(ids).toContain('broaden-italian-via-types');
  });

  it('drops broaden-slice results whose primaryType AND types[] miss the cuisine', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockGeocode(40, -74, 'Drop');
    mockNearbySlice([makePlace({ id: 'italian-1', primaryType: 'italian_restaurant', types: ['italian_restaurant'] })]);
    mockNearbySlice([
      // Generic restaurant — should be dropped from cuisine-filtered output
      makePlace({ id: 'random-bbq', primaryType: 'barbecue_restaurant', types: ['barbecue_restaurant', 'restaurant'] }),
    ]);

    const res = await request(buildApp())
      .get('/api/places/nearby?address=Drop&radiusMeters=1000&cuisineType=italian_restaurant')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    const ids = res.body.restaurants.map((r: { googlePlaceId: string }) => r.googlePlaceId);
    expect(ids).toContain('italian-1');
    expect(ids).not.toContain('random-bbq');
  });

  it('falls back to default 2-slice fan-out for unknown cuisineType slugs', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockGeocode(40, -74, 'BadCuisine');
    mockNearbySlice([makePlace({ id: 'a' })]);
    mockNearbySlice([makePlace({ id: 'b' })]);

    await request(buildApp())
      .get('/api/places/nearby?address=BadCuisine&radiusMeters=1000&cuisineType=not_a_real_type')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    // Both slices use the default NEARBY_TYPE_SETS, not the cuisine
    const [, init1] = mockFetch.mock.calls[1];
    const [, init2] = mockFetch.mock.calls[2];
    const types1 = JSON.parse((init1 as { body: string }).body).includedTypes;
    const types2 = JSON.parse((init2 as { body: string }).body).includedTypes;
    expect(types1).toContain('restaurant');
    expect(types2.length).toBeGreaterThan(5); // the merged B slice has 19 types
  });
});

// ── /nearby — caching + SWR + coalescing ────────────────────────
describe('GET /api/places/nearby cache + SWR + coalescing', () => {
  it('serves the second identical request from cache (single Google fan-out)', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockGeocode(40, -74, 'CacheTest');
    mockNearbySlice([makePlace({ id: 'cache-1' })]);
    mockNearbySlice([]);

    await request(buildApp())
      .get('/api/places/nearby?address=CacheTest&radiusMeters=1000')
      .set('Cookie', authCookie());

    // 1 geocode + 2 nearby slices on first request
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Second request — no additional Google calls
    const res = await request(buildApp())
      .get('/api/places/nearby?address=CacheTest&radiusMeters=1000')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    // Geocode is also cached so total stays at 3
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(res.body.restaurants).toHaveLength(1);
  });

  it('serves a stale cached entry immediately and triggers a background refresh', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';

    // Pre-populate the cache with an entry whose freshUntilMs is in the
    // past — this simulates "served past the fresh window but inside
    // the total TTL." Key format matches cacheKey(): "lat,lng::radius::cuisine"
    const key = '40.000,-74.000::1000::any';
    _setNearbyCacheEntryForTests(
      key,
      {
        restaurants: [{ googlePlaceId: 'stale-1', name: 'Stale Cached' }],
        rawPlaces: [],
        resolvedAddress: 'Test',
        resolvedLat: 40,
        resolvedLng: -74,
        freshUntilMs: Date.now() - 1000, // already stale
      },
      Date.now() + 60 * 60 * 1000, // not yet expired
    );

    // Geocode + background refresh (2 slices) — total 3 calls if
    // refresh fires. The user's response should NOT wait for them.
    mockGeocode(40, -74, 'Test');
    mockNearbySlice([makePlace({ id: 'fresh-1', displayName: { text: 'Fresh Refreshed' } })]);
    mockNearbySlice([]);

    const res = await request(buildApp())
      .get('/api/places/nearby?address=Test&radiusMeters=1000')
      .set('Cookie', authCookie());

    delete process.env.GOOGLE_PLACES_API_KEY;
    // User sees the stale entry immediately
    expect(res.status).toBe(200);
    expect(res.body.restaurants[0].googlePlaceId).toBe('stale-1');
  });

  it('coalesces concurrent identical requests into a single fan-out', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    // Geocode + 2 slices — Google fetches resolve slowly to give the
    // second request time to land in the in-flight map.
    mockGeocode(40, -74, 'Concurrent');
    let resolveSlice1: (() => void) | null = null;
    let resolveSlice2: (() => void) | null = null;
    const slice1Promise = new Promise<void>((r) => { resolveSlice1 = r; });
    const slice2Promise = new Promise<void>((r) => { resolveSlice2 = r; });

    mockFetch.mockImplementationOnce(async () => {
      await slice1Promise;
      return { ok: true, json: async () => ({ places: [makePlace({ id: 'coalesced-1' })] }) };
    });
    mockFetch.mockImplementationOnce(async () => {
      await slice2Promise;
      return { ok: true, json: async () => ({ places: [] }) };
    });

    const req1 = request(buildApp())
      .get('/api/places/nearby?address=Concurrent&radiusMeters=1000')
      .set('Cookie', authCookie());
    const req2 = request(buildApp())
      .get('/api/places/nearby?address=Concurrent&radiusMeters=1000')
      .set('Cookie', authCookie());

    // Wait a tick so req2 enters the handler and finds the in-flight promise
    await new Promise((r) => setTimeout(r, 50));
    resolveSlice1!();
    resolveSlice2!();

    const [res1, res2] = await Promise.all([req1, req2]);

    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Only ONE fan-out (1 geocode + 2 slices = 3 calls), not two (= 5)
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Both got the same result
    expect(res1.body.restaurants[0].googlePlaceId).toBe('coalesced-1');
    expect(res2.body.restaurants[0].googlePlaceId).toBe('coalesced-1');
  });
});

// ── /photo proxy ────────────────────────────────────────────────
describe('GET /api/places/photo', () => {
  it('returns 400 when name is missing', async () => {
    const res = await request(buildApp()).get('/api/places/photo');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid photo name/);
  });

  it('returns 400 on names that do not match the strict regex', async () => {
    // Path traversal attempt
    const traversal = await request(buildApp())
      .get('/api/places/photo?name=places/../../etc/passwd/photos/abc');
    expect(traversal.status).toBe(400);

    // Wrong prefix
    const wrongPrefix = await request(buildApp())
      .get('/api/places/photo?name=evil/place-1/photos/abc');
    expect(wrongPrefix.status).toBe(400);

    // Special characters
    const special = await request(buildApp())
      .get('/api/places/photo?name=places/X%20Y/photos/abc');
    expect(special.status).toBe(400);
  });

  it('returns 503 when no API key and no mirror flag is set', async () => {
    const saved = process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.GOOGLE_PLACES_API_KEY;

    const res = await request(buildApp())
      .get('/api/places/photo?name=places/p1/photos/ref1&maxWidthPx=400');

    process.env.GOOGLE_PLACES_API_KEY = saved;
    expect(res.status).toBe(503);
  });

  it('sets the cross-origin CORP header on validation errors', async () => {
    const res = await request(buildApp())
      .get('/api/places/photo?name=invalid');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('redirects 302 to the Google CDN URL on cache miss', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockFetch.mockResolvedValueOnce({
      status: 302,
      headers: { get: (h: string) => (h === 'location' ? 'https://lh3.googleusercontent.com/signed-url' : null) },
    });

    const res = await request(buildApp())
      .get('/api/places/photo?name=places/p1/photos/abc&maxWidthPx=400');

    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://lh3.googleusercontent.com/signed-url');
    expect(res.headers['cache-control']).toMatch(/max-age=3600/);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('serves repeat requests from the tier-2 signed-URL cache (no extra Google calls)', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockFetch.mockResolvedValueOnce({
      status: 302,
      headers: { get: (h: string) => (h === 'location' ? 'https://lh3.googleusercontent.com/cached-once' : null) },
    });

    await request(buildApp()).get('/api/places/photo?name=places/p1/photos/cached&maxWidthPx=400');
    const res2 = await request(buildApp()).get('/api/places/photo?name=places/p1/photos/cached&maxWidthPx=400');

    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the first call hit Google
    expect(res2.status).toBe(302);
    expect(res2.headers.location).toBe('https://lh3.googleusercontent.com/cached-once');
  });

  it('quantizes maxWidthPx to the next-higher bucket of 100', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockFetch.mockResolvedValueOnce({
      status: 302,
      headers: { get: (h: string) => (h === 'location' ? 'https://lh3.googleusercontent.com/sized' : null) },
    });

    await request(buildApp()).get('/api/places/photo?name=places/p1/photos/sized&maxWidthPx=199');

    delete process.env.GOOGLE_PLACES_API_KEY;
    const [url] = mockFetch.mock.calls[0];
    // 199 should snap up to 200, not be sent as-is
    expect(url).toMatch(/maxWidthPx=200/);
  });

  it('clamps maxWidthPx below 100 up to 100', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockFetch.mockResolvedValueOnce({
      status: 302,
      headers: { get: (h: string) => (h === 'location' ? 'https://lh3.googleusercontent.com/min' : null) },
    });

    await request(buildApp()).get('/api/places/photo?name=places/p1/photos/min&maxWidthPx=50');

    delete process.env.GOOGLE_PLACES_API_KEY;
    const [url] = mockFetch.mock.calls[0];
    expect(url).toMatch(/maxWidthPx=100/);
  });

  it('clamps maxWidthPx above 1600 down to 1600', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockFetch.mockResolvedValueOnce({
      status: 302,
      headers: { get: (h: string) => (h === 'location' ? 'https://lh3.googleusercontent.com/max' : null) },
    });

    await request(buildApp()).get('/api/places/photo?name=places/p1/photos/max&maxWidthPx=9999');

    delete process.env.GOOGLE_PLACES_API_KEY;
    const [url] = mockFetch.mock.calls[0];
    expect(url).toMatch(/maxWidthPx=1600/);
  });

  it('returns 502 when Google returns a non-redirect status', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockFetch.mockResolvedValueOnce({
      status: 400,
      headers: { get: () => null },
      text: async () => '{"error":"INVALID_ARGUMENT"}',
    });

    const res = await request(buildApp())
      .get('/api/places/photo?name=places/p1/photos/broken&maxWidthPx=400');

    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(res.status).toBe(502);
  });

  it('triggers a background mirror after a successful Google fetch', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    mockFetch.mockResolvedValueOnce({
      status: 302,
      headers: { get: (h: string) => (h === 'location' ? 'https://lh3.googleusercontent.com/to-mirror' : null) },
    });

    await request(buildApp())
      .get('/api/places/photo?name=places/p1/photos/mirror-me&maxWidthPx=400');

    // Let the fire-and-forget mirror enter the await queue
    await new Promise((r) => setImmediate(r));

    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(mirrorPhotoFromCdnUrl).toHaveBeenCalledWith({
      googleName: 'places/p1/photos/mirror-me',
      maxWidthPx: 400,
      cdnUrl: 'https://lh3.googleusercontent.com/to-mirror',
    });
  });

  it('serves tier-1 Supabase URL when mirror flag is set (no Google call)', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    // First request: triggers mirror. We make our mock succeed this time
    // so the flag gets set.
    (mirrorPhotoFromCdnUrl as jest.Mock).mockResolvedValueOnce(
      'https://test.supabase.co/storage/v1/object/public/restaurant-photos/proxy-cache/abc.jpg',
    );
    mockFetch.mockResolvedValueOnce({
      status: 302,
      headers: { get: (h: string) => (h === 'location' ? 'https://lh3.googleusercontent.com/seed' : null) },
    });

    await request(buildApp())
      .get('/api/places/photo?name=places/p1/photos/tier1&maxWidthPx=400');

    // Wait for background mirror to flip the flag
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Second request — should hit tier 1 (Supabase), no Google call
    const res = await request(buildApp())
      .get('/api/places/photo?name=places/p1/photos/tier1&maxWidthPx=400');

    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/test\.supabase\.co/);
    // Still only the original Google call from request 1
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
