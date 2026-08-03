import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { requireAuth, getOptionalAuthUserId } from '../middleware/auth';
import { trackGoogleCall } from '../lib/apiUsage';
import { writeLimiter } from '../middleware/rateLimits';
import { downloadAndStoreAll, type StoredPhoto } from '../lib/photoStorage';
import { logger } from '../lib/logger';
import { parseNumericId } from '../lib/validators';

const router = Router();
router.use(writeLimiter);

// Visibility predicate — a row is visible to a viewer if it isn't private, or
// if the viewer is the creator. Anonymous viewers (userId = null) see only
// public rows. Used by all read paths that surface the Restaurant table.
function visibleTo(userId: number | null): Prisma.RestaurantWhereInput {
  return userId
    ? { OR: [{ private: false }, { createdBy: userId }] }
    : { private: false };
}

// GET /api/restaurants — paginated list, scoped by viewer visibility
router.get('/', async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const search = (req.query.search as string) || '';

  const userId = getOptionalAuthUserId(req);
  const where: Prisma.RestaurantWhereInput = {
    ...visibleTo(userId),
    ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
  };

  const [restaurants, total] = await Promise.all([
    prisma.restaurant.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { name: 'asc' },
    }),
    prisma.restaurant.count({ where }),
  ]);

  res.json({ restaurants, total, page, pages: Math.ceil(total / limit) });
});

// GET /api/restaurants/:id
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseNumericId(req.params.id);
  if (!id) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  const userId = getOptionalAuthUserId(req);
  const restaurant = await prisma.restaurant.findUnique({ where: { id } });
  // 404 (rather than 403) for private-not-yours so we don't reveal that the
  // row exists at all — same response shape as "no such id".
  if (!restaurant || (restaurant.private && restaurant.createdBy !== userId)) {
    res.status(404).json({ error: 'Restaurant not found' });
    return;
  }
  res.json({ restaurant });
});

// POST /api/restaurants — find-or-create (never update). Any logged-in user can
// materialize a Google Place or a custom name into a Restaurant row, but they
// cannot overwrite fields on a row that already exists. Stale Google data is
// refreshed only via the authenticated `refreshPlaces` flow, which calls Google
// server-side rather than trusting client payloads.
//
// Caps text fields at conservative lengths so a hostile client can't push
// megabytes into a shared row that other users see.
const MAX_NAME       = 200;
const MAX_TEXT_FIELD = 500;

function clipString(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

// URL fields go to <a href> on the frontend. Reject anything that isn't a
// plain http(s) URL or a bare host string (we prepend https:// when missing).
// Blocks `javascript:`, `data:`, `vbscript:`, etc. at the storage boundary so
// no client-side `href` is ever asked to render a hostile scheme.
function clipUrl(v: unknown, max: number): string | undefined {
  const s = clipString(v, max);
  if (!s) return undefined;
  if (/^[a-z][a-z0-9+\-.]*:/i.test(s) && !/^https?:\/\//i.test(s)) {
    // Has a scheme, but it's not http/https — reject. We don't try to
    // sanitize; refusing is the only safe option.
    return undefined;
  }
  return s;
}

// ── Google Places metadata sanitizers ───────────────────────────────────
// The frontend sends `photos` straight through from the Places nearby /
// text-search response. We re-shape into a known schema and cap sizes
// so a hostile client can't push megabytes of JSON into a shared row.
// Anything not matching the expected shape is dropped.
//
// `googleReviews` is intentionally NOT accepted here — we no longer
// request reviews from Places (Enterprise tier) and the UI now links
// users out to Google Maps for full reviews. The DB column stays in the
// schema for legacy data but is never written by new requests.
const MAX_PHOTOS_PER_RESTAURANT  = 10;

// Type-safe variant: returns the cleaned array (or null) without coercing to
// Prisma.InputJsonValue. Used for the materialize-to-storage path where we
// need to iterate the validated photos to download them. The original
// sanitizePhotos wrapper still exists below for callers that just want to
// store the value directly.
//
// Length cap bumped from 256 → 512 because Google's Places API (New) photo
// references occasionally exceed 256 chars in the wild (typical refs are
// ~250, but rare ones run to 300+). Truncated refs are invalid by definition
// — the prior cap was silently dropping the tail and breaking the photo.
interface IncomingPhotoRef {
  name: string;
  widthPx: number | null;
  heightPx: number | null;
}
function sanitizeIncomingPhotos(raw: unknown): IncomingPhotoRef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_PHOTOS_PER_RESTAURANT)
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({
      name:     typeof p.name     === 'string'  ? p.name.slice(0, 512) : '',
      widthPx:  typeof p.widthPx  === 'number'  ? p.widthPx  : null,
      heightPx: typeof p.heightPx === 'number'  ? p.heightPx : null,
    }))
    .filter((p) => p.name.length > 0);
}

function sanitizePhotos(raw: unknown): Prisma.InputJsonValue | undefined {
  const out = sanitizeIncomingPhotos(raw);
  return out.length > 0 ? (out as unknown as Prisma.InputJsonValue) : undefined;
}

// Materialize-to-storage helper: takes the raw `photos` body field (Google
// refs from a Places search), validates shape, downloads each photo from
// Google's signed CDN, uploads bytes to Supabase Storage, and returns the
// public URLs in the same DB-ready shape. The returned array's `name` field
// is now a Supabase public URL — frontend cards point `<img src>` at it
// directly with no proxy involvement.
//
// Returns undefined when:
//   - GOOGLE_PLACES_API_KEY isn't set (storage disabled in this env)
//   - the body has no photos (custom user-typed entry)
//   - every photo failed to upload (Supabase Storage misconfigured? log!)
//
// Returning undefined leaves the row's photos column NULL — the card just
// renders no photo region, the rest of the materialize completes normally.
// Subsequent searches for the same place will retry via the existing-row
// backfill branch.
async function materializePhotosToStorage(
  rawPhotos: unknown,
  restaurantId: number,
): Promise<StoredPhoto[] | undefined> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return undefined;
  const cleaned = sanitizeIncomingPhotos(rawPhotos);
  if (cleaned.length === 0) return undefined;
  try {
    const stored = await downloadAndStoreAll({
      restaurantId,
      googlePhotos: cleaned,
      apiKey,
    });
    return stored.length > 0 ? stored : undefined;
  } catch (err) {
    logger.warn({ err, restaurantId }, 'materializePhotosToStorage threw');
    return undefined;
  }
}

// Re-validate the structured opening hours the frontend echoes back
// from the Places response. Server-side check protects against a
// hostile client stuffing arbitrary JSON into this column. Mirrors
// `extractRegularOpeningHours` in places.ts — same shape constraints,
// same length caps.
function sanitizeRegularOpeningHours(raw: unknown): Prisma.InputJsonValue | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const rawPeriods = Array.isArray(obj.periods) ? obj.periods : [];
  const periods: Array<{ open: { day: number; hour: number; minute: number };
                         close: { day: number; hour: number; minute: number } | null }> = [];
  for (const period of rawPeriods.slice(0, 30)) {
    if (!period || typeof period !== 'object') continue;
    const p = period as Record<string, unknown>;
    const cleanPoint = (pt: unknown) => {
      if (!pt || typeof pt !== 'object') return null;
      const x = pt as Record<string, unknown>;
      const day    = typeof x.day    === 'number' && x.day    >= 0 && x.day    <= 6  ? Math.floor(x.day)    : null;
      const hour   = typeof x.hour   === 'number' && x.hour   >= 0 && x.hour   <= 23 ? Math.floor(x.hour)   : null;
      const minute = typeof x.minute === 'number' && x.minute >= 0 && x.minute <= 59 ? Math.floor(x.minute) : null;
      if (day === null || hour === null || minute === null) return null;
      return { day, hour, minute };
    };
    const open  = cleanPoint(p.open);
    if (!open) continue;
    const close = cleanPoint(p.close);
    periods.push({ open, close });
  }
  const rawDescs = Array.isArray(obj.weekdayDescriptions) ? obj.weekdayDescriptions : [];
  const weekdayDescriptions = rawDescs
    .slice(0, 7)
    .filter((s: unknown): s is string => typeof s === 'string')
    .map((s) => s.slice(0, 200));
  if (periods.length === 0 && weekdayDescriptions.length === 0) return undefined;
  return ({ periods, weekdayDescriptions } as unknown) as Prisma.InputJsonValue;
}

router.post('/', requireAuth, async (req: Request, res: Response) => {
  const body = req.body as {
    googlePlaceId?: unknown;
    name?: unknown;
    cuisineType?: unknown;
    priceLevel?: unknown;
    hours?: unknown;
    phone?: unknown;
    website?: unknown;
    address?: unknown;
    yelpUrl?: unknown;
    takeout?: unknown;
    delivery?: unknown;
    googleRating?: unknown;
    // Geo coords, captured from the Places API response when the
    // frontend materializes a nearby result. Stored on the row so the
    // Compare-page map can render markers without re-fetching from
    // Google. Custom user-typed entries omit these; they remain null.
    lat?: unknown;
    lng?: unknown;
    // Google Places "Pro tier" payload captured at materialize time.
    // Persisted to the DB so cards/modals showing photos don't have to
    // re-hit the Places API on every page load. Refreshed by the
    // periodic refresh-places sweeper. All optional — frontend omits
    // when the source isn't a Place result (custom user entry).
    photos?: unknown;
    ratingCount?: unknown;
    regularOpeningHours?: unknown;
  };

  const name = clipString(body.name, MAX_NAME);
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }

  const googlePlaceId = clipString(body.googlePlaceId, 200);
  // Overture GERS id — the open-data identity from /api/places-v2
  // results. Mirrors the googlePlaceId dedupe: find-or-create keyed
  // on the unique column, rows are public (the place exists in the
  // real world; nothing user-private about it).
  const overtureId = clipString((body as { overtureId?: unknown }).overtureId, 64);

  if (!googlePlaceId && overtureId) {
    const existing = await prisma.restaurant.findUnique({ where: { overtureId } });
    if (existing) { res.status(200).json({ restaurant: existing }); return; }
  }

  // Find first — if the row already exists AND is visible to the caller,
  // return it (possibly with a narrow photo backfill — see below). Google-
  // sourced rows (googlePlaceId set) are always public, so the visibility
  // check is a no-op there. For custom entries (typed names with no
  // googlePlaceId), the row is visible only if it's public or the caller
  // is its creator — preventing a private name typed by user A from being
  // silently joined by user B.
  if (googlePlaceId) {
    const existing = await prisma.restaurant.findUnique({ where: { googlePlaceId } });
    if (existing) {
      // Narrow backfill: when the existing row has no photos and the client
      // just supplied some from a fresh Places result, download the photos
      // to Supabase Storage and patch the row. Covers two real failure modes:
      //   1. Legacy rows created before photos-at-materialize-time landed.
      //   2. Rows whose Google photo refs have since rotated and now fail
      //      the /media endpoint (the "stale ref" bug — Google's docs claim
      //      refs are persistent but empirically they aren't).
      // Other Google-fresh fields (rating count, regularOpeningHours)
      // intentionally stay in the periodic-refresh domain — this branch
      // exists only to unblock photo rendering on cards, not to become a
      // general "merge whatever the client says" update path.
      const existingHasPhotos = Array.isArray(existing.photos)
        && (existing.photos as unknown[]).length > 0;
      if (!existingHasPhotos) {
        const stored = await materializePhotosToStorage(body.photos, existing.id);
        if (stored !== undefined) {
          const patched = await prisma.restaurant.update({
            where: { id: existing.id },
            data: {
              photos: stored as unknown as Prisma.InputJsonValue,
              // Stamp the refresh timestamp so the periodic refresh sweep
              // doesn't immediately re-pick this row as stale.
              googleDataUpdatedAt: new Date(),
            },
          });
          res.status(200).json({ restaurant: patched });
          return;
        }
      }
      res.status(200).json({ restaurant: existing });
      return;
    }
  } else if (!overtureId) {
    // Custom user-typed entry — name-based dedupe. Skipped for
    // Overture materializations: those dedupe on overtureId above, and
    // letting a name match join them to someone's custom row would
    // misattach the open-data identity to a private entry.
    const existing = await prisma.restaurant.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        googlePlaceId: null,
        overtureId: null,
        ...visibleTo(req.userId),
      },
    });
    if (existing) { res.status(200).json({ restaurant: existing }); return; }
  }

  // Validate numeric fields cleanly — Prisma will reject NaN/Infinity but the
  // error surface is worse than an early 400.
  const priceLevel = (typeof body.priceLevel === 'number' && Number.isInteger(body.priceLevel) && body.priceLevel >= 1 && body.priceLevel <= 4)
    ? body.priceLevel : undefined;
  const googleRating = (typeof body.googleRating === 'number' && Number.isFinite(body.googleRating) && body.googleRating >= 0 && body.googleRating <= 5)
    ? body.googleRating : null;
  const ratingCount = (typeof body.ratingCount === 'number' && Number.isInteger(body.ratingCount) && body.ratingCount >= 0)
    ? body.ratingCount : null;
  // Validate coords as sane finite numbers in the expected ranges. Reject
  // anything else as null rather than 500'ing on Prisma's NaN rejection.
  const lat = (typeof body.lat === 'number' && Number.isFinite(body.lat) && body.lat >= -90  && body.lat <= 90)  ? body.lat : null;
  const lng = (typeof body.lng === 'number' && Number.isFinite(body.lng) && body.lng >= -180 && body.lng <= 180) ? body.lng : null;
  const regularOpeningHours = sanitizeRegularOpeningHours(body.regularOpeningHours);

  // Privacy rule: a Google Place or Overture place is shared data (the
  // place exists in the real world, everyone gets to see/refer to it);
  // a user-typed custom name is private to the creator until they
  // explicitly share it via a group event option or favorite
  // (groups.ts auto-publishes at that point).
  const isPrivate = !googlePlaceId && !overtureId;

  // Create the row WITHOUT photos first — the photo upload to Supabase
  // Storage needs the row's id for its deterministic storage path
  // (<restaurantId>/<photoIndex>.jpg). Two-write cost is fine here: a
  // materialize is user-initiated and not on a hot path. If the photo
  // upload fails or returns nothing, the row stays photo-less and the
  // existing-row backfill branch above will retry on the next search.
  const restaurant = await prisma.restaurant.create({
    data: {
      googlePlaceId: googlePlaceId ?? null,
      overtureId: overtureId ?? null,
      name,
      cuisineType: clipString(body.cuisineType, MAX_TEXT_FIELD),
      priceLevel,
      hours:       clipString(body.hours,    MAX_TEXT_FIELD),
      phone:       clipString(body.phone,    MAX_TEXT_FIELD),
      website:     clipUrl(body.website,    MAX_TEXT_FIELD),
      address:     clipString(body.address, MAX_TEXT_FIELD),
      yelpUrl:     clipUrl(body.yelpUrl,    MAX_TEXT_FIELD),
      takeout:  body.takeout  === true,
      delivery: body.delivery === true,
      googleRating,
      ratingCount,
      lat,
      lng,
      ...(regularOpeningHours !== undefined && { regularOpeningHours }),
      // googleDataUpdatedAt is set in the post-photo update below if we
      // successfully stored at least one photo; otherwise it stays null so
      // the next refresh sweep picks this row up.
      createdBy: req.userId,
      private:   isPrivate,
    },
  });

  // Photo storage step. Downloads each photo from Google's /media endpoint
  // and uploads bytes to Supabase Storage. If everything works, we update
  // the row with the storage URLs + a fresh googleDataUpdatedAt stamp.
  // If it fails (no API key, Supabase misconfigured, all photos failed),
  // we return the row as-is — the rest of the data is still useful.
  const storedPhotos = await materializePhotosToStorage(body.photos, restaurant.id);
  if (storedPhotos !== undefined) {
    const updated = await prisma.restaurant.update({
      where: { id: restaurant.id },
      data: {
        photos: storedPhotos as unknown as Prisma.InputJsonValue,
        googleDataUpdatedAt: new Date(),
      },
    });
    res.status(201).json({ restaurant: updated });
    return;
  }

  res.status(201).json({ restaurant });
});

// GET /api/restaurants/:id/reviews — community reviews for a restaurant
router.get('/:id/reviews', async (req: Request, res: Response) => {
  const restaurantId = parseNumericId(req.params.id);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }

  // Same visibility rule as /:id — don't surface community reviews for a row
  // the caller can't see anyway. Short-circuits with 404 before the heavier
  // aggregate query runs.
  const userId = getOptionalAuthUserId(req);
  const visibility = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { private: true, createdBy: true },
  });
  if (!visibility || (visibility.private && visibility.createdBy !== userId)) {
    res.status(404).json({ error: 'Restaurant not found' });
    return;
  }

  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const page  = Math.max(1, Number(req.query.page) || 1);

  const [reviews, aggregate, restaurant] = await Promise.all([
    prisma.review.findMany({
      where: { restaurantId },
      skip: (page - 1) * limit,
      take: limit,
      include: { user: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.review.aggregate({
      where: { restaurantId },
      _avg: { rating: true },
      _count: true,
    }),
    prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { communityRating: true },
    }),
  ]);

  const total = aggregate._count;
  const averageRating = aggregate._avg.rating ? Number(aggregate._avg.rating) : null;
  const communityRating = restaurant?.communityRating ? Number(restaurant.communityRating) : null;

  res.json({ reviews, averageRating, communityRating, total, page, pages: Math.ceil(total / limit) });
});

// PATCH /api/restaurants/:id/match-settings
// Toggle a custom row's opt-out from the post-search Place-match
// scan. Only the row's creator can modify it (custom rows are
// user-owned), and only custom rows (no googlePlaceId) accept the
// toggle — there's no useful flag state for Google-sourced rows
// since they can't match themselves.
// ── Google enrichment for Overture-sourced rows ──────────────────
//
// POST /api/restaurants/:id/enrich — one-time (per 90 days) Google
// backfill of rating/price/hours/photos for a row materialized from
// the open-data index. Two calls, tier-controlled:
//   1. RESOLVE: Text Search with an ID-ONLY field mask (Essentials
//      SKU — the cheap tier). Adding ANY other field here bumps the
//      tier; the tier-guard test enforces id-only.
//   2. DETAILS: Place Details with rating/price/hours/photos/contact
//      (Enterprise SKU, ~2c). NO Atmosphere fields — see the
//      TEXT_FIELD_MASK warning in routes/places.ts for the history.
// Failed resolves stamp googleDataUpdatedAt too, so an unmatched
// food cart doesn't retry on every modal open (90-day backoff).
const ENRICH_TTL_DAYS = 90;
const MAX_ENRICH_PHOTOS = 3; // bump to 5 if testers want richer galleries
export const ENRICH_RESOLVE_MASK = 'places.id';
export const ENRICH_DETAILS_MASK = [
  'id', 'rating', 'userRatingCount', 'priceLevel',
  'regularOpeningHours', 'internationalPhoneNumber', 'websiteUri', 'photos',
].join(',');

router.post('/:id/enrich', requireAuth, async (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'id must be an integer' }); return; }
  const row = await prisma.restaurant.findUnique({ where: { id } });
  if (!row) { res.status(404).json({ error: 'Restaurant not found' }); return; }
  if (!row.overtureId) { res.status(400).json({ error: 'Only Overture-sourced rows are enrichable' }); return; }

  const cutoff = new Date(Date.now() - ENRICH_TTL_DAYS * 24 * 60 * 60 * 1000);
  if (row.googleDataUpdatedAt && row.googleDataUpdatedAt > cutoff) {
    res.json({ restaurant: row, enriched: false, reason: 'fresh' });
    return;
  }
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) { res.status(503).json({ error: 'Enrichment not configured' }); return; }

  // 1. Resolve googlePlaceId if the row does not have one yet.
  let placeId = row.googlePlaceId;
  if (!placeId) {
    const body: Record<string, unknown> = {
      textQuery: [row.name, row.address].filter(Boolean).join(' '),
      pageSize: 1,
    };
    if (row.lat != null && row.lng != null) {
      body.locationBias = { circle: { center: { latitude: row.lat, longitude: row.lng }, radius: 500 } };
    }
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': ENRICH_RESOLVE_MASK },
      body: JSON.stringify(body),
    });
    const data = await r.json() as { places?: Array<{ id?: string }> };
    trackGoogleCall(req, 'textSearch', { status: r.ok ? 'ok' : 'error' });
    placeId = (r.ok && typeof data.places?.[0]?.id === 'string') ? data.places[0].id : null;
    if (!placeId) {
      // No confident match — stamp the timestamp so we do not retry on
      // every modal open. The row keeps serving its Overture data.
      const updated = await prisma.restaurant.update({
        where: { id }, data: { googleDataUpdatedAt: new Date() },
      });
      res.json({ restaurant: updated, enriched: false, reason: 'no-match' });
      return;
    }
  }

  // 2. Details.
  const dRes = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': ENRICH_DETAILS_MASK },
  });
  const d = await dRes.json() as Record<string, unknown>;
  trackGoogleCall(req, 'placeDetails', { status: dRes.ok ? 'ok' : 'error' });
  if (!dRes.ok) { res.status(502).json({ error: 'Enrichment lookup failed' }); return; }

  const photosRaw = Array.isArray(d.photos) ? (d.photos as unknown[]).slice(0, MAX_ENRICH_PHOTOS) : undefined;
  const stored = photosRaw && photosRaw.length > 0 ? await materializePhotosToStorage(photosRaw, id) : undefined;
  const priceLevelMap: Record<string, number> = {
    PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4,
  };
  const updated = await prisma.restaurant.update({
    where: { id },
    data: {
      googlePlaceId: row.googlePlaceId ?? placeId,
      googleRating: typeof d.rating === 'number' ? d.rating : row.googleRating,
      ratingCount: typeof d.userRatingCount === 'number' ? d.userRatingCount : row.ratingCount,
      priceLevel: typeof d.priceLevel === 'string' ? (priceLevelMap[d.priceLevel] ?? row.priceLevel) : row.priceLevel,
      phone:   row.phone   ?? (typeof d.internationalPhoneNumber === 'string' ? d.internationalPhoneNumber : null),
      website: row.website ?? (typeof d.websiteUri === 'string' ? d.websiteUri : null),
      regularOpeningHours: sanitizeRegularOpeningHours(d.regularOpeningHours) ?? undefined,
      ...(stored !== undefined ? { photos: stored as unknown as Prisma.InputJsonValue } : {}),
      googleDataUpdatedAt: new Date(),
    },
  });
  res.json({ restaurant: updated, enriched: true });
});

router.patch('/:id/match-settings', requireAuth, async (req: Request, res: Response) => {
  const restaurantId = parseNumericId(req.params.id);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }

  const { excludeFromPlaceMatching } = req.body as { excludeFromPlaceMatching?: unknown };
  if (typeof excludeFromPlaceMatching !== 'boolean') {
    res.status(400).json({ error: 'excludeFromPlaceMatching must be a boolean' });
    return;
  }

  const row = await prisma.restaurant.findUnique({
    where:  { id: restaurantId },
    select: { id: true, createdBy: true, googlePlaceId: true },
  });
  if (!row) { res.status(404).json({ error: 'Restaurant not found' }); return; }
  if (row.createdBy !== req.userId) { res.status(403).json({ error: 'Only the creator can modify match settings' }); return; }
  if (row.googlePlaceId) {
    res.status(400).json({ error: 'Match settings only apply to custom restaurants' });
    return;
  }

  const updated = await prisma.restaurant.update({
    where: { id: restaurantId },
    data:  { excludeFromPlaceMatching },
    select: { id: true, excludeFromPlaceMatching: true },
  });
  res.json({ restaurant: updated });
});

// POST /api/restaurants/:customId/link-to-place
// Merge a custom row into a Google Place row. The user has confirmed
// that their custom "Joe's Pizza" is the same physical restaurant as
// a Google search result. This endpoint migrates all of the user's
// references (favorites/options/accepted/archives/reviews) from the
// custom row to the Place row, then deletes the custom row.
//
// Body: { placeRestaurantId: number } — the canonical Place row's
// id. The caller is expected to have materialized the Place first
// (via POST /api/restaurants), so the row exists. We don't accept
// raw Place data here because materialize already validates +
// sanitizes that flow; reusing it keeps one code path for "ingest
// Google data."
//
// Wrapped in a transaction so a half-migrated state can't be left
// behind if any step fails. The custom row is deleted last so the
// FK migrations land while it still exists. Unique constraints on
// (userId, restaurantId) for favorites/options/archives mean we
// could conflict if the user already had BOTH the custom and the
// Place in the same collection — handled via `skipDuplicates` on
// each migration (delete from old, ignore if already present in new).
router.post('/:customId/link-to-place', requireAuth, async (req: Request, res: Response) => {
  const customId = parseNumericId(req.params.customId);
  if (!customId) { res.status(400).json({ error: 'Invalid custom restaurant ID' }); return; }

  const { placeRestaurantId } = req.body as { placeRestaurantId?: unknown };
  const placeId = typeof placeRestaurantId === 'number' && Number.isInteger(placeRestaurantId) && placeRestaurantId > 0
    ? placeRestaurantId : null;
  if (!placeId) { res.status(400).json({ error: 'placeRestaurantId is required' }); return; }
  if (placeId === customId) { res.status(400).json({ error: 'Cannot link a row to itself' }); return; }

  // Validate both rows exist + the custom row is owned by this user
  // and actually custom (no googlePlaceId).
  const [custom, place] = await Promise.all([
    prisma.restaurant.findUnique({
      where:  { id: customId },
      select: { id: true, createdBy: true, googlePlaceId: true, private: true },
    }),
    prisma.restaurant.findUnique({
      where:  { id: placeId },
      select: { id: true, googlePlaceId: true },
    }),
  ]);
  if (!custom) { res.status(404).json({ error: 'Custom restaurant not found' }); return; }
  if (!place)  { res.status(404).json({ error: 'Place restaurant not found' });  return; }
  if (custom.createdBy !== req.userId) {
    res.status(403).json({ error: 'Only the creator can link a custom restaurant' });
    return;
  }
  if (custom.googlePlaceId) {
    res.status(400).json({ error: 'Source must be a custom (non-Google) row' });
    return;
  }
  if (!place.googlePlaceId) {
    res.status(400).json({ error: 'Target must be a Google Place row' });
    return;
  }

  // Migrate all of THIS USER's references from custom → place. The
  // unique constraints on the user-collection tables (userId,
  // restaurantId) mean "already exists" is the failure mode we have
  // to handle. Strategy: delete custom-side rows that would collide
  // first, then update the rest. Done per collection.
  await prisma.$transaction(async (tx) => {
    const userId = req.userId!;

    // Favorites: if user already has BOTH (custom and place) as
    // favorites, drop the custom-side row. Otherwise re-point it.
    const collidingFav = await tx.userFavorite.findUnique({
      where: { userId_restaurantId: { userId, restaurantId: placeId } },
      select: { userId: true },
    });
    if (collidingFav) {
      await tx.userFavorite.deleteMany({ where: { userId, restaurantId: customId } });
    } else {
      await tx.userFavorite.updateMany({
        where: { userId, restaurantId: customId },
        data:  { restaurantId: placeId },
      });
    }

    // Options: same pattern.
    const collidingOpt = await tx.userOption.findUnique({
      where: { userId_restaurantId: { userId, restaurantId: placeId } },
      select: { userId: true },
    });
    if (collidingOpt) {
      await tx.userOption.deleteMany({ where: { userId, restaurantId: customId } });
    } else {
      await tx.userOption.updateMany({
        where: { userId, restaurantId: customId },
        data:  { restaurantId: placeId },
      });
    }

    // Archives: same pattern.
    const collidingArc = await tx.userArchive.findUnique({
      where: { userId_restaurantId: { userId, restaurantId: placeId } },
      select: { userId: true },
    });
    if (collidingArc) {
      await tx.userArchive.deleteMany({ where: { userId, restaurantId: customId } });
    } else {
      await tx.userArchive.updateMany({
        where: { userId, restaurantId: customId },
        data:  { restaurantId: placeId },
      });
    }

    // Accepted: no unique constraint (each accept is a separate
    // event), so we can blanket-update all of them. The user's
    // accept history will now show both their custom-era and
    // place-era picks under the unified Place row.
    await tx.userAccepted.updateMany({
      where: { userId, restaurantId: customId },
      data:  { restaurantId: placeId },
    });

    // Reviews: same — multiple reviews per user-restaurant are
    // allowed at the schema level.
    await tx.review.updateMany({
      where: { userId, restaurantId: customId },
      data:  { restaurantId: placeId },
    });

    // Delete the custom row IF it was private to this user (the
    // common case — most customs are private). Public custom rows
    // (shared via groups) get left alone since other users may
    // still reference them; their /me/all just stops referencing
    // it for the merging user.
    if (custom.private) {
      // Defensive: only delete if no other user references it. The
      // FKs are onDelete: SetNull or Cascade depending on the table,
      // so the delete is safe, but we want to avoid yanking a row
      // out from under a co-creator who somehow ended up with the
      // same private row.
      const otherRefs = await Promise.all([
        tx.userFavorite.count({ where: { restaurantId: customId } }),
        tx.userOption.count({ where: { restaurantId: customId } }),
        tx.userArchive.count({ where: { restaurantId: customId } }),
        tx.userAccepted.count({ where: { restaurantId: customId } }),
        tx.review.count({ where: { restaurantId: customId } }),
      ]);
      const stillReferenced = otherRefs.some((n) => n > 0);
      if (!stillReferenced) {
        await tx.restaurant.delete({ where: { id: customId } });
      }
    }
  });

  res.json({ mergedRestaurantId: placeId });
});

export default router;
