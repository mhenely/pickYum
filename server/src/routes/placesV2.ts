// Open-data nearby search (Overture POC) — the A/B counterpart to
// routes/places.ts /nearby. Serves from the self-hosted open_places
// table instead of Google, which removes the 20-results-per-call cap
// and the per-call billing entirely. Response shape mirrors /nearby's
// restaurant rows (same field names) so the frontend — or a curl
// diff — can compare the two sources directly.
//
// Differences vs v1, by design:
//   - No rating / priceLevel / photos: Overture doesn't carry them.
//     Those fields return null; enrichment stays on the Google
//     detail-modal path. Price FILTERING therefore doesn't apply here.
//   - No result cap from the data source. We cap the response at
//     MAX_RESULTS for payload sanity and return `total` so the
//     client can say "312 places found, showing 200".
//   - Geocoding still uses Google (Essentials tier, cheap) but only
//     when the caller passes an address; passing lat/lng directly
//     skips Google entirely.
//
// Mounted at /api/places-v2 in app.ts — its own prefix so neither
// router's middleware (auth, rate limiters) runs on the other's
// requests.

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import prisma from '../lib/prisma';
import { trackGoogleCall } from '../lib/apiUsage';
import { haversineKm, bboxForRadius, cuisineLabel } from '../lib/overture';

const router = Router();

const RADIUS_CAP_METERS = 50_000;
// Payload ceiling, not a data ceiling — `total` reports the real count.
const MAX_RESULTS = 200;
// Overture existence confidence below which rows are hidden by
// default. 0.4 is deliberately inclusive while we calibrate against
// v1 results; tune per request with ?minConfidence=.
const DEFAULT_MIN_CONFIDENCE = 0.4;

const v2Limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many search requests, please slow down' },
  skip: () => process.env.NODE_ENV === 'test',
});

// No requireAuth: unlike v1 (where every search spent Google budget
// and auth was the spend gate), the Overture index costs $0 marginal
// — so guest-mode users get real nearby search. The per-IP limiter
// still bounds abuse, and the only Google exposure (address geocode)
// is Essentials-tier + capped by Cloud quotas. trackGoogleCall
// records unauthenticated calls under its documented userId=0 bucket.
router.use(v2Limiter);

// GET /api/places-v2/nearby
//   ?lat=<n>&lng=<n>&radiusMeters=<n>          — direct coords (no Google call)
//   ?address=<s>&radiusMeters=<n>              — geocoded via Google first
//   &cuisineType=<slug>                        — same slugs as v1
//   &minConfidence=<0..1>                      — Overture confidence floor
router.get('/nearby', async (req: Request, res: Response) => {
  const startedAt = Date.now();

  const radiusRaw = Number(req.query.radiusMeters);
  if (!radiusRaw || Number.isNaN(radiusRaw) || radiusRaw <= 0) {
    res.status(400).json({ error: 'radiusMeters must be a positive number' });
    return;
  }
  const radius = Math.min(radiusRaw, RADIUS_CAP_METERS);

  const minConfidenceRaw = Number(req.query.minConfidence);
  const minConfidence = Number.isFinite(minConfidenceRaw) && minConfidenceRaw >= 0 && minConfidenceRaw <= 1
    ? minConfidenceRaw
    : DEFAULT_MIN_CONFIDENCE;

  const cuisineType = typeof req.query.cuisineType === 'string' && req.query.cuisineType.trim()
    ? req.query.cuisineType.trim()
    : null;

  // ── Resolve the search center ─────────────────────────────────
  let lat = Number(req.query.lat);
  let lng = Number(req.query.lng);
  let resolvedAddress = '';

  const hasCoords = Number.isFinite(lat) && lat >= -90 && lat <= 90
    && Number.isFinite(lng) && lng >= -180 && lng <= 180;

  if (!hasCoords) {
    const address = (req.query.address as string | undefined)?.trim();
    if (!address) {
      res.status(400).json({ error: 'Provide lat+lng or an address' });
      return;
    }
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: 'Geocoding not configured — pass lat+lng directly' });
      return;
    }
    // POC note: no geocode cache here (v1's cache helpers are module-
    // private to places.ts). Fine at A/B-test volume; if v2 graduates,
    // the geocode + cache block gets extracted into a shared lib.
    const geoData = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`,
    ).then((r) => r.json()) as {
      status?: string;
      results?: Array<{ geometry?: { location?: { lat: number; lng: number } }; formatted_address?: string }>;
    };
    const loc = geoData.results?.[0]?.geometry?.location;
    if (geoData.status !== 'OK' || !loc) {
      trackGoogleCall(req, 'geocode', { status: 'error' });
      res.status(400).json({ error: 'Could not find that location — try a different address or zip code.' });
      return;
    }
    trackGoogleCall(req, 'geocode');
    lat = loc.lat;
    lng = loc.lng;
    resolvedAddress = geoData.results?.[0]?.formatted_address ?? '';
  }

  // ── Bounding-box prefilter + exact haversine pass ─────────────
  // The composite (lat, lng) index serves the box scan; the exact
  // radius check and sort happen in JS over the candidates. Metro-
  // scale candidate counts (a few thousand rows max) make this
  // comfortably sub-50ms without PostGIS.
  const box = bboxForRadius(lat, lng, radius);
  // Both optional filters are OR-groups, so they go in an AND array —
  // two bare `OR` keys in one where-object would silently clobber
  // each other (last spread wins), dropping the confidence floor
  // whenever a cuisine filter is active.
  const andFilters: object[] = [];
  if (minConfidence > 0) {
    andFilters.push({ OR: [{ confidence: null }, { confidence: { gte: minConfidence } }] });
  }
  if (cuisineType) {
    andFilters.push({ OR: [{ categoryPrimary: cuisineType }, { categories: { has: cuisineType } }] });
  }
  const candidates = await prisma.openPlace.findMany({
    where: {
      lat: { gte: box.minLat, lte: box.maxLat },
      lng: { gte: box.minLng, lte: box.maxLng },
      ...(andFilters.length > 0 ? { AND: andFilters } : {}),
    },
    select: {
      sourceId: true, name: true, categoryPrimary: true,
      lat: true, lng: true, address: true, locality: true,
      phone: true, website: true, confidence: true,
    },
  });

  const radiusKm = radius / 1000;
  const inRadius = candidates
    .map((p) => ({ ...p, distanceKm: haversineKm(lat, lng, p.lat, p.lng) }))
    .filter((p) => p.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  // Same row shape as v1's nearby projection — null where Overture
  // has no data — plus `overtureId` for provenance. googlePlaceId is
  // null by definition; the frontend's materialize path isn't wired
  // to v2 yet (this endpoint exists for the A/B comparison).
  const restaurants = inRadius.slice(0, MAX_RESULTS).map((p) => ({
    googlePlaceId: null,
    overtureId: p.sourceId,
    name: p.name,
    googleRating: null,
    ratingCount: null,
    priceLevel: null,
    address: p.address ? (p.locality ? `${p.address}, ${p.locality}` : p.address) : null,
    cuisineType: cuisineLabel(p.categoryPrimary),
    primaryType: p.categoryPrimary,
    openNow: null,
    distanceKm: p.distanceKm,
    lat: p.lat,
    lng: p.lng,
    photos: [],
    regularOpeningHours: null,
    phone: p.phone,
    website: p.website,
    confidence: p.confidence,
  }));

  res.json({
    restaurants,
    configured: true,
    source: 'overture',
    total: inRadius.length,
    truncated: inRadius.length > MAX_RESULTS,
    resolvedAddress,
    resolvedLat: lat,
    resolvedLng: lng,
    tookMs: Date.now() - startedAt,
  });
});

export default router;
