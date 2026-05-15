import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { requireAuth, getOptionalAuthUserId } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimits';

const router = Router();
router.use(writeLimiter);

const parseId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

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
  const id = parseId(req.params.id);
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

function sanitizePhotos(raw: unknown): Prisma.InputJsonValue | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .slice(0, MAX_PHOTOS_PER_RESTAURANT)
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({
      name:     typeof p.name     === 'string'  ? p.name.slice(0, 256) : null,
      widthPx:  typeof p.widthPx  === 'number'  ? p.widthPx  : null,
      heightPx: typeof p.heightPx === 'number'  ? p.heightPx : null,
    }))
    .filter((p) => !!p.name);
  return out.length > 0 ? (out as unknown as Prisma.InputJsonValue) : undefined;
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

  // Find first — if the row already exists AND is visible to the caller,
  // return it untouched. Google-sourced rows (googlePlaceId set) are always
  // public, so the visibility check is a no-op there. For custom entries
  // (typed names with no googlePlaceId), the row is visible only if it's
  // public or the caller is its creator — preventing a private name typed
  // by user A from being silently joined by user B.
  if (googlePlaceId) {
    const existing = await prisma.restaurant.findUnique({ where: { googlePlaceId } });
    if (existing) { res.status(200).json({ restaurant: existing }); return; }
  } else {
    const existing = await prisma.restaurant.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        googlePlaceId: null,
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
  const photos = sanitizePhotos(body.photos);
  const regularOpeningHours = sanitizeRegularOpeningHours(body.regularOpeningHours);

  // Privacy rule: a Google Place is shared data (the place exists in the real
  // world, everyone gets to see/refer to it); a user-typed custom name is
  // private to the creator until they explicitly share it via a group event
  // option or favorite (groups.ts auto-publishes at that point).
  const isPrivate = !googlePlaceId;

  const restaurant = await prisma.restaurant.create({
    data: {
      googlePlaceId: googlePlaceId ?? null,
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
      // Spread-only-when-defined so Prisma sees explicit nulls vs undefined
      // correctly: undefined → column unset (NULL), JSON value → stored.
      ...(photos !== undefined && { photos }),
      ...(regularOpeningHours !== undefined && { regularOpeningHours }),
      // Stamp the refresh timestamp when we save Google data so the
      // periodic refresh sweep can pick a sensible "stale" cutoff.
      ...((photos !== undefined || ratingCount !== null || regularOpeningHours !== undefined)
        && { googleDataUpdatedAt: new Date() }),
      createdBy: req.userId,
      private:   isPrivate,
    },
  });
  res.status(201).json({ restaurant });
});

// GET /api/restaurants/:id/reviews — community reviews for a restaurant
router.get('/:id/reviews', async (req: Request, res: Response) => {
  const restaurantId = parseId(req.params.id);
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
router.patch('/:id/match-settings', requireAuth, async (req: Request, res: Response) => {
  const restaurantId = parseId(req.params.id);
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
  const customId = parseId(req.params.customId);
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
