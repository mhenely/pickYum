import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth';
import redis from '../lib/redis';

const router = Router();

// All endpoints require auth so anonymous users can't exhaust the quota
router.use(requireAuth);

// 30 requests per 5 minutes per IP — generous for normal use, blocks scripted quota abuse
const placesLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many search requests, please slow down' },
});
router.use(placesLimiter);

const RADIUS_CAP_METERS = 50_000;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Places API (New) returns string enums for price level
const PRICE_LEVEL_MAP: Record<string, number | null> = {
  PRICE_LEVEL_FREE:           null,
  PRICE_LEVEL_INEXPENSIVE:    1,
  PRICE_LEVEL_MODERATE:       2,
  PRICE_LEVEL_EXPENSIVE:      3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

// ── Cache layer (Redis when available, in-memory fallback) ───────────────
const NEARBY_TTL_S = 10 * 60; // 10 minutes
const TEXT_TTL_S   =  5 * 60; //  5 minutes

interface NearbyEntry { restaurants: unknown[]; rawPlaces: unknown[]; resolvedAddress: string; }
interface TextEntry   { restaurants: unknown[]; }

// In-memory fallbacks used when Redis is not configured
const inMemNearby = new Map<string, NearbyEntry & { expiresAt: number }>();
const inMemText   = new Map<string, TextEntry   & { expiresAt: number }>();

async function nearbyGet(key: string): Promise<NearbyEntry | null> {
  if (redis && redis.status === 'ready') {
    const raw = await redis.get(`places:nearby:${key}`).catch(() => null);
    return raw ? (JSON.parse(raw) as NearbyEntry) : null;
  }
  const e = inMemNearby.get(key);
  return e && e.expiresAt > Date.now() ? e : null;
}

async function nearbySet(key: string, value: NearbyEntry): Promise<void> {
  if (redis && redis.status === 'ready') {
    await redis.setex(`places:nearby:${key}`, NEARBY_TTL_S, JSON.stringify(value)).catch(() => {});
    return;
  }
  inMemNearby.set(key, { ...value, expiresAt: Date.now() + NEARBY_TTL_S * 1000 });
}

async function textGet(q: string): Promise<TextEntry | null> {
  if (redis && redis.status === 'ready') {
    const raw = await redis.get(`places:text:${q}`).catch(() => null);
    return raw ? (JSON.parse(raw) as TextEntry) : null;
  }
  const e = inMemText.get(q);
  return e && e.expiresAt > Date.now() ? e : null;
}

async function textSet(q: string, value: TextEntry): Promise<void> {
  if (redis && redis.status === 'ready') {
    await redis.setex(`places:text:${q}`, TEXT_TTL_S, JSON.stringify(value)).catch(() => {});
    return;
  }
  inMemText.set(q, { ...value, expiresAt: Date.now() + TEXT_TTL_S * 1000 });
}

// Round to 3 decimal places (~111 m precision) so nearby searches share cache hits
function cacheKey(lat: number, lng: number, radius: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}::${radius}`;
}

// ── Text-search field mask (smaller than nearby — no location needed) ────
const TEXT_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.rating',
  'places.priceLevel',
  'places.primaryTypeDisplayName',
  'places.currentOpeningHours',
  'places.takeout',
  'places.delivery',
  'places.businessStatus',
].join(',');

// GET /api/places/text-search?q=<query>
router.get('/text-search', async (req: Request, res: Response) => {
  const q = ((req.query.q as string) ?? '').trim();
  if (q.length < 2) {
    res.status(400).json({ error: 'q must be at least 2 characters' });
    return;
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    res.json({ restaurants: [], configured: false });
    return;
  }

  const cached = await textGet(q);
  if (cached) {
    res.json({ restaurants: cached.restaurants, configured: true });
    return;
  }

  const searchRes = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': TEXT_FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: `${q} restaurant`, maxResultCount: 10 }),
  });

  const data = await searchRes.json() as any;
  if (!searchRes.ok) {
    res.status(502).json({ error: data.error?.message ?? 'Places text search failed' });
    return;
  }

  const restaurants = (data.places ?? [])
    .filter((p: any) => p.businessStatus !== 'CLOSED_PERMANENTLY')
    .map((p: any) => ({
      googlePlaceId: p.id as string,
      name:          (p.displayName?.text ?? '') as string,
      googleRating:  (p.rating as number | undefined) ?? null,
      priceLevel:    PRICE_LEVEL_MAP[p.priceLevel] ?? null,
      address:       (p.formattedAddress as string | undefined) ?? null,
      cuisineType:   (p.primaryTypeDisplayName?.text as string | undefined) ?? null,
      takeout:       p.takeout === true,
      delivery:      p.delivery === true,
      openNow:       (p.currentOpeningHours?.openNow as boolean | undefined) ?? null,
    }));

  await textSet(q, { restaurants });
  res.json({ restaurants, configured: true });
});

// ── Fields to request — only pay for what we use ──────────────────────────
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.priceLevel',
  'places.types',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.currentOpeningHours',
  'places.takeout',
  'places.delivery',
  'places.businessStatus',
].join(',');

// GET /api/places/nearby?address=<>&radiusMeters=<>
router.get('/nearby', async (req: Request, res: Response) => {
  const address = (req.query.address as string | undefined)?.trim();
  const radiusRaw = Number(req.query.radiusMeters);

  if (!address) {
    res.status(400).json({ error: 'address is required' });
    return;
  }
  if (!radiusRaw || isNaN(radiusRaw) || radiusRaw <= 0) {
    res.status(400).json({ error: 'radiusMeters must be a positive number' });
    return;
  }

  const radius = Math.min(radiusRaw, RADIUS_CAP_METERS);

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    res.json({ restaurants: [], configured: false });
    return;
  }

  // ── 1. Geocode address → lat/lng (Geocoding API — unchanged) ──
  const geocodeUrl =
    `https://maps.googleapis.com/maps/api/geocode/json` +
    `?address=${encodeURIComponent(address)}&key=${apiKey}`;

  const geocodeData = await fetch(geocodeUrl).then((r) => r.json()) as any;

  if (geocodeData.status !== 'OK' || !geocodeData.results?.[0]) {
    const msg = geocodeData.status === 'REQUEST_DENIED'
      ? 'Geocoding API denied the request — ensure the Geocoding API is enabled in Google Cloud Console.'
      : 'Could not find that location — try a different address or zip code.';
    console.error('[places] Geocode failed:', geocodeData.status, geocodeData.error_message ?? '');
    res.status(400).json({ error: msg });
    return;
  }

  const geoLoc = geocodeData.results[0].geometry?.location;
  if (!geoLoc) {
    res.status(400).json({ error: 'Could not find that location — try a different address or zip code.' });
    return;
  }
  const { lat, lng } = geoLoc;
  const formattedAddress: string = geocodeData.results[0].formatted_address ?? '';

  // ── 2. Check cache before hitting the Places API ──────────────
  const key = cacheKey(lat, lng, radius);
  const cached = await nearbyGet(key);
  if (cached) {
    res.json({ restaurants: cached.restaurants, rawPlaces: cached.rawPlaces, configured: true, resolvedAddress: cached.resolvedAddress });
    return;
  }

  // ── 3. Nearby Search (New) — POST with field mask header ──────
  const nearbyRes = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({
      includedTypes: ['restaurant'],
      maxResultCount: 20,
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius,
        },
      },
    }),
  });

  const nearbyData = await nearbyRes.json() as any;

  if (!nearbyRes.ok || nearbyData.error) {
    const errStatus: string = nearbyData.error?.status ?? String(nearbyRes.status);
    const msg = (errStatus === 'PERMISSION_DENIED' || errStatus === 'REQUEST_DENIED')
      ? 'Places API (New) denied the request — ensure "Places API (New)" is enabled in Google Cloud Console and your API key is not restricted from it.'
      : `Places API error: ${nearbyData.error?.message ?? errStatus}`;
    console.error('[places] Nearby search failed:', JSON.stringify(nearbyData.error ?? nearbyRes.status));
    res.status(502).json({ error: msg });
    return;
  }

  // ── 4. Transform to app shape ─────────────────────────────────
  const restaurants = (nearbyData.places ?? [])
    .filter((p: any) => p.businessStatus !== 'CLOSED_PERMANENTLY')
    .map((p: any) => {
      const pLat: number | undefined = p.location?.latitude;
      const pLng: number | undefined = p.location?.longitude;
      return {
        googlePlaceId: p.id as string,
        name: (p.displayName?.text ?? '') as string,
        googleRating: (p.rating as number | undefined) ?? null,
        priceLevel: PRICE_LEVEL_MAP[p.priceLevel] ?? null,
        address: (p.formattedAddress as string | undefined) ?? null,
        // primaryType gives the best single cuisine/category label (e.g. "sushi_restaurant")
        // primaryTypeDisplayName is the human-readable version (e.g. "Sushi Restaurant")
        cuisineType: (p.primaryTypeDisplayName?.text as string | undefined) ?? null,
        takeout: p.takeout === true,
        delivery: p.delivery === true,
        openNow: (p.currentOpeningHours?.openNow as boolean | undefined) ?? null,
        distanceKm: (pLat != null && pLng != null) ? haversineKm(lat, lng, pLat, pLng) : null,
      };
    });

  // ── 5. Store in cache and respond ─────────────────────────────
  const rawPlaces: unknown[] = nearbyData.places ?? [];
  await nearbySet(key, { restaurants, rawPlaces, resolvedAddress: formattedAddress });

  res.json({ restaurants, rawPlaces, configured: true, resolvedAddress: formattedAddress });
});

export default router;
