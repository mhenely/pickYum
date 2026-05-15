// Centralized helpers for the dual-id namespace used throughout the app.
//
// Background: this app supports a "guest mode" where unauthenticated users
// have collections (favorites, options, reviews) that live only in
// localStorage. Those entries get a `local-…` string id minted client-side
// so they don't collide with the integer DB ids the server hands out for
// authenticated users.
//
// The dichotomy used to be enforced by inline `Number.isInteger(Number(x))`
// checks scattered through listenerMiddleware (7 sites) plus an inline
// `local-${Date.now()}-${rand}` template inside a thunk. This helper module
// is the single place that knows the rules:
//
//   isDbId('42')        → true   (server-side row id, eligible for API calls)
//   isDbId(42)          → true
//   isDbId('local-abc') → false  (guest stub, must NOT be sent to the API)
//   isDbId('custom-7')  → false  (legacy custom-prefix from pre-server days)
//   isDbId(null)        → false
//   isDbId(undefined)   → false
//
// Future direction (TIER_2_3_PLAN.md #11 option A) is to eliminate the
// dichotomy entirely by giving guests real server-side anonymous-session
// rows. Until then, every call site that needs to decide "should this fire
// a network call?" goes through `isDbId`.

export type ResourceId = string | number | null | undefined;

/**
 * True iff the id is a positive integer (string-encoded or numeric) —
 * i.e. a real server-side row id. Returns false for null, undefined,
 * `local-…` stubs, `custom-…` legacy ids, non-numeric strings, NaN,
 * and zero/negative numbers.
 */
export function isDbId(id: ResourceId): boolean {
  if (id == null) return false;
  const n = Number(id);
  return Number.isInteger(n) && n > 0;
}

/**
 * True iff the id is a client-side guest stub. Inverse of `isDbId`
 * EXCEPT for the null/undefined cases — those return false in both
 * helpers, which is intentional (treat absent ids as "no id," not
 * "local id"). Callers should null-check first when that distinction
 * matters.
 */
export function isLocalId(id: ResourceId): boolean {
  if (id == null) return false;
  return typeof id === 'string' && id.startsWith('local-');
}

/**
 * Discriminated parse — useful when a downstream branch needs to know
 * specifically which kind it has rather than just "is it eligible for
 * an API call?". Returns the canonical stringy id alongside the kind
 * so consumers don't have to re-stringify.
 *
 *   parseResourceId('42')        → { kind: 'db',    value: '42' }
 *   parseResourceId('local-abc') → { kind: 'local', value: 'local-abc' }
 *   parseResourceId(null)        → { kind: 'unknown', value: '' }
 */
export function parseResourceId(id: ResourceId): { kind: 'db' | 'local' | 'unknown'; value: string } {
  if (id == null) return { kind: 'unknown', value: '' };
  const str = String(id);
  if (isDbId(id))    return { kind: 'db',    value: str };
  if (isLocalId(id)) return { kind: 'local', value: str };
  return { kind: 'unknown', value: str };
}

/**
 * Mint a fresh `local-…` id for a guest-mode entry. Used by
 * `persistAddReview` when the user is unauthenticated. Format:
 * `local-<base-36 timestamp>-<6 hex chars>`. The timestamp gives lexical
 * sort order; the random suffix breaks ties when two ids are minted in
 * the same millisecond (rare but possible during fast-fire actions).
 *
 * Length is bounded (max ~25 chars) so it fits comfortably in the
 * stringy id columns the slice keeps.
 */
export function mintLocalId(prefix = ''): string {
  const ts   = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `local-${prefix ? prefix + '-' : ''}${ts}-${rand}`;
}
