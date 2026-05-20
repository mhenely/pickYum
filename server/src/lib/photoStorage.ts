// Restaurant photo persistence to Supabase Storage.
//
// Why this exists: Google Places API doesn't give us a permanent URL for
// photos — it gives us a `name` reference that we have to redeem via the
// /media endpoint for a short-lived signed CDN URL. Two problems with that:
//   1. Every cold photo view costs a Google API call (~$0.007 each)
//   2. The refs empirically rotate over time (despite docs claiming
//      otherwise), invalidating saved data and breaking cards weeks/months
//      after materialization
//
// Solution: at materialize time, download the photo bytes from Google ONCE
// and upload them to our own Supabase Storage bucket. The DB stores the
// public Supabase URL directly. After that, photo rendering is purely a
// CDN fetch — no Google calls, no rate limits, no ref-rotation surprises.
//
// Storage path layout: `<restaurantId>/<photoIndex>.jpg`. Two reasons:
//   - Tied to our DB id, not Google's place id (cleaner public URL).
//   - Deterministic — re-materializing a row writes to the same paths
//     (upsert), so a stale ref can be repaired by simply calling
//     downloadAndStoreAll again.

import crypto from 'crypto';
import { StorageClient } from '@supabase/storage-js';
import { logger } from './logger';

// Lazily-instantiated singleton. We don't construct the client at module
// load because:
//   1. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY may not be set in test
//      environments — instantiating with missing creds throws.
//   2. Tests can swap this out via jest.mock without dealing with module-
//      load side effects.
let _storage: StorageClient | null | undefined;

export function getStorageClient(): StorageClient | null {
  if (_storage !== undefined) return _storage;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    logger.warn(
      'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — photo storage disabled',
    );
    _storage = null;
    return null;
  }
  _storage = new StorageClient(`${url}/storage/v1`, {
    apikey: key,
    Authorization: `Bearer ${key}`,
  });
  return _storage;
}

// Test-only escape hatch — lets jest mocks reset the singleton between
// tests so env changes are picked up.
export function _resetStorageClientForTests(): void {
  _storage = undefined;
}

const BUCKET = () => process.env.SUPABASE_STORAGE_BUCKET?.trim() || 'restaurant-photos';

// Single photo: pull the bytes from Google's signed CDN, upload to
// Supabase Storage at a deterministic path, return the public URL.
//
// Failure modes are non-fatal — we return null and the caller skips this
// photo. The restaurant still materializes; the card just shows N-1 photos.
export async function downloadAndStorePhoto(args: {
  googleName: string;          // e.g. "places/X/photos/Y"
  restaurantId: number;
  photoIndex: number;
  maxWidthPx?: number;
  apiKey: string;
}): Promise<string | null> {
  const { googleName, restaurantId, photoIndex, apiKey } = args;
  // 1200px wide is the modal hero size; cards use the same source and
  // let the browser downscale via CSS. Single stored variant keeps the
  // download cost flat — one Google call per photo, ever.
  const maxWidthPx = args.maxWidthPx ?? 1200;

  const storage = getStorageClient();
  if (!storage) return null;

  // Step 1: ask Google for the signed CDN URL. `redirect: 'manual'` gives
  // us the 302 + Location header instead of auto-following — we need the
  // CDN URL itself to fetch bytes from.
  const upstreamUrl = `https://places.googleapis.com/v1/${googleName}/media?maxWidthPx=${maxWidthPx}&key=${encodeURIComponent(apiKey)}`;
  let cdnUrl: string;
  try {
    const r = await fetch(upstreamUrl, { redirect: 'manual' });
    if (r.status < 300 || r.status >= 400) {
      // Includes the 400 INVALID_ARGUMENT response Google sends for refs
      // it considers stale. Read enough of the body to surface a useful
      // message in logs but cap to avoid huge JSON blobs.
      const body = await r.text().catch(() => '');
      logger.warn(
        { upstreamStatus: r.status, body: body.slice(0, 200), googleName },
        'photo storage: Google /media did not redirect',
      );
      return null;
    }
    const loc = r.headers.get('location');
    if (!loc) {
      logger.warn({ googleName }, 'photo storage: Google /media missing Location header');
      return null;
    }
    cdnUrl = loc;
  } catch (err) {
    logger.warn({ err, googleName }, 'photo storage: Google /media fetch threw');
    return null;
  }

  // Step 2: pull the actual image bytes from the CDN URL Google handed us.
  let bytes: ArrayBuffer;
  let contentType: string;
  try {
    const r = await fetch(cdnUrl);
    if (!r.ok) {
      logger.warn({ status: r.status, googleName }, 'photo storage: CDN fetch failed');
      return null;
    }
    contentType = r.headers.get('content-type') || 'image/jpeg';
    bytes = await r.arrayBuffer();
  } catch (err) {
    logger.warn({ err, googleName }, 'photo storage: CDN fetch threw');
    return null;
  }

  // Step 3: upload to Supabase. Path is deterministic so re-materializing
  // a row (e.g. via the existing-row backfill branch in POST /api/restaurants
  // when refs go stale) overwrites the old bytes via `upsert: true`. The
  // service-role key gives us write access without needing per-bucket RLS
  // policies — the bucket is public-read, server-write.
  const path = `${restaurantId}/${photoIndex}.jpg`;
  try {
    const { error } = await storage.from(BUCKET()).upload(path, bytes, {
      contentType,
      upsert: true,
      // cacheControl maps to the `Cache-Control` response header Supabase
      // sets on the public CDN URL. 1 year is safe — our paths are
      // deterministic per (restaurantId, photoIndex), so an "update" is
      // really a re-upload to the same URL, which CDNs invalidate at the
      // origin's discretion. If we ever need to force-bust we can append
      // a content hash to the path.
      cacheControl: '31536000',
    });
    if (error) {
      logger.warn({ err: error, path }, 'photo storage: Supabase upload failed');
      return null;
    }
  } catch (err) {
    logger.warn({ err, path }, 'photo storage: Supabase upload threw');
    return null;
  }

  // Step 4: return the public URL. Public buckets serve at a stable URL
  // pattern; we construct it instead of calling getPublicUrl to keep this
  // resilient to SDK shape changes.
  const url = process.env.SUPABASE_URL?.trim();
  return `${url}/storage/v1/object/public/${BUCKET()}/${path}`;
}

// Batch helper. Downloads all photos for a single restaurant in parallel
// — caps at 5 concurrent uploads (Google's rate limits are generous but a
// burst of 10+ is unfriendly to upstream + our own egress).
//
// Returns the array of stored-photo objects in the same shape as the DB
// expects. Photos that failed to upload are silently dropped.
export interface StoredPhoto {
  name: string;             // Supabase public URL
  widthPx: number | null;
  heightPx: number | null;
}

// ── Proxy-level mirror for unmaterialized search-result photos ──────────
//
// The downloadAndStorePhoto / downloadAndStoreAll pair handles photos
// for restaurants the user has actually saved (favorites, selections,
// etc.) — those rows get materialized via POST /api/restaurants and
// their photos persist permanently in Supabase with predictable
// {restaurantId}/{n}.jpg paths.
//
// But a user browsing nearby-search results sees photos for restaurants
// they never save. Those photos still go through /api/places/photo,
// which proxies to Google's /media endpoint (billed). Without
// mirroring, every cold view of an unsaved restaurant photo = one
// Google call.
//
// This helper mirrors those photos too, keyed by a deterministic hash
// of (googleName, maxWidthPx) under `proxy-cache/`. Storage cost is
// small (~100 KB/photo, ~$0.021/GB/mo). Once a photo is mirrored,
// subsequent views hit Supabase directly via /api/places/photo's
// tier-1 cache check.
//
// Idempotent — same input always produces the same path, so a re-mirror
// (e.g. from a different instance) overwrites the same bytes.
function proxyCachePath(googleName: string, maxWidthPx: number): string {
  const hash = crypto.createHash('md5').update(`${googleName}::${maxWidthPx}`).digest('hex');
  return `proxy-cache/${hash}.jpg`;
}

// Returns the public Supabase URL a mirrored photo WOULD live at.
// Pure computation — does not check existence. Caller decides whether
// to use the URL based on a separate "is this mirrored" flag (kept in
// Redis with a long TTL so we don't HEAD Supabase on every photo
// request).
export function proxyMirroredPublicUrl(googleName: string, maxWidthPx: number): string | null {
  const url = process.env.SUPABASE_URL?.trim();
  if (!url) return null;
  return `${url}/storage/v1/object/public/${BUCKET()}/${proxyCachePath(googleName, maxWidthPx)}`;
}

// Mirror a Google photo to Supabase using the bytes Google's CDN
// serves at `cdnUrl` (the redirect target Google returns from the
// billed /media endpoint). Caller passes in the URL they already
// extracted — re-fetching /media to get the URL again would cost a
// second billed call.
//
// CDN fetches themselves are free — Google's CDN serves bytes with no
// API-key check once the signed URL is in hand. So the net cost of
// mirroring is: 0 extra Google calls + 1 Supabase upload (~$negligible).
//
// Returns the public Supabase URL on success, or null on failure
// (e.g. signed URL expired, Supabase down). Caller is fire-and-forget
// — a failed mirror just means the next view pays Google again.
// Allow-list of hostnames the CDN URL is permitted to live under.
// Defense-in-depth — Google's Places API hands us this URL via the
// Location header on /v1/{name}/media, so under normal operation it
// always points to one of these. Validating before fetch closes a
// theoretical SSRF where a compromised upstream could redirect us
// to an internal-network address (e.g. cloud-metadata services).
const ALLOWED_PHOTO_HOSTS = [
  'googleusercontent.com',
  'ggpht.com',
  'gstatic.com',
];

function isAllowedPhotoHost(cdnUrl: string): boolean {
  try {
    const parsed = new URL(cdnUrl);
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_PHOTO_HOSTS.some((h) =>
      parsed.hostname === h || parsed.hostname.endsWith('.' + h),
    );
  } catch {
    return false;
  }
}

export async function mirrorPhotoFromCdnUrl(args: {
  googleName: string;
  maxWidthPx: number;
  cdnUrl: string;
}): Promise<string | null> {
  const { googleName, maxWidthPx, cdnUrl } = args;
  const storage = getStorageClient();
  if (!storage) return null;

  if (!isAllowedPhotoHost(cdnUrl)) {
    logger.warn({ googleName }, 'photo mirror: CDN URL host not in allow-list — skipping');
    return null;
  }

  let bytes: ArrayBuffer;
  let contentType: string;
  try {
    const r = await fetch(cdnUrl);
    if (!r.ok) {
      logger.warn({ status: r.status, googleName }, 'photo mirror: CDN fetch failed');
      return null;
    }
    contentType = r.headers.get('content-type') || 'image/jpeg';
    // Defensive content-type check — Supabase serves whatever
    // content-type we upload with. If Google's CDN ever returned a
    // non-image (compromised upstream, or weird edge case), uploading
    // as text/html would let an attacker phish via the Supabase URL.
    // Reject anything not starting with image/.
    if (!contentType.startsWith('image/')) {
      logger.warn({ contentType, googleName }, 'photo mirror: non-image content-type — skipping');
      return null;
    }
    bytes = await r.arrayBuffer();
  } catch (err) {
    logger.warn({ err, googleName }, 'photo mirror: CDN fetch threw');
    return null;
  }

  const path = proxyCachePath(googleName, maxWidthPx);
  try {
    const { error } = await storage.from(BUCKET()).upload(path, bytes, {
      contentType,
      upsert: true,
      // 1-year CDN cache — paths are deterministic per
      // (googleName, maxWidthPx), and even when Google rotates the
      // photo name the new name maps to a different path, so we'll
      // never serve old bytes under a new ref.
      cacheControl: '31536000',
    });
    if (error) {
      logger.warn({ err: error, path }, 'photo mirror: Supabase upload failed');
      return null;
    }
  } catch (err) {
    logger.warn({ err, path }, 'photo mirror: Supabase upload threw');
    return null;
  }

  return proxyMirroredPublicUrl(googleName, maxWidthPx);
}

export async function downloadAndStoreAll(args: {
  restaurantId: number;
  googlePhotos: Array<{ name: string; widthPx: number | null; heightPx: number | null }>;
  apiKey: string;
  maxPhotos?: number;
}): Promise<StoredPhoto[]> {
  const { restaurantId, googlePhotos, apiKey } = args;
  // Cap at the configured limit. Google's nearby search returns up to
  // 10; storing 5 is the existing app convention (see MAX_PHOTOS_PER_RESTAURANT).
  const max = args.maxPhotos ?? 5;
  const slice = googlePhotos.slice(0, max);
  if (slice.length === 0) return [];

  const results = await Promise.all(slice.map(async (photo, idx) => {
    const url = await downloadAndStorePhoto({
      googleName: photo.name,
      restaurantId,
      photoIndex: idx,
      apiKey,
    });
    if (!url) return null;
    return { name: url, widthPx: photo.widthPx, heightPx: photo.heightPx };
  }));

  return results.filter((p): p is StoredPhoto => p !== null);
}
