// Generic Redis-backed read cache for heavy GET endpoints.
//
// Replaces the per-request "always recompute" pattern on endpoints
// where the response is expensive (multiple parallel Prisma queries +
// JS aggregation) but a few seconds of staleness is fine. Insights
// rollups, group/trip list payloads, and similar surfaces all fit
// this profile — users don't notice 30-60s of cache lag on data
// they aren't actively mutating right now.
//
// Design notes:
//   - Bypassed transparently when Redis isn't configured. The cache
//     is purely a perf optimization; correctness must not depend on
//     it. Callers always get the live computed value.
//   - JSON-serialized values. Numbers, strings, arrays, plain
//     objects all round-trip cleanly. Date instances become ISO
//     strings, which is fine for our callers (the frontend re-parses).
//   - TTL-only invalidation by default — no explicit "clear after
//     write" hooks. Justification: the endpoints we cache are
//     mostly read-only aggregates (insights), or have client-side
//     optimistic updates handling the immediate "I just made a
//     change" case (groups/trips lists). Up to TTL_SECONDS of
//     staleness on a read-after-write at worst.
//   - Failures in cache reads or writes degrade to "no cache,"
//     never break the wrapped compute function. The user always gets
//     a real response.
//
// To add a new cached endpoint:
//   1. Pick a stable cache key including any query params that
//      partition the response (per-user is the most common —
//      use `cacheKeyForUser('foo', userId)` for the standard shape)
//   2. Wrap the endpoint body in `cacheRead(key, ttl, async () => {...})`
//   3. Add a brief comment noting the TTL and staleness tolerance

import redis from './redis';
import { logger } from './logger';

const KEY_PREFIX = 'cache:';

// Standard "this is per-user" key shape. Use this rather than
// hand-rolled string concatenation so all per-user keys share one
// prefix discipline (which would be needed if we ever add a
// "clear-all-cache-for-user" operation).
export function cacheKeyForUser(name: string, userId: number, suffix?: string): string {
  const base = `${name}:${userId}`;
  return suffix ? `${base}:${suffix}` : base;
}

/**
 * Atomic read-or-compute. Returns the cached value if Redis is
 * configured AND has a fresh entry for `key`; otherwise calls
 * `compute()`, caches the result, and returns it.
 *
 * Failures in the cache layer (Redis offline, JSON parse error,
 * etc.) are logged at debug level and fall through to compute() —
 * cache misses must never break the request. compute() errors
 * propagate normally so callers can handle them.
 *
 * @param key   Cache key — must encode every parameter that
 *              partitions the response (user id, filter params).
 *              Will be auto-prefixed with `cache:` so callers don't
 *              have to remember the namespace convention.
 * @param ttlSeconds  How long the value stays cached. Pick based on
 *              acceptable staleness for the endpoint, not "how often
 *              it changes" — most data changes rarely, but UX-wise
 *              you want users to see their own writes quickly.
 * @param compute  Function that produces the value when no cache
 *              entry is present. Result is JSON.stringify'd, so it
 *              must be JSON-serializable.
 */
export async function cacheRead<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  const fullKey = `${KEY_PREFIX}${key}`;

  if (redis && redis.status === 'ready') {
    try {
      const raw = await redis.get(fullKey);
      if (raw) {
        return JSON.parse(raw) as T;
      }
    } catch (err) {
      // Cache read failed — don't break the request. Treat as a miss.
      logger.debug({ err, key }, 'serverCache: read failed, falling through to compute');
    }
  }

  const fresh = await compute();

  if (redis && redis.status === 'ready') {
    try {
      // setex = SET key value EX seconds — atomic create-with-TTL,
      // so we never end up with a key that has no expiry (the way
      // a separate SET + EXPIRE pair could race).
      await redis.setex(fullKey, ttlSeconds, JSON.stringify(fresh));
    } catch (err) {
      // Cache write failed — the request already has its value, so
      // the user is fine. Log and move on.
      logger.debug({ err, key }, 'serverCache: write failed, value not cached');
    }
  }

  return fresh;
}

/**
 * Clear one specific cache entry. Use for the rare "this write
 * really must reflect on next read" case — most callers can rely on
 * TTL expiry alone.
 */
export async function cacheClear(key: string): Promise<void> {
  if (!redis || redis.status !== 'ready') return;
  try {
    await redis.del(`${KEY_PREFIX}${key}`);
  } catch (err) {
    logger.debug({ err, key }, 'serverCache: clear failed');
  }
}

/**
 * Clear every cache entry under a prefix. Uses SCAN (not KEYS) so it
 * doesn't block Redis during traversal — safe at any cache size.
 * Useful for "clear all per-user entries for this user" without
 * tracking every individual key the user touches.
 */
export async function cacheClearPrefix(prefix: string): Promise<void> {
  if (!redis || redis.status !== 'ready') return;
  const match = `${KEY_PREFIX}${prefix}*`;
  try {
    // SCAN iterates the keyspace in chunks without blocking. Cursor
    // starts at '0' and finishes when it returns '0' again.
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.debug({ err, prefix }, 'serverCache: clearPrefix failed');
  }
}
