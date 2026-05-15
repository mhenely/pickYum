// Selectors and helpers for the multi-list favorites surface.
//
// Slice shape (see userInfoSlice.js):
//   state.userInfo.favoriteLists = { byId, order, defaultId }
//
// All restaurant ids inside lists are numbers (server-side). The
// legacy `users[0].favorites` array is stringified for guest /
// legacy reasons — `legacyFavoritesArray` below normalizes everything
// to strings so card consumers don't need to care about the type.

// Server-side brand palette mirror. Component-level pickers import
// this directly to render swatch options. Keep in lockstep with
// LIST_COLOR_PALETTE in server/src/lib/favoriteLists.ts — the server
// is the validation authority; this is for UI only.
export const LIST_COLOR_PALETTE = Object.freeze([
  '#ff8800', // orange (brand primary)
  '#ef4444', // red
  '#3b82f6', // blue
  '#10b981', // green
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#f59e0b', // amber
  '#64748b', // slate
]);

// Default chip color when a list has no `color` set. Matches the
// neutral surface used elsewhere (Tailwind slate-300-ish).
export const DEFAULT_LIST_CHIP_COLOR = '#cbd5e1';

// Same constants as the server caps — surfaced here so client-side
// form validation can prevent obvious oversize before the round trip.
// If the server tightens these, update both.
export const MAX_LIST_NAME_LEN        = 80;
export const MAX_LIST_DESCRIPTION_LEN = 280;
export const MAX_LIST_ENTRY_NOTE_LEN  = 280;

// ── Selectors ───────────────────────────────────────────────────
// All selectors take the full Redux state. Designed for use with
// useSelector(s => selector(s, ...args)). Cheap O(lists) or
// O(entries-of-one-list); we have no need for reselect memoization
// at the volumes a real user hits (under 50 lists, under a few
// hundred entries each).

// True iff the restaurant is in the user's default list. Used by
// code that specifically needs the default-list relationship (e.g.
// the legacy /me/favorites mirror, the listener middleware's
// add-vs-remove decision based on previous state).
export function isInDefaultList(state, restaurantId) {
  const fl = state.userInfo?.favoriteLists;
  if (!fl?.defaultId) return false;
  const list = fl.byId[fl.defaultId];
  if (!list) return false;
  return list.entries.some((e) => String(e.restaurantId) === String(restaurantId));
}

// True iff the restaurant is in ANY of the user's lists (default
// included). This drives the heart icon's filled / unfilled state:
// the visual answers "have I favorited this anywhere?" rather than
// the narrower "is this in my default list?" so multi-list users
// don't see the heart as grey on cards they explicitly bookmarked
// to a non-default list (Date Night, Tokyo 2026, etc.). Click
// semantics remain "toggle default list membership" — see
// HeartWithKebab for the rationale. Short-circuits on first hit,
// so even with many lists this is cheap.
export function isInAnyList(state, restaurantId) {
  const fl = state.userInfo?.favoriteLists;
  if (!fl) return false;
  const target = String(restaurantId);
  for (const id of fl.order) {
    const list = fl.byId[id];
    if (!list) continue;
    if (list.entries.some((e) => String(e.restaurantId) === target)) return true;
  }
  return false;
}

// Map of listId → boolean ("is this restaurant in that list?"). Used
// by the kebab multi-list popover to render pre-checked checkboxes.
// Returns a plain object so callers can render in any order without
// re-querying per list.
export function listsContaining(state, restaurantId) {
  const fl = state.userInfo?.favoriteLists;
  if (!fl) return {};
  const out = {};
  const target = String(restaurantId);
  for (const id of fl.order) {
    const list = fl.byId[id];
    if (!list) continue;
    out[id] = list.entries.some((e) => String(e.restaurantId) === target);
  }
  return out;
}

// All lists in display order. Returns a stable array reference per
// call — if you need referential stability across re-renders, wrap
// with shallowEqual or pull byId/order separately. For most consumers
// (rendering a small dropdown), a fresh array is fine.
export function allLists(state) {
  const fl = state.userInfo?.favoriteLists;
  if (!fl) return [];
  return fl.order.map((id) => fl.byId[id]).filter(Boolean);
}

// The user's default list (or null if not hydrated). Heart-toggle
// callers use `.id` to feed addEntryToList / removeEntryFromList.
export function defaultList(state) {
  const fl = state.userInfo?.favoriteLists;
  if (!fl?.defaultId) return null;
  return fl.byId[fl.defaultId] ?? null;
}

// Entries of a specific list, as restaurant-id strings (the form
// every downstream card consumer expects — userInfo.favorites is the
// legacy precedent). Returns [] for an unknown list id.
export function listEntryIds(state, listId) {
  if (listId == null) return [];
  const fl = state.userInfo?.favoriteLists;
  const list = fl?.byId[listId];
  if (!list) return [];
  return list.entries.map((e) => String(e.restaurantId));
}

// Union of every list's entries, deduped. Backing for the optional
// "All favorites" pseudo-option in selectors when the user has
// multiple lists. Returns string IDs to match listEntryIds.
export function allEntryIdsUnion(state) {
  const fl = state.userInfo?.favoriteLists;
  if (!fl) return [];
  const seen = new Set();
  for (const id of fl.order) {
    const list = fl.byId[id];
    if (!list) continue;
    for (const entry of list.entries) seen.add(String(entry.restaurantId));
  }
  return [...seen];
}

// Drop-in replacement for `userInfo.users[0].favorites`. New code
// reads this when it doesn't care WHICH list a restaurant is in,
// only that it's favorited somewhere. Mirrors the "default list
// only" behavior of the legacy array so callers that pre-date
// multi-list keep their semantics unchanged.
//
// Returns an array of string IDs ordered most-recently-added first.
export function legacyFavoritesArray(state) {
  const list = defaultList(state);
  if (!list) {
    // Fall back to the legacy users[0].favorites array — covers
    // the guest path (server-side lists don't exist for unauthed
    // users) and any legacy state shape that hasn't hydrated lists.
    return (state.userInfo?.users?.[0]?.favorites ?? []).map(String);
  }
  return list.entries.map((e) => String(e.restaurantId));
}

// ── Page-active lists (sessionStorage-backed) ──────────────────
// Per-page key. Each surface (search / compare / choose) remembers
// its own active list selection within the session. sessionStorage
// (not Redux) keeps the choice page-local + survives a soft refresh
// but doesn't bleed across logins / browser closes.
//
// v2 storage: each page stores a JSON-encoded array of list ids that
// are currently checked. Empty array = no lists shown; null/missing =
// hasn't been initialized yet (caller seeds to [defaultId] on first
// hydrate). Pages render the union of all selected lists' entries.
//
// v1 (legacy) stored a single id or the literal string "all". The
// read function below decodes either shape so a user who carried a
// v1 value into their session doesn't see broken state.
const ACTIVE_LIST_KEY = (page) => `pickyum_active_list_${page}`;

// New canonical reader/writer — pages should prefer these.
export function readActiveListIds(page) {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(ACTIVE_LIST_KEY(page));
    if (!raw) return null;
    // v2 format: JSON-encoded numeric array.
    if (raw.startsWith('[')) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      // Be defensive — accept numbers OR numeric strings (sessionStorage
      // round-trips strings cleanly through JSON but a hand-edited value
      // could carry strings) and drop anything that isn't a positive int.
      return parsed
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n > 0);
    }
    // v1 legacy: 'all' meant "union of every list" — return null so
    // the caller can seed from default-only OR materialize all lists
    // as a fresh start; either way the user's prior selection is no
    // longer faithfully representable in v2's checkbox UI.
    if (raw === 'all') return null;
    // v1 legacy: single numeric id → treat as a one-element array.
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return [n];
    return null;
  } catch { return null; }
}

export function writeActiveListIds(page, ids) {
  if (typeof window === 'undefined') return;
  try {
    if (!Array.isArray(ids)) {
      sessionStorage.removeItem(ACTIVE_LIST_KEY(page));
      return;
    }
    sessionStorage.setItem(ACTIVE_LIST_KEY(page), JSON.stringify(ids));
  } catch { /* full storage / privacy mode — silently ignore */ }
}

// Legacy single-id reader/writer — kept exported so any straggling
// callers don't break. New code should use the *Ids variants above.
export function readActiveListId(page) {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(ACTIVE_LIST_KEY(page));
    if (!raw) return null;
    if (raw === 'all') return 'all'; // sentinel for the union view
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

export function writeActiveListId(page, value) {
  if (typeof window === 'undefined') return;
  try {
    if (value === null || value === undefined) {
      sessionStorage.removeItem(ACTIVE_LIST_KEY(page));
    } else {
      sessionStorage.setItem(ACTIVE_LIST_KEY(page), String(value));
    }
  } catch { /* full storage / privacy mode — silently ignore */ }
}
