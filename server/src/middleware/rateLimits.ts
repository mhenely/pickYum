import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

// Skip rate limiting under test so supertest spam doesn't trip the limiter
// across the suite. Real traffic still limits normally.
const skipInTest = () => process.env.NODE_ENV === 'test';

// General write limiter for mutating endpoints. Liberal enough for normal use,
// tight enough to slow abuse. Applied as middleware that only counts non-GET.
export const writeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => skipInTest() || req.method === 'GET',
  message: { error: 'Too many write requests, please slow down' },
});

// Parse a positive-integer env var with a default fallback. Used for the
// external-API rate limit caps below so operators can tune them per env
// without a code change (dev: bump high; prod: stay conservative).
function envInt(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Stricter limiter for endpoints that hit external paid APIs (Google Places).
// Kept name `externalApiLimiter` for backward compat at call sites, but its
// scope is now narrowed to BULK refreshes only — `/me/refresh-places` which
// can sweep many rows in one request. Per-row JIT refreshes share a
// separate, more generous budget (see perRowRefreshLimiter below).
//
// Why split: the bulk endpoint is rarely needed and very expensive per call
// (refreshes up to 20 rows × ~$0.017 = ~$0.34 worst case). The per-row JIT
// endpoint is small and frequently needed (e.g. on page load when a user
// has many saved restaurants with stale photo refs that Google has rotated
// — see hooks/useRestaurantPhotoBackfill.ts). Sharing one bucket meant
// per-row refreshes drained the bulk allowance and vice versa; pages with
// many stale rows stayed broken until the operator-blind window reset.
//
// Override via env: BULK_REFRESH_LIMIT_MAX. Default 10 / 15 min.
export const externalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: envInt('BULK_REFRESH_LIMIT_MAX', 10),
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { error: 'External API budget reached, please try again later' },
});

// Per-row Google Places refresh limiter. Used by `/me/refresh-restaurant/:id`,
// which is fired by the photo-backfill hook on a single restaurant card when
// either (a) the card mounts with no photos or (b) the photo `<img>` fails
// to load (stale ref). The hook dedupes per-restaurant per-session, so a
// realistic upper bound is "number of saved restaurants × 1 refresh" — well
// above the old 10/15min shared cap when a user has 30+ favorites.
//
// 60 / 15 min default = up to 60 single-row refreshes per quarter-hour
// (~$1/hr worst case at Places Details Pro pricing). Override via env:
// PER_ROW_REFRESH_LIMIT_MAX. Dev environments can crank to 500+ when
// refilling many stale rows after a long absence.
export const perRowRefreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: envInt('PER_ROW_REFRESH_LIMIT_MAX', 60),
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { error: 'External API budget reached, please try again later' },
});

// Per-user limiter for avatar updates. Tighter than `writeLimiter` because
// each PATCH carries up to ~133KB of base64 (vs the 32KB everything else is
// capped at), and the data URL persists in the User row — so each upload
// permanently bloats the DB by ~100KB until replaced or cleared. 20 per
// hour leaves plenty of room for "trying a few pictures" without enabling
// storage-bloat abuse.
//
// Keyed by userId rather than IP. IP-keyed would let one user behind a
// shared NAT exhaust everyone else's quota; userId-keyed isolates the
// blast radius to the misbehaving account.
export const avatarUpdateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  // requireAuth populates req.userId before this middleware runs, so we
  // can always key on it. Fallback to IP for the should-never-happen case
  // where requireAuth hasn't run (defensive — wouldn't matter functionally
  // because requireAuth would 401 first).
  //
  // The IP fallback runs through express-rate-limit's `ipKeyGenerator`
  // helper, which normalizes IPv6 addresses to their /64 prefix.
  // Without it, an IPv6 user could trivially bypass the limiter by
  // varying the last 64 bits of their address; express-rate-limit v8
  // refuses to load a custom keyGenerator that uses req.ip directly.
  keyGenerator: (req) => {
    const userId = (req as unknown as { userId?: number }).userId;
    if (userId != null) return String(userId);
    return ipKeyGenerator(req.ip ?? 'unknown');
  },
  message: { error: 'Too many avatar updates, please try again later' },
});
