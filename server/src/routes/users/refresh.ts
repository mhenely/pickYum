// Stale Google Places data refresh:
//   - POST /me/refresh-places          (batch — refresh all stale rows)
//   - POST /me/refresh-restaurant/:id  (single-row — JIT on detail-modal open)
//
// Plus the shared refreshOnePlace helper that both routes use, the per-row
// refresh-lock to absorb thundering herds, and the late-bound registration
// with the background refresh job.
//
// Auth + writeLimiter are applied by the parent router in ./index.ts.

import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { externalApiLimiter, perRowRefreshLimiter } from '../../middleware/rateLimits';
import { trackGoogleCall } from '../../lib/apiUsage';
import redis from '../../lib/redis';
import { registerBackgroundRefresher } from '../../lib/backgroundRefresh';

const router = Router();

const PLACE_PRICE_LEVEL_MAP: Record<string, number | null> = {
  PRICE_LEVEL_FREE:           null,
  PRICE_LEVEL_INEXPENSIVE:    1,
  PRICE_LEVEL_MODERATE:       2,
  PRICE_LEVEL_EXPENSIVE:      3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

// `location` requested so we can back-fill lat/lng on stale rows that
// were created before the lat/lng columns existed. New rows already
// store coords at create time; this catches the legacy rows.
//
// ⚠ SKU TIER WARNING — a Place Details call bills at the tier of its
// most expensive requested field (see the TEXT_FIELD_MASK warning in
// routes/places.ts for the full story). This mask deliberately tops
// out at ENTERPRISE tier. `takeout` / `delivery` were removed — both
// are Enterprise+Atmosphere fields that silently bumped every refresh
// call to the most expensive SKU during the launch-month billing
// blowout. Saved rows keep whatever takeout/delivery values they were
// materialized with; refreshes simply stop updating those two columns.
// `reviews` is intentionally absent for the same reason — users get a
// "View on Google" deep-link instead. The tier-guard test enforces
// this mask stays Atmosphere-free. Exported for that test only.
export const DETAIL_FIELD_MASK = [
  'rating', 'userRatingCount', 'priceLevel',
  'internationalPhoneNumber', 'websiteUri',
  'location',
  'photos',
  // Structured weekly hours — drives the detail modal's hours table
  // AND the open-now / closing-soon indicator on the modal/card.
  'regularOpeningHours',
].join(',');
// Bumped from 30 to 90 — restaurant photos/phone/website rarely
// change inside a 90-day window, and refresh-places is the single
// most-spent endpoint when a user has a long history of saved
// restaurants. The 30-day default was over-aggressive given the
// kind of data we cache; 90 days cuts refresh spend by ~67% with
// effectively zero perceived staleness. If a specific row really
// needs fresher data, the new on-demand-refresh-on-modal-open
// pattern (planned Tier 2A) covers the hot path.
const STALE_DAYS = 90;
const MAX_PER_SESSION = 20; // cap API calls per login

// ── Per-restaurant refresh lock ──────────────────────────────────────
// Absorbs thundering herd when many users open the same restaurant
// in quick succession (e.g. a popular spot shared in a group chat).
// Without this lock, each detail-modal open would fire its own
// Place Details call even though the data is going to be identical
// — N users = N billed calls for the same restaurant row.
//
// 5-minute TTL: long enough to coalesce the rush, short enough that
// a row that legitimately needs a re-attempt (e.g. previous refresh
// crashed mid-write) recovers quickly. Redis when available; in-memory
// fallback otherwise (single-instance only — App Runner instances
// each have their own Map, so cross-instance dedup is best-effort).
const REFRESH_LOCK_TTL_S = 5 * 60;
const inMemRefreshLocks = new Map<number, number>(); // restaurantId → expiresAt ms

async function acquireRefreshLock(restaurantId: number): Promise<boolean> {
  if (redis && redis.status === 'ready') {
    // SET ... NX EX atomically sets the key only if it doesn't exist,
    // with the TTL stamped in the same op. Returns 'OK' on acquire,
    // null on contention. catch() defends against transient Redis
    // hiccups — we'd rather miss a dedup than crash the refresh.
    const result = await redis
      .set(`places:refreshLock:${restaurantId}`, '1', 'EX', REFRESH_LOCK_TTL_S, 'NX')
      .catch(() => null);
    return result === 'OK';
  }
  const exp = inMemRefreshLocks.get(restaurantId);
  if (exp && exp > Date.now()) return false;
  inMemRefreshLocks.set(restaurantId, Date.now() + REFRESH_LOCK_TTL_S * 1000);
  return true;
}

// Test-only escape hatch — drops every in-memory lock so a test that
// refreshes restaurant N doesn't leave a lock around to interfere
// with the next test. Production code never calls this.
export function _resetRefreshLocksForTests(): void {
  inMemRefreshLocks.clear();
}

// Shared helper: fetch fresh Place Details from Google and apply
// them to one Restaurant row. Returns the updated row on success,
// or null on any failure (network / non-200 / shape mismatch / lock
// contention).
//
// Used by:
//   - POST /me/refresh-places (batch — refreshes up to N stale rows
//                              for the user in one shot, on demand)
//   - POST /restaurants/:id/refresh-if-stale (single-row — fired by
//                              the detail modal on open, only when
//                              the row is actually stale; cuts
//                              Place Details spend in proportion to
//                              what the user actually views)
//
// Pulled to module scope so both endpoints share one canonical
// transform — previously the field-extraction logic lived inline in
// refresh-places and would drift if duplicated.
async function refreshOnePlace(
  row: { id: number; googlePlaceId: string | null },
  apiKey: string,
  req: Request,
): Promise<Awaited<ReturnType<typeof prisma.restaurant.update>> | null> {
  if (!row.googlePlaceId) return null;
  // Per-row lock — if another caller refreshed this restaurant within
  // the last REFRESH_LOCK_TTL_S, skip the API call. The DB row will
  // already have fresh data (or will momentarily, if the other call
  // is in-flight). Caller treats the null return as "no refresh
  // happened", same as the existing error path — no UI change needed.
  if (!(await acquireRefreshLock(row.id))) {
    trackGoogleCall(req, 'placeDetails', { cacheHit: true });
    return null;
  }
  try {
    const detailRes = await fetch(
      `https://places.googleapis.com/v1/places/${row.googlePlaceId}`,
      { headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': DETAIL_FIELD_MASK } },
    );
    if (!detailRes.ok) {
      console.warn(`[refresh] Place Details failed for ${row.googlePlaceId}: ${detailRes.status}`);
      trackGoogleCall(req, 'placeDetails', { status: 'error' });
      return null;
    }
    trackGoogleCall(req, 'placeDetails');
    const detail = await detailRes.json() as Record<string, unknown>;

    const patch: Prisma.RestaurantUpdateInput = { googleDataUpdatedAt: new Date() };
    if (typeof detail.rating === 'number')           patch.googleRating = detail.rating;
    if (typeof detail.userRatingCount === 'number' && Number.isInteger(detail.userRatingCount))
                                                      patch.ratingCount = detail.userRatingCount;
    if (typeof detail.priceLevel === 'string' && detail.priceLevel in PLACE_PRICE_LEVEL_MAP)
                                                      patch.priceLevel = PLACE_PRICE_LEVEL_MAP[detail.priceLevel];
    if (typeof detail.takeout === 'boolean')          patch.takeout = detail.takeout;
    if (typeof detail.delivery === 'boolean')         patch.delivery = detail.delivery;
    if (typeof detail.internationalPhoneNumber === 'string') patch.phone = detail.internationalPhoneNumber;
    if (typeof detail.websiteUri === 'string')        patch.website = detail.websiteUri;
    const loc = detail.location as { latitude?: number; longitude?: number } | undefined;
    if (loc && typeof loc.latitude === 'number'  && Number.isFinite(loc.latitude))  patch.lat = loc.latitude;
    if (loc && typeof loc.longitude === 'number' && Number.isFinite(loc.longitude)) patch.lng = loc.longitude;
    if (Array.isArray(detail.photos)) {
      const photosSan = (detail.photos as Array<Record<string, unknown>>).slice(0, 10)
        .filter((p) => typeof p?.name === 'string')
        .map((p) => ({
          name:     p.name,
          widthPx:  typeof p.widthPx  === 'number' ? p.widthPx  : null,
          heightPx: typeof p.heightPx === 'number' ? p.heightPx : null,
        }));
      if (photosSan.length > 0) patch.photos = photosSan as unknown as Prisma.InputJsonValue;
    }
    const rawHours = detail.regularOpeningHours;
    if (rawHours && typeof rawHours === 'object') {
      const obj = rawHours as Record<string, unknown>;
      const periods: Array<{ open: { day: number; hour: number; minute: number };
                             close: { day: number; hour: number; minute: number } | null }> = [];
      const cleanPoint = (pt: unknown) => {
        if (!pt || typeof pt !== 'object') return null;
        const x = pt as Record<string, unknown>;
        const day    = typeof x.day    === 'number' && x.day    >= 0 && x.day    <= 6  ? Math.floor(x.day)    : null;
        const hour   = typeof x.hour   === 'number' && x.hour   >= 0 && x.hour   <= 23 ? Math.floor(x.hour)   : null;
        const minute = typeof x.minute === 'number' && x.minute >= 0 && x.minute <= 59 ? Math.floor(x.minute) : null;
        if (day === null || hour === null || minute === null) return null;
        return { day, hour, minute };
      };
      const rawPeriods = Array.isArray(obj.periods) ? obj.periods : [];
      for (const period of rawPeriods.slice(0, 30)) {
        if (!period || typeof period !== 'object') continue;
        const p = period as Record<string, unknown>;
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
      if (periods.length > 0 || weekdayDescriptions.length > 0) {
        patch.regularOpeningHours = ({ periods, weekdayDescriptions } as unknown) as Prisma.InputJsonValue;
      }
    }

    return await prisma.restaurant.update({ where: { id: row.id }, data: patch });
  } catch (err) {
    console.warn(`[refresh] Error refreshing restaurant ${row.id} (${row.googlePlaceId}):`, err);
    trackGoogleCall(req, 'placeDetails', { status: 'error' });
    return null;
  }
}

// POST /api/users/me/refresh-places
// Finds this user's Google-sourced restaurants not updated in the last 30 days and refreshes them.
// Hits the paid Google Places API per record, so it gets the stricter external limiter.
router.post('/me/refresh-places', externalApiLimiter, async (req: Request, res: Response) => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    res.json({ updated: [] });
    return;
  }

  const staleThreshold = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

  const userLinks = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      favorites: { select: { restaurantId: true } },
      options:   { select: { restaurantId: true } },
      accepted:  { select: { restaurantId: true } },
      // Archived rows now ride along on the regular stale sweep so
      // a row that gets unarchived months later doesn't surface with
      // year-old data. The marginal cost is tiny (typical user has
      // ~10 archived rows; 30-day stale-threshold caps the refresh
      // rate; refresh-places is the cheapest of the Google API
      // calls at ~$0.017/row) and stale-archived rows were the
      // most common "where's my photos / phone / etc." complaint.
      // Relation name on User is `archives` (plural), not `archived`.
      archives:  { select: { restaurantId: true } },
    },
  });

  if (!userLinks) { res.json({ updated: [] }); return; }

  const linkedIds = [...new Set([
    ...userLinks.favorites.map((f) => f.restaurantId),
    ...userLinks.options.map((o) => o.restaurantId),
    ...userLinks.accepted.map((a) => a.restaurantId),
    ...userLinks.archives.map((a) => a.restaurantId),
  ])];

  if (linkedIds.length === 0) { res.json({ updated: [] }); return; }

  const stale = await prisma.restaurant.findMany({
    take: MAX_PER_SESSION,
    where: {
      id: { in: linkedIds },
      googlePlaceId: { not: null },
      OR: [
        { googleDataUpdatedAt: null },
        { googleDataUpdatedAt: { lt: staleThreshold } },
        // Critical-data backfill: rows with a placeId but no
        // photos got their timestamp set by an earlier refresh
        // pass that didn't capture photos (or by some other path
        // that bumped the timestamp without populating media).
        // Without this branch, those rows look "fresh" forever
        // even though they're missing the most user-visible
        // field. Cheap to add — every Google call returns photos
        // for places that have any, so this self-heals on next
        // visit. `Prisma.DbNull` matches the column's SQL-level
        // NULL (the JsonNull sentinel matches a stored JSON `null`
        // value, which is a different concept).
        { photos: { equals: Prisma.DbNull } },
      ],
    },
    orderBy: { googleDataUpdatedAt: 'asc' }, // refresh oldest first
  });

  if (stale.length === 0) { res.json({ updated: [] }); return; }

  console.log(`[refresh] Refreshing ${stale.length} stale restaurant(s)`);

  // Refresh each stale place in parallel via the shared helper.
  // Promise.all collapses N round-trips of ~200-400ms each into the
  // slowest single round-trip. refreshOnePlace returns null on any
  // failure (its own try/catch); we filter those out at the end.
  // googleReviews column is intentionally not refreshed — see
  // DETAIL_FIELD_MASK comment for the SKU rationale.
  const results = await Promise.all(
    stale.map((r) => refreshOnePlace(r, apiKey, req)),
  );
  const updated = results.filter((r): r is NonNullable<typeof r> => r !== null);

  console.log(`[refresh] Updated ${updated.length} restaurant(s)`);
  res.json({ updated });
});

// POST /api/users/me/refresh-restaurant/:id
// "Just-in-time" single-row refresh — fired by the detail modal on
// open so we only spend Place Details quota on restaurants the user
// is actually looking at. Replaces the eager "refresh every saved
// restaurant" batching for the typical case where a user views 5
// of their 50 saved rows in a given session.
//
// Three response shapes:
//   1. `{ refreshed: true,  restaurant }`  — row was stale, we
//      refreshed and return the updated row
//   2. `{ refreshed: false, restaurant: null }` — row was fresh
//      (last refresh < STALE_DAYS ago) OR not a Google Place row
//      (custom rows have no upstream to refresh from)
//   3. `{ refreshed: false, restaurant: null }` on error too — we
//      degrade silently rather than failing the modal open
//
// Visibility-gated like the read paths: private rows visible only
// to the creator. Auth required since this spends API quota.
router.post('/me/refresh-restaurant/:id', perRowRefreshLimiter, async (req: Request, res: Response) => {
  const restaurantId = Number(req.params.id);
  if (!Number.isInteger(restaurantId) || restaurantId <= 0) {
    res.status(400).json({ error: 'Invalid restaurant ID' });
    return;
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) { res.json({ refreshed: false, restaurant: null }); return; }

  // Cheap precheck — pull only the columns we need to decide
  // whether to spend a Google call. No findUniqueOrThrow; absent
  // rows fall through to a 200 no-op so modal opens don't error.
  const row = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      googlePlaceId: true,
      googleDataUpdatedAt: true,
      // Pulled so the staleness check can ALSO trigger a refresh
      // when photos are missing — see the "critical-data
      // backfill" branch below.
      photos: true,
      private: true,
      createdBy: true,
    },
  });
  if (!row) { res.json({ refreshed: false, restaurant: null }); return; }

  // Visibility: private rows only visible to creator. Match the
  // GET /api/restaurants/:id behavior so the modal doesn't refresh
  // a row it couldn't read.
  if (row.private && row.createdBy !== req.userId) {
    res.json({ refreshed: false, restaurant: null });
    return;
  }

  // Custom (no googlePlaceId) rows have nothing to refresh — they
  // were user-typed, not Google-sourced.
  if (!row.googlePlaceId) {
    res.json({ refreshed: false, restaurant: null });
    return;
  }

  // Already-fresh rows skip the Google call entirely. This is the
  // common path once a user has a warm cache: same row opened
  // twice in a week pays for the first open, not the second.
  //
  // Exception: if `photos` is null we ALWAYS refresh, regardless
  // of the timestamp. Rows from before the photos column was
  // captured (or refreshed by an earlier pass that didn't request
  // photos) carry a recent timestamp but null photos — without
  // this branch they'd stay photo-less forever because the staleness
  // check would skip them. Every Google call returns photos for
  // places that have any, so this self-heals on first detail-modal
  // open and is cheap (one call per stuck row, one time only).
  const staleThreshold = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
  const photosMissing = row.photos == null;
  const timestampFresh = row.googleDataUpdatedAt && row.googleDataUpdatedAt > staleThreshold;
  if (timestampFresh && !photosMissing) {
    res.json({ refreshed: false, restaurant: null });
    return;
  }

  // Stale → one Place Details call via the shared helper.
  const updated = await refreshOnePlace(row, apiKey, req);
  if (!updated) { res.json({ refreshed: false, restaurant: null }); return; }
  res.json({ refreshed: true, restaurant: updated });
});

// Wire the background-refresh job's late-bound dependency. Module-level
// side effect on import; safe because `registerBackgroundRefresher`
// just stores the function pointer — the job doesn't fire until
// `startBackgroundRefresh()` is called from index.ts at boot.
// See server/src/lib/backgroundRefresh.ts for the rationale on the
// late-binding pattern (avoids a circular import between users.ts and
// the bg refresh module).
registerBackgroundRefresher(refreshOnePlace);

export default router;
