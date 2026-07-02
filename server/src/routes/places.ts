import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import redis from '../lib/redis';
import { trackGoogleCall } from '../lib/apiUsage';
import {
  parseDietaryParam,
  filterableSubset,
  infoOnlyTags,
  applyDietaryFilter,
} from '../lib/dietaryFilters';
import { logger } from '../lib/logger';
import { mirrorPhotoFromCdnUrl, proxyMirroredPublicUrl } from '../lib/photoStorage';

const router = Router();

// NOTE: requireAuth + placesLimiter are applied router-wide BELOW, but
// the photo proxy (registered at the bottom of this file) is registered
// AFTER its dedicated middleware so it inherits these too. We
// historically tried to make /photo public-but-rate-limited to dodge a
// CORP/auth interaction (a 401 from requireAuth carries Helmet's
// default `CORP: same-origin` header, which the browser then blocks as
// NotSameOrigin when loading an <img>) but landed on a cleaner fix:
// register /photo BEFORE the router-wide auth + rate-limit middleware
// so it stays unauthenticated. The dedicated photoLimiter handles
// quota abuse on that route; the strict PHOTO_NAME_RE regex prevents
// arbitrary path traversal through to Google's API key. No user data
// flows through the photo response.

// 20 requests per 5 minutes per IP — covers normal interactive use
// (a user iterating on filters/radius/cuisine typically issues 5-10
// searches per session) while raising the floor against a runaway
// client bug burning Google Places budget. Bumped down from 30 after
// the cost-optimization pass — the previous ceiling was generous
// enough that a misbehaving page-refresh loop could rack up real spend
// before tripping. If a legit user hits this on a normal session, ease
// it back up; the limiter is a safety net, not a usage gate.
//
// Skipped in tests because jest runs many requests from the same
// pseudo-IP back-to-back, which would trip the cap before relevant
// assertions ran. Production limiting is the integration concern of
// the deployed service.
const placesLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many search requests, please slow down' },
  skip: () => process.env.NODE_ENV === 'test',
});

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

// ── Photo shape helper ──────────────────────────────────────────────────
// Google's `places.photos` returns an array of photo metadata. To actually
// display a photo, the client calls our /api/places/photo proxy with the
// `name` field — the proxy 302-redirects to a signed CDN URL so the
// Google API key stays server-side. We surface `name` + dimensions only.
//
// Reviews were intentionally dropped — `places.reviews` is Enterprise-
// tier and roughly doubles the per-call cost. Users get a "View on
// Google" deep-link to the place's Maps page instead, which is free and
// shows full reviews on Google's own surface.
type RawPlace = {
  photos?: Array<{ name?: string; widthPx?: number; heightPx?: number }>;
  userRatingCount?: number;
  regularOpeningHours?: RawRegularOpeningHours;
};

interface PlacePhoto {
  name: string;
  widthPx: number | null;
  heightPx: number | null;
}

function extractPhotos(p: RawPlace, max = 5): PlacePhoto[] {
  const photos = Array.isArray(p.photos) ? p.photos : [];
  return photos
    .slice(0, max)
    .filter((ph) => typeof ph?.name === 'string')
    .map((ph) => ({
      name:    ph.name as string,
      widthPx:  typeof ph.widthPx  === 'number' ? ph.widthPx  : null,
      heightPx: typeof ph.heightPx === 'number' ? ph.heightPx : null,
    }));
}

// ── Opening-hours shape ─────────────────────────────────────────────────
// Google's `regularOpeningHours` is the standard weekly schedule (as
// opposed to `currentOpeningHours` which folds in special-day overrides
// for the upcoming week). We use regularOpeningHours because:
//   1. It's cacheable — it doesn't change daily.
//   2. The periods are the basis for a reliable client-side "is open
//      now" check (we compute against the user's clock, fresh, instead
//      of trusting Google's snapshot `openNow` boolean).
// Each period is `{ open: Point, close: Point }`; each Point has
// day (0-6, Sunday=0), hour (0-23), minute (0-59). A close at the
// next day wraps via day=(day+1)%7. weekdayDescriptions is an array
// of seven human-readable strings, in MONDAY-first order per Google's
// docs.
type RawOpeningPoint = { day?: number; hour?: number; minute?: number };
type RawOpeningPeriod = { open?: RawOpeningPoint; close?: RawOpeningPoint };
type RawRegularOpeningHours = {
  periods?: RawOpeningPeriod[];
  weekdayDescriptions?: string[];
};

interface OpeningPoint  { day: number; hour: number; minute: number; }
interface OpeningPeriod { open: OpeningPoint; close: OpeningPoint | null; }
interface RegularOpeningHours {
  periods: OpeningPeriod[];
  weekdayDescriptions: string[];
}

// Some 24-hour places omit the `close` point entirely (interpreted as
// "open continuously starting at open"); we preserve that as a null
// close so the client treats those as always-open during the day.
// Anything that doesn't shape-match is dropped silently — a corrupt
// entry from upstream shouldn't crash the response transform.
function sanitizeOpeningPoint(p: RawOpeningPoint | undefined): OpeningPoint | null {
  if (!p) return null;
  const day    = typeof p.day    === 'number' && p.day    >= 0 && p.day    <= 6 ? Math.floor(p.day)    : null;
  const hour   = typeof p.hour   === 'number' && p.hour   >= 0 && p.hour   <= 23 ? Math.floor(p.hour)   : null;
  const minute = typeof p.minute === 'number' && p.minute >= 0 && p.minute <= 59 ? Math.floor(p.minute) : null;
  if (day === null || hour === null || minute === null) return null;
  return { day, hour, minute };
}

function extractRegularOpeningHours(p: RawPlace): RegularOpeningHours | null {
  const raw = p.regularOpeningHours;
  if (!raw || typeof raw !== 'object') return null;
  const rawPeriods = Array.isArray(raw.periods) ? raw.periods : [];
  const periods: OpeningPeriod[] = [];
  // Cap periods at 30 — covers any plausible schedule (e.g. split
  // lunch/dinner hours each day = 14 periods; 30 leaves headroom for
  // odd cases without permitting an unbounded array).
  for (const period of rawPeriods.slice(0, 30)) {
    const open  = sanitizeOpeningPoint(period?.open);
    if (!open) continue;
    const close = sanitizeOpeningPoint(period?.close);
    periods.push({ open, close });
  }
  const rawDescs = Array.isArray(raw.weekdayDescriptions) ? raw.weekdayDescriptions : [];
  const weekdayDescriptions = rawDescs
    .slice(0, 7)
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.slice(0, 200));
  // If both arrays are empty there's nothing useful to surface — return
  // null so consumers can skip the field cleanly.
  if (periods.length === 0 && weekdayDescriptions.length === 0) return null;
  return { periods, weekdayDescriptions };
}

// ── Cache layer (Redis when available, in-memory fallback) ───────────────
//
// TTLs picked to maximize cache hit rate without serving meaningfully
// stale data. Bumped progressively over time as Google Places spend
// pressure has grown — restaurant data doesn't change minute-to-minute
// (or even day-to-day for most fields), so the conservative defaults
// from earlier iterations were burning money to refresh data that
// hadn't actually changed.
//
// NEARBY: stale-while-revalidate. We serve fresh from cache for
// NEARBY_FRESH_S, then serve stale (and kick off a background refresh)
// up to NEARBY_TTL_S. The fresh-window bump (15min → 60min) is the
// load-bearing change for cost: most users iterating on radius / cuisine
// / dietary now hit the fresh path, paying zero. The outer TTL bump
// (90min → 24h) gives SWR room — past the 60-min boundary, users still
// get instant stale + background refresh, but the worst-case "user
// past the freshUntil window who triggers the refresh" amortizes across
// every other user reading the cached result for the next 23h. Combined,
// effective cache hit rate climbs significantly for any area with even
// modest user density.
//
// Worst-case staleness is NEARBY_TTL_S (24h). Restaurants' hours,
// ratings, and photo refs don't shift that fast — typical data drift
// over a day is "rating ticked from 4.4 to 4.5 because of 12 new
// reviews", which doesn't change whether the user wants to eat there.
// The actual "is open now" computation is done client-side from
// regularOpeningHours periods (not from a cached snapshot), so
// hour-of-day correctness is independent of this TTL. A place that
// permanently closes gets a "closed permanently" pill from the
// `businessStatus` field the next time the SWR refresh lands, so the
// 24h worst case shows them as still listed but doesn't claim they're
// open.
const NEARBY_FRESH_S = 60 * 60;       //  60 minutes — serve as fresh, no refresh
const NEARBY_TTL_S   = 24 * 60 * 60;  //  24 hours — total cache lifetime (incl. stale window)
// TEXT_TTL_S: text-search results don't have SWR (just plain TTL), so
// staleness here is "user reruns the same name search within N min and
// gets cached results". 30 min is forgiving but well within how often
// a Google text-search result for a specific restaurant name actually
// changes (rating + business_status are the only volatile fields, and
// neither shifts noticeably in half an hour). The previous 5-min ceiling
// was paranoid by an order of magnitude relative to actual data drift.
const TEXT_TTL_S     = 30 * 60;       //  30 minutes
// Geocoding results essentially never change — an address resolves
// to the same lat/lng forever (until the post office renumbers a
// street, which is rare). Bumped to 24h so a daily user pays the
// geocode SKU once a day instead of every 30 min. Geocoding is
// already the cheapest API ($5/1k) so the savings are small, but
// no real downside.
const GEOCODE_TTL_S  = 24 * 60 * 60; // 24 hours
// Signed Google CDN photo URLs are valid for a few hours, so caching
// at 30 min is well within the safe window. Drops a 10-100×
// reduction on the biggest cost line — without this cache, every
// <img> render hits Google's /v1/{name}/media endpoint (billed per
// call) even though the actual image bytes come from the
// publicly-cached CDN URL.
const PHOTO_URL_TTL_S = 30 * 60; // 30 minutes

interface NearbyEntry {
  restaurants: unknown[];
  rawPlaces: unknown[];
  resolvedAddress: string;
  // Geocoded center of the searched location. Surfaced so the frontend can
  // center a map on the same point the radius was measured from, even when
  // no results came back.
  resolvedLat: number;
  resolvedLng: number;
  // SWR boundary: epoch-ms wall-clock timestamp past which the entry is
  // considered stale. Reads after this time still serve from cache but
  // trigger a background refresh. Distinct from the Redis/in-memory
  // expiry, which is NEARBY_TTL_S (the absolute eviction time). Older
  // cache entries written before SWR shipped will read this as
  // undefined — handled by treating them as "always fresh" until they
  // expire normally.
  freshUntilMs?: number;
}
interface TextEntry   { restaurants: unknown[]; }
interface GeocodeEntry { lat: number; lng: number; formattedAddress: string; }

// In-memory fallbacks used when Redis is not configured
const inMemNearby   = new Map<string, NearbyEntry  & { expiresAt: number }>();
const inMemText     = new Map<string, TextEntry    & { expiresAt: number }>();
const inMemGeocode  = new Map<string, GeocodeEntry & { expiresAt: number }>();

// In-flight nearby fan-out promises, keyed by cacheKey(lat, lng,
// radius, cuisineType). Two purposes:
//   1. Concurrent dedup: if a request comes in while an identical
//      fan-out is already running, the second request awaits the
//      first's promise instead of issuing its own (saves duplicate
//      Google calls when N users hit the same key in the same beat).
//   2. SWR background refreshes: when a stale read triggers a
//      background refresh, additional concurrent stale reads see the
//      promise here and skip starting their own.
// Single-instance only — App Runner instances each have their own
// Map. Cross-instance dedup would need a Redis lock; the cost
// savings from that don't yet justify the complexity.
const inFlightNearby = new Map<string, Promise<NearbyEntry>>();
// Photo signed-URL cache. Each entry maps a (photoName, maxWidthPx)
// pair to the redirect URL Google returned for it. Photos viewed
// repeatedly within the 30-min TTL skip the upstream /media call
// entirely. Without this cache, every <img> render = one Google
// API call (billed) even though the actual image is served from
// Google's CDN.
const inMemPhotoUrl = new Map<string, { url: string; expiresAt: number }>();

// Mirror flag: tracks which photos have been mirrored to Supabase
// Storage. Once set, photo proxy reads skip Google entirely and
// redirect directly to the Supabase public URL — permanent zero-cost
// cache on top of the 30-min signed-URL layer.
//
// 30-day TTL: longer than the typical photo-ref rotation window. If
// Google rotates a ref before the flag expires, the new ref maps to
// a different cache path (different hash) and gets its own mirror
// pass; the old mirrored bytes linger in Storage until we add a
// cleanup pass.
const PROXY_MIRROR_TTL_S = 30 * 24 * 60 * 60;
const inMemMirrorFlags = new Map<string, number>(); // hash → expiresAt ms

// In-process dedup for active mirror uploads. Multiple users hitting
// the same unmirrored photo within seconds shouldn't each kick off
// their own download + upload — the first one's enough. App Runner
// instances each have their own Set, so cross-instance dedup is
// best-effort (an extra upload here costs the same upsert with
// identical bytes).
const inFlightMirrors = new Set<string>();

async function nearbyGet(key: string): Promise<NearbyEntry | null> {
  if (redis && redis.status === 'ready') {
    const raw = await redis.get(`places:nearby:${key}`).catch(() => null);
    return raw ? (JSON.parse(raw) as NearbyEntry) : null;
  }
  const e = inMemNearby.get(key);
  return e && e.expiresAt > Date.now() ? e : null;
}

async function nearbySet(key: string, value: NearbyEntry): Promise<void> {
  // Stamp the SWR boundary at write time. Reads compare against this
  // timestamp to decide whether to trigger a background refresh; the
  // outer TTL still caps the absolute lifetime.
  const stamped: NearbyEntry = {
    ...value,
    freshUntilMs: Date.now() + NEARBY_FRESH_S * 1000,
  };
  if (redis && redis.status === 'ready') {
    await redis.setex(`places:nearby:${key}`, NEARBY_TTL_S, JSON.stringify(stamped)).catch(() => {});
    return;
  }
  inMemNearby.set(key, { ...stamped, expiresAt: Date.now() + NEARBY_TTL_S * 1000 });
}

// Normalize for cache hits: lowercase + collapse whitespace. "  Main St  "
// and "MAIN ST" should share a slot. Keep punctuation as-is — Google's
// geocoder is forgiving of casing/spacing but precise about commas /
// hyphens, so over-normalizing would invite false hits.
//
// Used by BOTH the geocode cache (lat/lng for an address) and the text-
// search cache (search-as-you-type), so a keystroke-driven autocomplete
// gets meaningful hit rates instead of one slot per literal query string.
function normalizeQueryKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Cache key for an optional location bias. Coords are quantized to 4
// decimal places (~11m) so e.g. lat=45.12345 and lat=45.12346 share the
// same cache entry — the bias only nudges Google's ranking, hundredth-of-a-meter
// precision wouldn't change results. `null` returns '' so unbiased
// queries get a stable shared key.
function biasCacheKey(bias: LocationBias | null): string {
  if (!bias) return '';
  const lat = bias.lat.toFixed(4);
  const lng = bias.lng.toFixed(4);
  return `|${lat},${lng},${bias.radius}`;
}

async function textGet(q: string, bias: LocationBias | null): Promise<TextEntry | null> {
  const key = normalizeQueryKey(q) + biasCacheKey(bias);
  if (redis && redis.status === 'ready') {
    const raw = await redis.get(`places:text:${key}`).catch(() => null);
    return raw ? (JSON.parse(raw) as TextEntry) : null;
  }
  const e = inMemText.get(key);
  return e && e.expiresAt > Date.now() ? e : null;
}

async function textSet(q: string, bias: LocationBias | null, value: TextEntry): Promise<void> {
  const key = normalizeQueryKey(q) + biasCacheKey(bias);
  if (redis && redis.status === 'ready') {
    await redis.setex(`places:text:${key}`, TEXT_TTL_S, JSON.stringify(value)).catch(() => {});
    return;
  }
  inMemText.set(key, { ...value, expiresAt: Date.now() + TEXT_TTL_S * 1000 });
}

interface LocationBias { lat: number; lng: number; radius: number }

// Kept as a separate exported alias for backward compat with the existing
// geocode call sites. Internally just normalizeQueryKey.
function geocodeKey(address: string): string {
  return normalizeQueryKey(address);
}

async function geocodeGet(address: string): Promise<GeocodeEntry | null> {
  const key = geocodeKey(address);
  if (redis && redis.status === 'ready') {
    const raw = await redis.get(`places:geocode:${key}`).catch(() => null);
    return raw ? (JSON.parse(raw) as GeocodeEntry) : null;
  }
  const e = inMemGeocode.get(key);
  return e && e.expiresAt > Date.now() ? e : null;
}

async function geocodeSet(address: string, value: GeocodeEntry): Promise<void> {
  const key = geocodeKey(address);
  if (redis && redis.status === 'ready') {
    await redis.setex(`places:geocode:${key}`, GEOCODE_TTL_S, JSON.stringify(value)).catch(() => {});
    return;
  }
  inMemGeocode.set(key, { ...value, expiresAt: Date.now() + GEOCODE_TTL_S * 1000 });
}

// Photo signed-URL cache. Key is `(photoName, maxWidthPx)` because
// Google returns a different signed URL per requested width.
// Returns null on miss; caller proceeds to fetch from Google.
async function photoUrlGet(name: string, maxWidthPx: number): Promise<string | null> {
  const key = `${name}::${maxWidthPx}`;
  if (redis && redis.status === 'ready') {
    return await redis.get(`places:photoUrl:${key}`).catch(() => null);
  }
  const e = inMemPhotoUrl.get(key);
  return e && e.expiresAt > Date.now() ? e.url : null;
}

// Fire-and-forget store — failures are non-fatal (we just lose the
// cache for that one entry, fall through to a fresh Google call on
// the next miss).
async function photoUrlSet(name: string, maxWidthPx: number, url: string): Promise<void> {
  const key = `${name}::${maxWidthPx}`;
  if (redis && redis.status === 'ready') {
    await redis.setex(`places:photoUrl:${key}`, PHOTO_URL_TTL_S, url).catch(() => {});
    return;
  }
  inMemPhotoUrl.set(key, { url, expiresAt: Date.now() + PHOTO_URL_TTL_S * 1000 });
}

// Hash helper shared by the mirror-flag read/write. Must stay in sync
// with proxyCachePath in lib/photoStorage.ts — same input → same hash
// → same Supabase storage path → same public URL.
function mirrorFlagKey(name: string, maxWidthPx: number): string {
  return crypto.createHash('md5').update(`${name}::${maxWidthPx}`).digest('hex');
}

// Returns true if this photo has already been mirrored to Supabase
// (within the PROXY_MIRROR_TTL_S window). Caller can then redirect
// directly to the public Supabase URL without any Google call.
async function photoMirrorIsSet(name: string, maxWidthPx: number): Promise<boolean> {
  const key = mirrorFlagKey(name, maxWidthPx);
  if (redis && redis.status === 'ready') {
    const v = await redis.get(`places:mirrorFlag:${key}`).catch(() => null);
    return v !== null;
  }
  const exp = inMemMirrorFlags.get(key);
  return !!exp && exp > Date.now();
}

// Marks a photo as mirrored. Called after a successful Supabase upload
// completes in the background. Fire-and-forget — if Redis is down we
// just re-mirror on the next view, which is idempotent (same path).
async function photoMirrorMarkSet(name: string, maxWidthPx: number): Promise<void> {
  const key = mirrorFlagKey(name, maxWidthPx);
  if (redis && redis.status === 'ready') {
    await redis.setex(`places:mirrorFlag:${key}`, PROXY_MIRROR_TTL_S, '1').catch(() => {});
    return;
  }
  inMemMirrorFlags.set(key, Date.now() + PROXY_MIRROR_TTL_S * 1000);
}

// Background mirror trigger. Fired after the proxy redirects the
// browser to Google's CDN URL — we then quietly download those bytes
// (from the CDN, which is free) and upload them to Supabase. Next
// view of the same photo skips Google entirely.
//
// Skips if: the photo is already mirrored (flag set), or a mirror is
// already in flight in this process. Failures are logged and
// swallowed — the worst case is we just pay Google again on the next
// view (which would re-trigger this).
function triggerBackgroundMirror(name: string, maxWidthPx: number, cdnUrl: string): void {
  const flightKey = `${name}::${maxWidthPx}`;
  if (inFlightMirrors.has(flightKey)) return;

  // Capture the apiKey before the async closure — if the env changes
  // mid-run we want the snapshot that was valid when the request came in.
  // (Realistically it doesn't change, but it's cheap and correct.)
  inFlightMirrors.add(flightKey);
  void (async () => {
    try {
      // Double-check the flag now that we're actually about to do work
      // — another instance may have mirrored this photo between the
      // proxy read and this background trigger.
      if (await photoMirrorIsSet(name, maxWidthPx)) return;
      const url = await mirrorPhotoFromCdnUrl({ googleName: name, maxWidthPx, cdnUrl });
      if (url) await photoMirrorMarkSet(name, maxWidthPx);
    } catch (err) {
      logger.warn({ err, name, maxWidthPx }, '[places] background photo mirror failed');
    } finally {
      inFlightMirrors.delete(flightKey);
    }
  })();
}

// Round to 3 decimal places (~111 m precision) so nearby searches share
// cache hits. cuisineType (when set) gets its own slot — a search for
// Italian and a search for any-cuisine at the same coords must not
// collide; tally them as different result sets.
//
// Dietary filters intentionally do NOT enter the cache key. Vegetarian
// + non-vegetarian users querying the same area share the upstream
// Google call (the response carries servesVegetarianFood for both),
// and the post-cache filter trims per request. Pays a tiny JS cost
// per response in exchange for not multiplying Google spend by the
// dietary-tag dimension.
function cacheKey(lat: number, lng: number, radius: number, cuisineType: string | null = null): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}::${radius}::${cuisineType ?? 'any'}`;
}

// ── Text-search field mask (smaller than nearby — no location needed) ────
//
// ⚠ SKU TIER WARNING — read before adding ANY field here.
//
// A search call bills at the tier of its MOST EXPENSIVE requested
// field, and each tier has a different monthly free-call allowance
// (Essentials 10K / Pro 5K / Enterprise 1K). Google's field→SKU table:
// https://developers.google.com/maps/billing-and-pricing/sku-details
//
// This mask deliberately tops out at ENTERPRISE tier:
//   - Pro fields:        displayName, formattedAddress, photos, types,
//                        primaryType, primaryTypeDisplayName, businessStatus
//   - Enterprise fields: rating, userRatingCount, priceLevel,
//                        regularOpeningHours, internationalPhoneNumber,
//                        websiteUri
//
// Fields we deliberately DO NOT request (cost history — do not re-add
// without pricing out the consequence):
//   - takeout / delivery / servesVegetarianFood → Enterprise+Atmosphere,
//     the most expensive SKU. These three fields alone were the root
//     cause of the launch-month billing blowout: they silently bumped
//     every search call to the top SKU and burned its 1K/month free
//     allowance almost immediately. The Takeout/Delivery badges and
//     the vegetarian hard-filter were dropped in exchange for
//     Enterprise-tier billing.
//   - reviews → also Enterprise+Atmosphere; users get a "View on
//     Google" deep-link instead.
//
// A tier-guard test (see __tests__/routes/placesFieldMask.test.ts)
// fails the build if an Atmosphere-tier field sneaks back in.
// Exported for that test only — not consumed by other modules.
export const TEXT_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  // primaryType is used server-side (deny-list filter) AND surfaced to
  // the client for the fast-food toggle; the user-visible cuisine label
  // comes from primaryTypeDisplayName.
  'places.primaryType',
  'places.primaryTypeDisplayName',
  // regularOpeningHours feeds the structured weekly hours table in the
  // detail modal (weekdayDescriptions) AND the client-side open-now /
  // closing-soon computation (periods, evaluated fresh against the
  // user's clock).
  'places.regularOpeningHours',
  // Phone + website at search time so newly-materialized rows show
  // these fields in the detail modal immediately, without having to
  // wait for refresh-places to back-fill them.
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.businessStatus',
  'places.photos',
].join(',');

// ── Photo proxy ──────────────────────────────────────────────────────────
//
// GET /api/places/photo?name=<places/.../photos/...>&maxWidthPx=<n>
//
// Returns a 302 redirect to Google's signed CDN URL. Two reasons we don't
// just construct that URL on the frontend:
//   1. The Google Places API key would have to be exposed to client JS to
//      build the URL. That's the line we don't want to cross.
//   2. Google's photo endpoint returns the redirect target with a signed
//      token; we want the SIGNED URL going to the client, not the version
//      with our API key in the query string.
//
// We use `redirect: 'manual'` to capture the Location header without
// streaming the image bytes through our server. Browsers follow the
// redirect to Google's CDN and get the bytes directly + cached by
// Cache-Control headers Google sets on the CDN response.
//
// `name` must match `places/<id>/photos/<ref>` exactly — strict regex
// prevents passing arbitrary paths through to Google's API with our key.
// `maxWidthPx` clamped to [100, 1600]; default 400 fits a card thumb.
const PHOTO_NAME_RE = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_\-=]+$/;

// Helmet's default CORP is `same-origin`, which blocks the browser from
// loading our 302 (or any error response) into an <img> tag on the
// frontend's different origin/port. Apply `cross-origin` at the route
// level so EVERY response path — success, 4xx validation, 5xx upstream
// failure, AND the rate-limiter's 429 — carries the override. The
// previous fix only set it on the 302 success branch, which meant a
// single rate-limit trip would block the rate-limit response with
// NotSameOrigin and then keep blocking every subsequent photo for the
// rest of the rate window. Safe to broaden: photos carry no
// credentials, and the redirect targets are publicly-embeddable signed
// Google CDN URLs.
const photoCorpHeader = (req: Request, res: Response, next: () => void): void => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
};

// Per-IP rate limit. Bumped from 200 → 1000/5min after the carousel
// rollout: each card may load 1-3 photos initially and more on swipe;
// 20 cards × 3 photos = 60 on first paint, plus modal opens / map
// interaction / paging through saved restaurants on Compare easily
// pushes a normal session past 200 in a few minutes. 1000 still rules
// out an unbounded scrape — even at one photo per second, an attacker
// would hit the cap after ~17 minutes of nonstop requests, well
// inside what a real cap-on-abuse limit should catch.
const photoLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many photo requests, please slow down' },
  skip: () => process.env.NODE_ENV === 'test',
});

// REGISTER FIRST so router-wide auth + placesLimiter (applied below)
// don't intercept image requests. <img> tags load with whatever cookie
// state the browser has at request time; a stale/missing auth would
// produce a 401 carrying Helmet's default `CORP: same-origin` header,
// which the browser blocks with NotSameOrigin. Public + photoLimiter
// is the right tradeoff — no user data flows through the photo proxy.
router.get('/photo', photoCorpHeader, photoLimiter, async (req: Request, res: Response) => {
  const name = (req.query.name as string | undefined)?.trim();
  if (!name || !PHOTO_NAME_RE.test(name)) {
    res.status(400).json({ error: 'Invalid photo name' });
    return;
  }
  // Clamp + quantize width to a fixed bucket size so an attacker
  // can't blow up storage / Google spend by varying the width param
  // arbitrarily for the same photo. Frontend only uses 200/400/600/1200
  // in practice; quantizing to nearest 100 caps the distinct cache
  // entries per photo at 16 (100..1600) and rounds UP to preserve
  // image quality vs the requested size.
  const maxWidthRaw = Number(req.query.maxWidthPx);
  const maxWidthClamped = Number.isFinite(maxWidthRaw)
    ? Math.min(1600, Math.max(100, Math.floor(maxWidthRaw)))
    : 400;
  const maxWidthPx = Math.min(1600, Math.ceil(maxWidthClamped / 100) * 100);

  // ── Tier 1 cache: Supabase mirror (permanent, zero Google cost) ──
  // If we've mirrored this photo to Supabase, redirect to the public
  // URL directly. Skips both the signed-URL cache and the Google API.
  // This is the long-tail win — once a photo is mirrored, every
  // future view costs $0.
  if (await photoMirrorIsSet(name, maxWidthPx)) {
    const mirroredUrl = proxyMirroredPublicUrl(name, maxWidthPx);
    if (mirroredUrl) {
      trackGoogleCall(req, 'photo', { cacheHit: true });
      // Long-lived browser cache — the Supabase CDN URL is permanent
      // for a given (photoName, width) pair, so a 1-hour browser
      // cache is conservative.
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.redirect(302, mirroredUrl);
      return;
    }
  }

  // ── Tier 2 cache: Google signed URL (30 min) ───────────────────
  // Google's signed CDN URLs are valid for several hours; we cache
  // for 30 min on our side which leaves a comfortable safety margin.
  // Without this cache, every <img> render = one Google /media call
  // (billed). With it, the same photo viewed N times in 30 min
  // costs 1 Google call instead of N.
  const cached = await photoUrlGet(name, maxWidthPx);
  if (cached) {
    trackGoogleCall(req, 'photo', { cacheHit: true });
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.redirect(302, cached);
    // Kick off a background mirror in case this photo gets viewed
    // enough to be worth eliminating Google entirely. Skips itself
    // if a mirror is already in-flight or done.
    triggerBackgroundMirror(name, maxWidthPx, cached);
    return;
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) { res.status(503).json({ error: 'Photo service not configured' }); return; }

  const upstreamUrl = `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${maxWidthPx}&key=${encodeURIComponent(apiKey)}`;

  try {
    const upstream = await fetch(upstreamUrl, { redirect: 'manual' });
    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get('location');
      if (location) {
        // Cache the signed URL server-side so the next ~30 min worth
        // of requests for this (name, width) skip Google entirely.
        // Fire-and-forget — a cache write failure doesn't break the
        // response.
        photoUrlSet(name, maxWidthPx, location).catch(() => {});
        trackGoogleCall(req, 'photo');
        // Cache the *redirect itself* in the browser for 1 hour. The redirect
        // target (Google CDN URL) has its own long-cache headers, so subsequent
        // page loads of the same photo skip both our proxy and the redirect.
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.redirect(302, location);
        // Fire off the permanent Supabase mirror in the background so
        // future views of this photo skip Google entirely. The CDN
        // URL we just got is fresh and good for a few hours, plenty
        // of time for the background download + upload to complete.
        triggerBackgroundMirror(name, maxWidthPx, location);
        return;
      }
    }
    // Non-redirect (no 3xx Location) — Google returned an actual status
    // body. Read the body for diagnostics. Most common case in practice:
    // 400 INVALID_ARGUMENT with the message "The photo resource in the
    // request is invalid. Please retrieve it from Places API endpoints."
    // This happens for stored refs that Google has rotated/removed since
    // we cached them — Google's docs claim refs are persistent but they
    // empirically aren't. Client recovers via `useRestaurantPhotoBackfill`
    // firing a per-restaurant Place Details refresh when the <img> errors;
    // server side just needs to surface enough info to debug.
    const upstreamBody = await upstream.text().catch(() => '');
    logger.warn(
      { upstreamStatus: upstream.status, upstreamBody: upstreamBody.slice(0, 400), name },
      'photo proxy: upstream returned non-3xx',
    );
    trackGoogleCall(req, 'photo', { status: 'error' });
    res.status(502).json({ error: 'Photo unavailable' });
  } catch (err) {
    logger.warn({ err, name }, '[places] photo proxy threw');
    trackGoogleCall(req, 'photo', { status: 'error' });
    res.status(502).json({ error: 'Photo unavailable' });
  }
});

// Apply router-wide auth + rate limit AFTER /photo so they don't gate
// it. Every route registered below this line goes through both.
router.use(requireAuth);
router.use(placesLimiter);

// GET /api/places/text-search?q=<query>&lat=<n>&lng=<n>&radius=<m>
//
// The optional lat/lng/radius triple is forwarded to Google as a
// `locationBias.circle` so results rank closer to the user's intent.
// Without bias the search is global — useful for "is this restaurant
// on Google anywhere?" lookups, less useful for "where can I eat near
// me?" intent. The client decides whether to send bias based on
// whether the user has a resolved location.
router.get('/text-search', async (req: Request, res: Response) => {
  const q = ((req.query.q as string) ?? '').trim();
  if (q.length < 2) {
    res.status(400).json({ error: 'q must be at least 2 characters' });
    return;
  }

  // Parse + validate the optional bias triple. All three must be present
  // and well-formed, otherwise we silently fall back to a global search
  // (no error — half-specified bias is just a caller bug, no need to
  // 400 the user-visible request over it).
  const latRaw    = parseFloat(req.query.lat    as string);
  const lngRaw    = parseFloat(req.query.lng    as string);
  const radiusRaw = parseFloat(req.query.radius as string);
  let bias: LocationBias | null = null;
  if (
    Number.isFinite(latRaw) && latRaw >= -90  && latRaw <= 90 &&
    Number.isFinite(lngRaw) && lngRaw >= -180 && lngRaw <= 180 &&
    Number.isFinite(radiusRaw) && radiusRaw > 0 && radiusRaw <= 50_000 // Google's max for searchText
  ) {
    bias = { lat: latRaw, lng: lngRaw, radius: radiusRaw };
  }

  // Same dietary-filter shape as /nearby. The text-search cache is
  // keyed on (q, bias) only — dietary stays out of the key so a
  // veg-on user and a veg-off user searching "thai" share the
  // upstream call, and the post-filter trims per request.
  const dietary = parseDietaryParam(req.query.dietary);
  const informationalDietary = infoOnlyTags(dietary);
  const activeDietary        = filterableSubset(dietary);

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    res.json({ restaurants: [], configured: false });
    return;
  }

  const cached = await textGet(q, bias);
  if (cached) {
    trackGoogleCall(req, 'textSearch', { cacheHit: true });
    const cachedRestaurants = cached.restaurants as Array<{ servesVegetarianFood?: boolean | null }>;
    res.json({
      restaurants: applyDietaryFilter(cachedRestaurants, activeDietary),
      configured: true,
      informationalDietary,
      activeDietary,
    });
    return;
  }

  const requestBody: Record<string, unknown> = {
    textQuery:      `${q} restaurant`,
    maxResultCount: 10,
  };
  if (bias) {
    requestBody.locationBias = {
      circle: {
        center: { latitude: bias.lat, longitude: bias.lng },
        radius: bias.radius,
      },
    };
  }

  const searchRes = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': TEXT_FIELD_MASK,
    },
    body: JSON.stringify(requestBody),
  });

  const data = await searchRes.json() as any;
  if (!searchRes.ok) {
    trackGoogleCall(req, 'textSearch', { status: 'error' });
    res.status(502).json({ error: data.error?.message ?? 'Places text search failed' });
    return;
  }
  trackGoogleCall(req, 'textSearch');

  const restaurants = (data.places ?? [])
    .filter((p: any) => p.businessStatus !== 'CLOSED_PERMANENTLY')
    .map((p: any) => ({
      googlePlaceId: p.id as string,
      name:          (p.displayName?.text ?? '') as string,
      googleRating:  (p.rating as number | undefined) ?? null,
      // Total number of user ratings backing the average. Lets the UI
      // disambiguate "4.5 stars from 3 ratings" vs "4.5 stars from 800".
      ratingCount:   typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
      priceLevel:    PRICE_LEVEL_MAP[p.priceLevel] ?? null,
      address:       (p.formattedAddress as string | undefined) ?? null,
      cuisineType:   (p.primaryTypeDisplayName?.text as string | undefined) ?? null,
      // Machine-readable type slug ("fast_food_restaurant", "cafe", …).
      // Powers the client-side fast-food toggle — already fetched for
      // the deny-list filter, so surfacing it costs nothing extra.
      primaryType:   (p.primaryType as string | undefined) ?? null,
      openNow:       (p.currentOpeningHours?.openNow as boolean | undefined) ?? null,
      photos:        extractPhotos(p),
      regularOpeningHours: extractRegularOpeningHours(p),
      // E.164 international format ("+1 555-555-5555") for the tel:
      // link in the modal. null when Google doesn't have one on file.
      phone:         (p.internationalPhoneNumber as string | undefined) ?? null,
      // Public website URL. null when missing; the modal hides the row.
      website:       (p.websiteUri as string | undefined) ?? null,
      // takeout / delivery / servesVegetarianFood intentionally absent:
      // their fields were dropped from the mask to escape the
      // Enterprise+Atmosphere SKU. Saved rows keep whatever values they
      // were materialized with; fresh search results simply omit them.
    }));

  await textSet(q, bias, { restaurants });
  // Cache is stored unfiltered — same rationale as /nearby. Post-
  // filter the response to honor the caller's dietary param.
  res.json({
    restaurants: applyDietaryFilter(restaurants, activeDietary),
    configured: true,
    informationalDietary,
    activeDietary,
  });
});

// ── Fields to request — only pay for what we use ──────────────────────────
// ⚠ SKU TIER WARNING: see the TEXT_FIELD_MASK comment above for the
// full field→tier breakdown and the cost history behind it. Summary:
// this mask deliberately tops out at ENTERPRISE tier. Do NOT add
// takeout / delivery / servesVegetarianFood / reviews — each bumps
// every nearby call to Enterprise+Atmosphere (the most expensive SKU,
// smallest free allowance). The tier-guard test enforces this.
// Exported for that test only.
export const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  // `places.types` is consumed server-side by the cuisine-broaden
  // post-filter (see merge loop in the /nearby handler) and by the
  // client-side fast-food toggle. Same Pro-tier slot as primaryType.
  'places.types',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  // See TEXT_FIELD_MASK comment — same rationale. currentOpeningHours
  // dropped because the frontend computes openNow fresh from
  // regularOpeningHours periods.
  'places.regularOpeningHours',
  // Phone + website surfaced at search time so the modal can show
  // them without waiting on the refresh-places back-fill.
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.businessStatus',
  'places.photos',
].join(',');

// ── Non-food deny-list for the nearby search ─────────────────────────────
// `includedTypes: ['restaurant']` matches anywhere in a place's `types[]`
// array, which is why a sports stadium with food vendors comes through —
// Google tags it with `restaurant` in its types because food is sold,
// even though its PRIMARY type is `stadium`. `excludedPrimaryTypes`
// filters out places whose primaryType is one of these, regardless of
// what else is in types[]. The places list ships in Type Table A of
// Google's Place Types docs.
//
// HARD CAP: Google rejects calls with >50 entries here. We keep the list
// tight by sticking to the highest-signal offenders (places most likely
// to be flagged with `restaurant` in their secondary types) and leaving
// out long-tail categories that are unlikely to match a restaurant
// search anyway. If a legit food place gets filtered, remove the
// offending primary type — there's no harm except some non-food results
// sneaking back in.
const EXCLUDED_PRIMARY_TYPES = [
  // Venues / attractions that happen to sell food
  'stadium', 'arena',
  'tourist_attraction', 'amusement_park',
  'aquarium', 'zoo', 'museum', 'art_gallery',
  'bowling_alley', 'casino', 'golf_course',
  'movie_theater', 'performing_arts_theater', 'night_club',
  'park', 'national_park', 'beach',
  // Live-entertainment / event spaces — these all tag with
  // `restaurant` in their secondary types when they have a kitchen
  // or bar, so without explicit exclusion a "Live Music Venue" or
  // banquet hall lands in our restaurant results. Caught with this
  // group instead of the broader attractions block above so it's
  // obvious which categories drove the addition.
  'live_music_venue', 'comedy_club', 'event_venue', 'banquet_hall',
  // Lodging (often has on-site restaurants, but it's a hotel listing)
  'lodging', 'hotel', 'motel', 'resort_hotel',
  'bed_and_breakfast', 'campground', 'hostel',
  // Health / personal services
  'gym', 'fitness_center', 'spa',
  // Education / institutional
  'school', 'university',
  // Medical
  'hospital', 'pharmacy', 'doctor',
  // Transit / automotive
  'gas_station', 'parking', 'car_repair',
  'airport', 'transit_station',
  // Retail (groceries/markets aren't dining destinations even if they sell food)
  'convenience_store', 'supermarket', 'grocery_store',
  'department_store', 'shopping_mall',
  // Services
  'bank', 'post_office',
  'police', 'fire_station',
];

// Local-only deny-list extension. These types are filtered in the
// server-side post-filter (see excludedPrimarySet in runNearbyFanOut)
// but NOT sent to Google — the API-side excludedPrimaryTypes list is
// hard-capped at 50 entries and EXCLUDED_PRIMARY_TYPES is already at
// 49. The post-filter set has no cap, so overflow entries live here.
// Beta feedback: BJ's Wholesale Club appeared in restaurant results —
// warehouse clubs sell food, so Google tags them with food types, but
// their primaryType is a wholesale/retail category we never excluded.
const EXCLUDED_PRIMARY_TYPES_LOCAL_ONLY = [
  'wholesaler', 'warehouse_store', 'liquor_store', 'market',
];

// ── Cuisine-type whitelist ───────────────────────────────────────────────
// Allowed values for the optional `cuisineType` query param on /nearby.
// Must stay in sync with CUISINE_OPTIONS in src/utils/cuisineTypes.js
// (frontend dropdown). Server-side validation prevents arbitrary type
// strings from being injected into the upstream `includedTypes` array
// — anything not in this set is silently dropped and we fall back to
// the default fan-out.
const ALLOWED_CUISINE_TYPES = new Set([
  'american_restaurant', 'bakery', 'bar', 'bar_and_grill', 'barbecue_restaurant',
  'breakfast_restaurant', 'brunch_restaurant', 'buffet_restaurant',
  'cafe', 'caribbean_restaurant', 'chinese_restaurant', 'coffee_shop', 'deli',
  'dessert_restaurant', 'diner', 'fast_food_restaurant', 'fine_dining_restaurant',
  'french_restaurant', 'greek_restaurant', 'hamburger_restaurant',
  'hawaiian_restaurant', 'ice_cream_shop', 'indian_restaurant', 'indonesian_restaurant',
  'italian_restaurant', 'japanese_restaurant', 'korean_restaurant',
  'lebanese_restaurant', 'mediterranean_restaurant', 'mexican_restaurant',
  'middle_eastern_restaurant', 'pizza_restaurant', 'pub', 'ramen_restaurant',
  'sandwich_shop', 'seafood_restaurant', 'spanish_restaurant', 'steak_house',
  'sushi_restaurant', 'thai_restaurant', 'turkish_restaurant',
  'vegan_restaurant', 'vegetarian_restaurant', 'vietnamese_restaurant',
  'wine_bar',
]);

// ── Type slices for the parallel nearby fan-out ──────────────────────────
// Google's `searchNearby` is hard-capped at 20 results per call AND
// doesn't support pagination. The only way to get more results without
// resorting to multi-region geometry tricks is to issue multiple calls
// with DISJOINT type sets and merge the responses. With two slices we
// land up to ~40 unique places per search (typical: 25-35 after the
// dedupe + deny-list filtering).
//
// Slices grouped by intent so the cost stays proportional to user
// value: A is the broadest "restaurant" tag, B is everything else
// food-related that Google often tags WITHOUT a top-level `restaurant`
// type (cafés, bakeries, desserts, bars, quick-service). Cuisine-
// specific types (sushi_restaurant, pizza_restaurant, etc.) implicitly
// belong to `restaurant` already, so listing them separately doesn't
// add new results — they'd just double up our spend.
//
// Each slice is its own Pro-tier API call, so 2 slices = 2× the
// search-tier cost (~$0.065/search instead of $0.10 for the older
// 3-slice version). Going down to 1 slice ('restaurant' only) loses
// the long-tail bar / café / dessert hits that don't carry the
// restaurant type; staying at 2 is the current cost-vs-coverage knee.
const NEARBY_TYPE_SETS: string[][] = [
  // A — the main "restaurant" anchor type
  ['restaurant'],
  // B — everything else food-related: cafés, bakeries, desserts, bars,
  // and quick-service places. Combined from two former slices into one
  // call to cut search-tier cost. Tradeoff: shares one 20-result cap
  // across all these groups, so in dense urban areas with a wide
  // radius the long-tail bar / dessert items can get crowded out by
  // closer cafés. Reasonable on cost; if users complain about missing
  // bars or quick-service results, split this back into two slices.
  [
    'cafe', 'coffee_shop', 'tea_house', 'bakery', 'dessert_shop',
    'ice_cream_shop', 'juice_shop', 'donut_shop',
    'bar', 'bar_and_grill', 'pub', 'wine_bar',
    'meal_takeaway', 'meal_delivery', 'food_court',
    'fast_food_restaurant', 'sandwich_shop', 'deli', 'diner',
  ],
];

// ── Error type for fan-out failures ──────────────────────────────────────
// Thrown by runNearbyFanOut when every slice errors. The handler maps
// it to a structured 502 response. Other failures (typed JSON parse,
// transform crashes) propagate as plain Errors and turn into a 500
// via express-async-errors.
class NearbyFanOutError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'NearbyFanOutError';
    this.status = status;
  }
}

// ── runNearbyFanOut: shared fan-out + transform + cache write ────────────
// Extracted from the inline /nearby logic so it can be used by both:
//   1. The cache-miss path (await + send response)
//   2. The SWR background refresh kicked off by stale reads (fire-and-forget)
//   3. In-flight coalescing — concurrent requests for the same cache key
//      share the same promise instead of each issuing duplicate Google calls
//
// On success: writes the result to the nearby cache (which stamps the
// SWR freshUntil boundary) and returns the entry. On total failure
// (all slices error): throws NearbyFanOutError with a human-readable
// message. Partial failures (some slices error) are tolerated — we
// surface whatever the successful slices returned.
async function runNearbyFanOut(opts: {
  apiKey: string;
  lat: number;
  lng: number;
  radius: number;
  cuisineType: string | null;
  formattedAddress: string;
  req: Request;
  cacheKey: string;
}): Promise<NearbyEntry> {
  const { apiKey, lat, lng, radius, cuisineType, formattedAddress, req, cacheKey: key } = opts;

  // Fan-out across type slices. Google caps each searchNearby at 20
  // results with no pagination, so the only way to get more is N
  // parallel calls with disjoint includedTypes (see NEARBY_TYPE_SETS).
  // For cuisine-specific searches, the second call broadens to
  // `restaurant` and is post-filtered to the requested cuisine in the
  // dedupe step — this catches additional cuisine matches Google
  // didn't rank in the top 20 of the direct call.
  // Promise.allSettled instead of Promise.all so a single failing
  // slice doesn't sink the whole search.
  //
  // NEARBY_SLICES (env, default 2) is a cost throttle: set to 1 on the
  // deployment to halve per-search Google spend at the cost of losing
  // the slice-B long tail (cafés / bakeries / dessert / bars — places
  // not tagged `restaurant`). A config-only lever so spend pressure
  // can be relieved without a code change.
  const sliceCap = process.env.NEARBY_SLICES === '1' ? 1 : 2;
  const typeSets: string[][] = (cuisineType
    ? [[cuisineType], ['restaurant']]
    : NEARBY_TYPE_SETS
  ).slice(0, sliceCap);
  const nearbyResponses = await Promise.allSettled(
    typeSets.map((includedTypes) =>
      fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify({
          includedTypes,
          excludedPrimaryTypes: EXCLUDED_PRIMARY_TYPES,
          maxResultCount: 20,
          // DISTANCE, not the default POPULARITY. With a wide radius,
          // popularity ranking returns the 20 most popular places
          // anywhere in the circle — users see a handful of local hits
          // plus famous spots miles away, while ordinary restaurants
          // two blocks over never make the cut (beta feedback caught
          // exactly this). Distance ranking returns the 20 CLOSEST
          // matches per slice, which is what "search near me" means.
          rankPreference: 'DISTANCE',
          locationRestriction: {
            circle: {
              center: { latitude: lat, longitude: lng },
              radius,
            },
          },
        }),
      }).then(async (r) => ({ ok: r.ok, data: await r.json() as any })),
    ),
  );

  // Collect successful payloads; log + skip rejected slices. Each
  // slice is independently recorded in api_usage so a 2-slice success
  // + 1-slice failure shows up as 2 successful + 1 errored.
  const slicePayloads: Array<{ places: any[] }> = [];
  for (let i = 0; i < nearbyResponses.length; i++) {
    const res_i = nearbyResponses[i];
    if (res_i.status === 'rejected') {
      console.warn(`[places] Nearby slice ${i} fetch failed:`, res_i.reason);
      trackGoogleCall(req, 'nearby', { status: 'error' });
      continue;
    }
    const { ok, data } = res_i.value;
    if (!ok || data.error) {
      console.warn(`[places] Nearby slice ${i} returned error:`, JSON.stringify(data.error ?? ok));
      trackGoogleCall(req, 'nearby', { status: 'error' });
      continue;
    }
    trackGoogleCall(req, 'nearby');
    slicePayloads.push({ places: Array.isArray(data.places) ? data.places : [] });
  }

  // All slices errored — typically an auth/permission issue. Throw a
  // structured error the handler maps to a 502.
  if (slicePayloads.length === 0) {
    const firstError = nearbyResponses
      .map((r) => r.status === 'fulfilled' ? r.value.data?.error : null)
      .find(Boolean);
    const errStatus: string = firstError?.status ?? '5xx';
    const msg = (errStatus === 'PERMISSION_DENIED' || errStatus === 'REQUEST_DENIED')
      ? 'Places API (New) denied the request — ensure "Places API (New)" is enabled in Google Cloud Console and your API key is not restricted from it.'
      : `Places API error: ${firstError?.message ?? errStatus}`;
    throw new NearbyFanOutError(msg, 502);
  }

  // Dedupe across slices by googlePlaceId. A place tagged BOTH
  // `restaurant` AND `cafe` would otherwise appear twice — first slice
  // wins (later wins would have identical content anyway).
  //
  // For cuisine-specific searches, slice index 1 is the broadening
  // `restaurant` call. Post-filter those results to only keep places
  // whose primaryType or types[] actually matches the requested
  // cuisine — otherwise we'd contaminate cuisine-filtered output with
  // non-matching restaurants from the broader call.
  const byId = new Map<string, any>();
  for (let i = 0; i < slicePayloads.length; i++) {
    const slice = slicePayloads[i];
    const isCuisineBroaden = cuisineType !== null && i === 1;
    for (const p of slice.places) {
      if (typeof p?.id !== 'string') continue;
      if (byId.has(p.id)) continue;
      if (isCuisineBroaden) {
        const types = Array.isArray(p.types) ? p.types : [];
        if (p.primaryType !== cuisineType && !types.includes(cuisineType)) continue;
      }
      byId.set(p.id, p);
    }
  }
  const mergedPlaces = Array.from(byId.values());

  // Defense-in-depth filter: `excludedPrimaryTypes` is a hint to
  // Google, not a guarantee. Re-check primaryType on response and
  // drop any straggler. Includes the local-only overflow entries that
  // don't fit in Google's 50-entry API-side cap.
  const excludedPrimarySet = new Set([...EXCLUDED_PRIMARY_TYPES, ...EXCLUDED_PRIMARY_TYPES_LOCAL_ONLY]);

  const restaurants = mergedPlaces
    .filter((p: any) => p.businessStatus !== 'CLOSED_PERMANENTLY')
    .filter((p: any) => !(typeof p?.primaryType === 'string' && excludedPrimarySet.has(p.primaryType)))
    .map((p: any) => {
      const pLat: number | undefined = p.location?.latitude;
      const pLng: number | undefined = p.location?.longitude;
      return {
        googlePlaceId: p.id as string,
        name: (p.displayName?.text ?? '') as string,
        googleRating: (p.rating as number | undefined) ?? null,
        ratingCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
        priceLevel: PRICE_LEVEL_MAP[p.priceLevel] ?? null,
        address: (p.formattedAddress as string | undefined) ?? null,
        cuisineType: (p.primaryTypeDisplayName?.text as string | undefined) ?? null,
        // Machine-readable type slug — powers the client-side fast-food
        // toggle. See text-search projection for rationale.
        primaryType: (p.primaryType as string | undefined) ?? null,
        // Always null now — currentOpeningHours was dropped from the
        // field mask. The frontend computes its own openNow fresh
        // against the user's clock from regularOpeningHours periods,
        // so the cached snapshot was redundant and just bulked up the
        // response payload.
        openNow: null,
        distanceKm: (pLat != null && pLng != null) ? haversineKm(lat, lng, pLat, pLng) : null,
        lat: pLat ?? null,
        lng: pLng ?? null,
        photos: extractPhotos(p),
        regularOpeningHours: extractRegularOpeningHours(p),
        phone:   (p.internationalPhoneNumber as string | undefined) ?? null,
        website: (p.websiteUri as string | undefined) ?? null,
        // takeout / delivery / servesVegetarianFood intentionally absent
        // — dropped from the mask to escape the Enterprise+Atmosphere
        // SKU. See TEXT_FIELD_MASK warning comment.
      };
    })
    .sort((a: any, b: any) => {
      if (a.distanceKm == null && b.distanceKm == null) return 0;
      if (a.distanceKm == null) return 1;
      if (b.distanceKm == null) return -1;
      return a.distanceKm - b.distanceKm;
    });

  const entry: NearbyEntry = {
    restaurants,
    rawPlaces: mergedPlaces,
    resolvedAddress: formattedAddress,
    resolvedLat: lat,
    resolvedLng: lng,
  };
  await nearbySet(key, entry);
  return entry;
}

// GET /api/places/nearby?address=<>&radiusMeters=<>&cuisineType=<>&dietary=<csv>
router.get('/nearby', async (req: Request, res: Response) => {
  const address = (req.query.address as string | undefined)?.trim();
  const radiusRaw = Number(req.query.radiusMeters);
  // Optional cuisine pre-filter. Anything not in the whitelist is
  // dropped silently and we fall back to the default fan-out — a
  // typo or stale slug shouldn't 400 the search, just relax the
  // filter and return broader results.
  const cuisineTypeRaw = (req.query.cuisineType as string | undefined)?.trim();
  const cuisineType = cuisineTypeRaw && ALLOWED_CUISINE_TYPES.has(cuisineTypeRaw)
    ? cuisineTypeRaw
    : null;

  // Dietary filter (Phase E). Comma-separated list of dietary tags.
  // We honor the ones we can hard-filter on (vegetarian / vegan) and
  // surface the rest as `informationalDietary` in the response so the
  // client can render a "we don't filter for X" note. The post-filter
  // runs against the cached unfiltered result set so a vegetarian
  // search and a non-vegetarian search at the same coords share the
  // upstream Google call.
  const dietary = parseDietaryParam(req.query.dietary);
  const informationalDietary = infoOnlyTags(dietary);
  const activeDietary        = filterableSubset(dietary);

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

  // ── 1. Geocode address → lat/lng ──────────────────────────────
  // Check the geocoding cache first. Address-to-lat/lng mappings barely
  // change, so a 30-minute cache absorbs the usual "iterate on radius"
  // pattern without re-hitting the (separately-billed) Geocoding API.
  let lat: number;
  let lng: number;
  let formattedAddress: string;
  const cachedGeocode = await geocodeGet(address);
  if (cachedGeocode) {
    trackGoogleCall(req, 'geocode', { cacheHit: true });
    ({ lat, lng, formattedAddress } = cachedGeocode);
  } else {
    const geocodeUrl =
      `https://maps.googleapis.com/maps/api/geocode/json` +
      `?address=${encodeURIComponent(address)}&key=${apiKey}`;

    const geocodeData = await fetch(geocodeUrl).then((r) => r.json()) as any;

    if (geocodeData.status !== 'OK' || !geocodeData.results?.[0]) {
      const msg = geocodeData.status === 'REQUEST_DENIED'
        ? 'Geocoding API denied the request — ensure the Geocoding API is enabled in Google Cloud Console.'
        : 'Could not find that location — try a different address or zip code.';
      console.error('[places] Geocode failed:', geocodeData.status, geocodeData.error_message ?? '');
      trackGoogleCall(req, 'geocode', { status: 'error' });
      res.status(400).json({ error: msg });
      return;
    }

    const geoLoc = geocodeData.results[0].geometry?.location;
    if (!geoLoc) {
      trackGoogleCall(req, 'geocode', { status: 'error' });
      res.status(400).json({ error: 'Could not find that location — try a different address or zip code.' });
      return;
    }
    lat = geoLoc.lat;
    lng = geoLoc.lng;
    formattedAddress = geocodeData.results[0].formatted_address ?? '';
    // Fire-and-forget cache write — failures are non-fatal.
    geocodeSet(address, { lat, lng, formattedAddress }).catch(() => {});
    trackGoogleCall(req, 'geocode');
  }

  // ── 2. Check cache (with stale-while-revalidate) ─────────────
  // Read serves stale entries immediately and triggers a background
  // refresh, instead of forcing the unlucky first user past the
  // fresh-window boundary to wait for a full fan-out. Background
  // refreshes are coalesced via `inFlightNearby` — concurrent stale
  // reads see the in-flight promise and skip starting their own.
  //
  // Note: rawPlaces is kept in the cache (debugging) but not sent to
  // the client — shipping the full Google Places response would
  // bloat the payload by ~200-400 KB per search.
  const key = cacheKey(lat, lng, radius, cuisineType);
  const cached = await nearbyGet(key);
  if (cached) {
    trackGoogleCall(req, 'nearby', { cacheHit: true });
    const isStale = !cached.freshUntilMs || Date.now() > cached.freshUntilMs;
    if (isStale && !inFlightNearby.has(key)) {
      // Fire-and-forget background refresh. The current request still
      // serves the stale entry below — only future reads benefit from
      // the refresh. The .finally clears the in-flight slot whether
      // the refresh succeeds or fails.
      const refresh = runNearbyFanOut({
        apiKey, lat, lng, radius, cuisineType, formattedAddress, req, cacheKey: key,
      })
        .finally(() => inFlightNearby.delete(key));
      inFlightNearby.set(key, refresh);
      // Attach a logging-only error handler. Two reasons:
      //   1. The current request has already returned the stale data,
      //      so a refresh failure isn't user-visible — but we still
      //      want to know about it in logs.
      //   2. Without this handler, the rejected promise would surface
      //      as an unhandledRejection (no one awaits it unless a
      //      concurrent cache-miss reader joins via the map). On
      //      Node 15+ that defaults to crashing the process.
      // Cache-miss readers that DO await this promise via inFlightNearby
      // still see the rejection independently — attaching this handler
      // doesn't suppress others.
      refresh.catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: errMsg, key }, '[places] SWR background refresh failed');
      });
    }
    // `cached.restaurants` is typed `unknown[]` in NearbyEntry to keep
    // the cache module from re-declaring the place row shape; the cast
    // narrows it to the PlaceLike contract `applyDietaryFilter`
    // expects. Safe because the projection at line ~1088 now emits
    // servesVegetarianFood, and older cached rows (pre-Phase-E) read
    // as `undefined` which the filter treats as "fails the filter"
    // when one is active — the conservative no-leak behavior.
    const cachedRestaurants = cached.restaurants as Array<{ servesVegetarianFood?: boolean | null }>;
    res.json({
      restaurants: applyDietaryFilter(cachedRestaurants, activeDietary),
      configured: true,
      resolvedAddress: cached.resolvedAddress,
      resolvedLat: cached.resolvedLat,
      resolvedLng: cached.resolvedLng,
      informationalDietary,
      activeDietary,
    });
    return;
  }

  // ── 3. Cache miss — coalesce or start a new fan-out ──────────
  // If another request is already running the fan-out for this key
  // (started a few ms before us), await its promise instead of
  // issuing a parallel duplicate. Counts as a cacheHit in
  // api_usage since we saved a fan-out's worth of upstream calls.
  let inflight = inFlightNearby.get(key);
  if (inflight) {
    trackGoogleCall(req, 'nearby', { cacheHit: true });
  } else {
    inflight = runNearbyFanOut({
      apiKey, lat, lng, radius, cuisineType, formattedAddress, req, cacheKey: key,
    })
      .finally(() => inFlightNearby.delete(key));
    inFlightNearby.set(key, inflight);
  }

  try {
    const result = await inflight;
    const restaurants = result.restaurants as Array<{ servesVegetarianFood?: boolean | null }>;
    res.json({
      restaurants: applyDietaryFilter(restaurants, activeDietary),
      configured: true,
      resolvedAddress: result.resolvedAddress,
      resolvedLat: result.resolvedLat,
      resolvedLng: result.resolvedLng,
      informationalDietary,
      activeDietary,
    });
  } catch (err: unknown) {
    const status = err instanceof NearbyFanOutError ? err.status : 502;
    const message = err instanceof Error ? err.message : 'Nearby search failed';
    res.status(status).json({ error: message });
  }
});

// Test-only escape hatch — clears every in-memory cache + in-flight
// map so a test that populates one (e.g. via a cache-hit scenario)
// doesn't leak state into the next test. Production code never calls
// this; the maps just naturally age out via TTL.
export function _resetInMemCachesForTests(): void {
  inMemNearby.clear();
  inMemText.clear();
  inMemGeocode.clear();
  inMemPhotoUrl.clear();
  inMemMirrorFlags.clear();
  inFlightMirrors.clear();
  inFlightNearby.clear();
}

// Test-only escape hatch — pre-populates the nearby cache with a
// custom freshUntilMs and expiresAt so tests can exercise SWR
// stale-then-refresh behavior without waiting NEARBY_FRESH_S
// (15 min) for entries to age out naturally.
export function _setNearbyCacheEntryForTests(
  key: string,
  entry: NearbyEntry,
  expiresAtMs: number,
): void {
  inMemNearby.set(key, { ...entry, expiresAt: expiresAtMs });
}

export default router;
