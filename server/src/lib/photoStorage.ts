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
