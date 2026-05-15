const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

const GET_CACHE = new Map<string, { data: unknown; expiresAt: number }>();
// 60s strikes the right balance for this app's data model:
// - Mutations correctly invalidate by path prefix (see request() below),
//   so cache freshness is driven by writes, not TTL expiry. The TTL only
//   gates how long a STABLE resource stays cached.
// - Most reads here (profile, reviews, group detail, restaurant info) are
//   touched once per session — a 5s TTL caused unnecessary refetches on
//   modal close→reopen and route nav→back, which felt sluggish. 60s
//   absorbs those repeats while still bounding any cache that escapes
//   invalidation (e.g. server-side writes from another tab).
const CACHE_TTL_MS = 60_000;

// Per-path TTL overrides for resources known to be stable across longer
// windows. The places.nearby cache key is the full URL with address +
// radius — once a user has the results for a given pair, re-running the
// same search within 5 minutes shouldn't pay a fresh fetch + Geocoding
// API call. Mutations don't invalidate this slot (no /api/places mutation
// exists), so the longer TTL is purely a win.
function ttlForPath(path: string): number {
  if (path.startsWith('/api/places/nearby')) return 5 * 60_000;
  if (path.startsWith('/api/places/text-search')) return 5 * 60_000;
  return CACHE_TTL_MS;
}

// Path prefixes that are read-only aggregates and never need to be
// invalidated by user-data writes. Insights aggregate over completed
// events; favoriting a restaurant doesn't change them. Skipping these
// from the broad 3-segment prefix sweep keeps insights warm across the
// flurry of writes that fire when a user is actively curating their
// favorites / options list.
const INVALIDATION_SAFE_PATHS = ['/api/users/me/insights'];

function invalidateCache(prefix: string) {
  for (const key of GET_CACHE.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (INVALIDATION_SAFE_PATHS.some((safe) => key.startsWith(safe))) continue;
    GET_CACHE.delete(key);
  }
}

// Targeted invalidator for the InsightsPage cache. Most writes intentionally
// skip insights (see INVALIDATION_SAFE_PATHS) because favoriting/options
// changes don't affect aggregates. But a small set of mutations DO change
// insights output (e.g. toggling excludeFromInsights on an accepted row)
// and call this directly so the next InsightsPage visit refetches fresh.
function invalidateInsightsCache() {
  for (const key of GET_CACHE.keys()) {
    if (key.startsWith('/api/users/me/insights')) GET_CACHE.delete(key);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();

  if (method === 'GET') {
    const cached = GET_CACHE.get(path);
    if (cached && cached.expiresAt > Date.now()) return cached.data as T;
  }

  const { headers, ...rest } = init ?? {};
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...rest,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    const err = new Error(body.error ?? `HTTP ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  const data = await res.json();

  if (method !== 'GET') {
    // Strip query string, then take at most 3 path segments as the invalidation prefix.
    // e.g. /api/users/me/favorites/123 → /api/users/me  (invalidates all user subresources)
    //      /api/restaurants           → /api/restaurants (invalidates just the restaurant list)
    const basePath = path.split('?')[0];
    const segments = basePath.split('/').filter(Boolean);
    const prefix = '/' + segments.slice(0, Math.min(3, segments.length)).join('/');
    invalidateCache(prefix);
  } else {
    GET_CACHE.set(path, { data, expiresAt: Date.now() + ttlForPath(path) });
  }

  return data as T;
}

export interface AuthUser {
  id: number;
  email: string;
  username: string;
  flipCount?: number;
  avatarUrl?: string | null;
}

// Address book entry — replaces the older single defaultAddress string on
// User. Users keep a small list of labeled locations; exactly one carries
// isDefault and drives the Search-page initial prefill.
export interface SavedAddress {
  id: number;
  label: string;
  address: string;
  isDefault: boolean;
  createdAt: string;
}

export interface ApiRestaurant {
  id: number;
  googlePlaceId: string | null;
  name: string;
  cuisineType: string | null;
  priceLevel: number | null;
  hours: string | null;
  phone: string | null;
  website: string | null;
  yelpUrl: string | null;
  takeout: boolean;
  delivery: boolean;
  googleRating: string | null;
  // Number of Google ratings backing the average. Lets the UI show
  // "4.5 (800 ratings)". Null for custom rows or pre-rollout records.
  ratingCount: number | null;
  // Geo coords, captured at create time for Google-Place-backed rows or
  // back-filled by refresh-places. Null for custom user-typed entries.
  // Consumers (e.g. CompareMap) skip rows where either is null.
  lat: number | null;
  lng: number | null;
  // Cached Google Places "Pro tier" data — same shape as
  // PlacesRestaurant.photos so frontend renderers can read from either
  // source uniformly. Null/empty for custom rows.
  photos: PlacesPhoto[] | null;
  // Structured weekly schedule. `periods` drives the client-side
  // open-now / closing-soon computation; `weekdayDescriptions` powers
  // the readable hours table in the detail modal. Null when Google
  // omits it OR when the row is custom user-typed.
  regularOpeningHours: RegularOpeningHours | null;
  // Custom-row opt-out for the post-search Place-match scan. When
  // true, the frontend's "this Google result might be your 'Joe's
  // Pizza'" check skips this row. Always false on Google-sourced
  // rows (the scan only considers customs anyway). Toggled via
  // PATCH /api/restaurants/:id/match-settings.
  excludeFromPlaceMatching: boolean;
  // ISO timestamp of the last successful Place Details refresh (or
  // materialize). Surfaced as "Google data updated 2 months ago" on
  // the detail modal so users know when fields like photos / phone
  // / hours were last sourced. Null for custom rows + legacy rows.
  googleDataUpdatedAt: string | null;
  // googleReviews column still exists in the DB (legacy rows have
  // cached review data) but is no longer requested or surfaced in the
  // UI. The Places API `reviews` field is Enterprise-tier; users now
  // get a "View on Google" deep-link instead (see googleMapsUrl util).
  // Kept here as nullable so any straggling consumers don't crash, but
  // new code should not read this — it stays stale forever.
  googleReviews?: PlacesReview[] | null;
}

// Build the URL for a Google Places photo via our server-side proxy. Keeps
// the Google API key out of client JS — the proxy 302-redirects to a
// signed Google CDN URL. `maxWidthPx` is clamped server-side to
// [100, 1600]; pick the smallest size you can render (mobile thumb ~400,
// modal hero ~1200).
export function placePhotoUrl(photo: PlacesPhoto, maxWidthPx = 400): string {
  const base = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
  const params = new URLSearchParams({ name: photo.name, maxWidthPx: String(maxWidthPx) });
  return `${base}/api/places/photo?${params.toString()}`;
}

export interface ApiAccepted {
  id: number;
  restaurantId: number;
  acceptedAt: string;
  // Per-entry opt-out from the InsightsPage aggregation. Excluded rows
  // remain in History (badge + "Include in insights" toggle); they're
  // simply dropped from totals, breakdowns, sparklines, etc. Default
  // false for every existing row (column has NOT NULL DEFAULT false).
  excludeFromInsights: boolean;
  restaurant: ApiRestaurant;
}

// Slim accept-row shape used inside /me/all's `acceptedEntries`.
// Unlike ApiAccepted (which is used by /me/accepted's CRUD endpoints
// where the join makes sense), the /me/all path resolves the
// restaurant via the deduped top-level `restaurants` array so we
// only ship { id, restaurantId, acceptedAt, excludeFromInsights } per
// event. Power users have hundreds of accepts; shipping the joined
// restaurant per row would 4× the payload, so this is the slot where
// dedup saves the most. `id` is included so the client can target a
// specific row with PATCH /me/accepted/:id without a separate fetch.
export interface ApiAcceptedEntry {
  id: number;
  restaurantId: number;
  acceptedAt: string;
  excludeFromInsights: boolean;
}

// ── Multi-list favorites ──────────────────────────────────────────
// A user-named favorite list (Date Night, Tokyo 2026, etc.). The
// `entries` field is inlined for all list reads so callers don't
// need a follow-up fetch — each entry resolves its restaurant
// against the same /me/all `restaurants[]` deduped pool used
// everywhere else.
export interface ApiFavoriteListEntry {
  restaurantId: number;
  note: string | null;
  addedAt: string;
}

export interface ApiFavoriteList {
  id: number;
  name: string;
  description: string | null;
  // Lowercase hex (e.g. "#ff8800"), or null for the default neutral
  // chip color. Server validates against an allowlist palette.
  color: string | null;
  // Exactly one list per user is marked default. The heart icon
  // toggles membership in this list regardless of how many lists
  // the user has.
  isDefault: boolean;
  // Ascending sort key for management/selector display. Reorder is
  // a full rewrite of all positions, not a swap.
  position: number;
  createdAt: string;
  entries: ApiFavoriteListEntry[];
}

// Google Places photo reference. The actual image lives at Google's
// /v1/{name}/media endpoint; the API key must NOT be exposed client-side,
// so consumers should fetch via a server-side proxy when one's set up.
export interface PlacesPhoto {
  name: string;
  widthPx: number | null;
  heightPx: number | null;
}

// Google Places `regularOpeningHours` shape. `periods` is the structured
// weekly schedule (one entry per open-close pair; 24-hour places have
// `close: null`); `weekdayDescriptions` is Google's pre-formatted
// "Monday: 11:00 AM – 10:00 PM" strings.
//
// `day` follows Google's convention: 0 = Sunday, 6 = Saturday.
// `hour` 0-23, `minute` 0-59. A period that wraps past midnight uses
// `close.day = (open.day + 1) % 7`.
export interface OpeningPoint  { day: number; hour: number; minute: number; }
export interface OpeningPeriod { open: OpeningPoint; close: OpeningPoint | null; }
export interface RegularOpeningHours {
  periods: OpeningPeriod[];
  weekdayDescriptions: string[];
}

// Legacy shape — `places.reviews` is no longer requested from the
// Places API (Enterprise-tier cost). Kept exported because the
// `ApiRestaurant.googleReviews` column still exists in the DB with
// legacy data, so anything that reads that column references this
// type. New UI surfaces use a Google Maps deep-link via
// `googleMapsUrl()` instead.
export interface PlacesReview {
  rating: number | null;
  text: string;
  publishTime: string | null;
  relativePublishTimeDescription: string | null;
  author: {
    displayName: string | null;
    uri: string | null;
    photoUri: string | null;
  };
}

export interface PlacesRestaurant {
  googlePlaceId: string;
  name: string;
  googleRating: number | null;
  // Total number of ratings backing the average — disambiguates
  // "4.5 from 3 ratings" vs "4.5 from 800". Null when Google omits.
  ratingCount: number | null;
  priceLevel: number | null;
  address: string | null;
  cuisineType: string | null;
  takeout: boolean;
  delivery: boolean;
  openNow: boolean | null;
  distanceKm: number | null;
  // Optional because text-search results don't include geometry. Nearby
  // results always do (or null when Google omits the field — render
  // nothing rather than pin at 0,0).
  lat?: number | null;
  lng?: number | null;
  photos: PlacesPhoto[];
  // Structured weekly hours. Null when Google omits, or for places
  // that have currentOpeningHours.openNow only (e.g. permanently
  // closed listings — those are filtered upstream anyway).
  regularOpeningHours: RegularOpeningHours | null;
  // Captured at search time so the modal renders them without waiting
  // on refresh-places. Null when Google doesn't have one for the
  // place — modal hides those rows.
  phone:   string | null;
  website: string | null;
}

export interface ApiReview {
  id: number;
  restaurantId: number;
  rating: string;
  content: string | null;
  createdAt: string;
  restaurant?: ApiRestaurant;
}

export interface CommunityReview {
  id: number;
  restaurantId: number;
  rating: string;
  content: string | null;
  createdAt: string;
  user: { id: number; username: string };
}

export type ChooseMethod = 'flip' | 'spin' | 'vote' | 'surprise' | 'direct';

export type InsightsWindow = 'week' | 'month' | 'year' | 'all';

export interface DecisionInsights {
  totalDecisions: number;
  distinctChosen: number;
  // 0–10, one decimal: distinct restaurants / total decisions × 10. Higher
  // means more varied choices; lower means the user keeps going to the same
  // place. 0 when totalDecisions is 0.
  varietyScore: number;
  // Echoes back the requested window so the UI can reflect "Showing this month"
  // without holding its own copy of the dropdown selection.
  since: InsightsWindow;
  // Number of acceptances in the equivalent window immediately prior to the
  // current one (e.g. days 30-60 ago when `since=month`). null when `since=all`
  // — there's no "previous all-time". Drives the "+50% vs last month" caption.
  previousPeriodCount: number | null;
  methodCounts: Record<string, number>;
  cuisineConsidered: Record<string, number>;
  cuisineChosen: Record<string, number>;
  // Top 5 cuisines by 12-week acceptance count, mapped to 12 weekly buckets
  // oldest-first. Empty record if no cuisine had any acceptances in the
  // window. Drives the sparkline column on the cuisine trends table.
  cuisineWeeklyCounts: Record<string, number[]>;
  // 7 buckets, Sunday→Saturday (JS getDay() order). Counts within the active
  // time window. UTC-bucketed on the server today.
  weekdayCounts: number[];
  topConsidered: Array<{
    restaurantId: string;
    name: string;
    cuisineType: string | null;
    considered: number;
    wins: number;
    winRate: number;
  }>;
  oftenSkipped: Array<{
    restaurantId: string;
    name: string;
    cuisineType: string | null;
    considered: number;
    wins: number;
    winRate: number;
  }>;
  // Favorites the user hasn't picked in NEGLECT_THRESHOLD_DAYS (currently 60),
  // or never. Always computed against full history — ignores the `since`
  // window because "haven't picked it in a long time" only makes sense across
  // all of it. Empty array when no favorites qualify.
  neglectedFavorites: Array<{
    restaurantId: string;
    name: string;
    cuisineType: string | null;
    lastChosenAt: string | null; // null = never chosen
  }>;
  recent: Array<{
    restaurantId: string;
    name: string;
    acceptedAt: string;
    chooseMethod: ChooseMethod | null;
    // Present for acceptances created by a group's accept-result flow
    // (post-rollout). Solo acceptances and pre-rollout group acceptances
    // have null for both — UI uses these together to deep-link the row into
    // the ballot detail modal.
    eventId: number | null;
    groupId: number | null;
    competing: string[];
  }>;
}

export const api = {
  auth: {
    me: () =>
      request<{ user: AuthUser }>('/api/auth/me'),
    login: (body: { email: string; password: string }) =>
      request<{ user: AuthUser }>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
    register: (body: { email: string; username: string; password: string }) =>
      request<{ user: AuthUser }>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) }),
    logout: () =>
      request('/api/auth/logout', { method: 'POST' }),
    supabaseCallback: (access_token: string) =>
      request<{ user: AuthUser }>('/api/auth/supabase', { method: 'POST', body: JSON.stringify({ access_token }) }),
    forgotPassword: (email: string) =>
      request<{ message: string }>('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),
    resetPassword: (body: { token: string; password: string }) =>
      request<{ message: string }>('/api/auth/reset-password', { method: 'POST', body: JSON.stringify(body) }),
    verifyEmail: (token: string) =>
      request<{ message: string }>('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) }),
    resendVerification: () =>
      request<{ message: string }>('/api/auth/resend-verification', { method: 'POST' }),
  },
  users: {
    // Server requires `currentPassword` whenever `email` or `password` is set
    // (re-auth before sensitive change). Username-only updates don't need it.
    // Address-book CRUD has moved to its own endpoints below — this no
    // longer accepts a defaultAddress field.
    updateProfile: (body: { email?: string; username?: string; password?: string; currentPassword?: string }) =>
      request<{ user: AuthUser }>('/api/users/me', { method: 'PATCH', body: JSON.stringify(body) }),

    // ── Address book ─────────────────────────────────────────────
    // Used by UserInfoPage (full CRUD) and SearchPage (read for the
    // prefill dropdown). The "default" address is special: exactly one
    // row per user carries isDefault=true at any time, enforced by the
    // backend writes.
    listAddresses: () =>
      request<{ addresses: SavedAddress[] }>('/api/users/me/addresses'),
    createAddress: (body: { label: string; address: string; isDefault?: boolean }) =>
      request<{ address: SavedAddress }>('/api/users/me/addresses', { method: 'POST', body: JSON.stringify(body) }),
    updateAddress: (id: number, body: { label?: string; address?: string; isDefault?: boolean }) =>
      request<{ address: SavedAddress }>(`/api/users/me/addresses/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteAddress: (id: number) =>
      request<{ message: string }>(`/api/users/me/addresses/${id}`, { method: 'DELETE' }),
    // Account deletion. By default the user's reviews are anonymized
    // (userId → null) so they stay in each restaurant's community pool. Pass
    // `retractReviews: true` to additionally delete the review rows entirely
    // — server-side, that strip happens *before* the FK cascade fires so the
    // recompute sees them gone.
    deleteAccount: (opts: { retractReviews?: boolean } = {}) =>
      request<{ message: string }>('/api/users/me', {
        method: 'DELETE',
        body: JSON.stringify(opts),
      }),
    getFavorites: () =>
      request<{ favorites: ApiRestaurant[] }>('/api/users/me/favorites'),
    addFavorite: (id: number) =>
      request('/api/users/me/favorites/' + id, { method: 'POST' }),
    removeFavorite: (id: number) =>
      request('/api/users/me/favorites/' + id, { method: 'DELETE' }),
    getOptions: () =>
      request<{ options: ApiRestaurant[] }>('/api/users/me/options'),
    addOption: (id: number) =>
      request('/api/users/me/options/' + id, { method: 'POST' }),
    removeOption: (id: number) =>
      request('/api/users/me/options/' + id, { method: 'DELETE' }),
    getAccepted: () =>
      request<{ accepted: ApiAccepted[] }>('/api/users/me/accepted'),
    addAccepted: (
      restaurantId: number,
      opts: { optionsSnapshot?: string[]; chooseMethod?: ChooseMethod; excludeFromInsights?: boolean } = {},
    ) =>
      request<{ accepted: ApiAccepted }>('/api/users/me/accepted', {
        method: 'POST',
        body: JSON.stringify({ restaurantId, ...opts }),
      }),
    // Per-entry toggle for the InsightsPage opt-out. Returns the updated
    // row so callers can reconcile optimistic state with the server's
    // canonical version. The mutation invalidates the /me/insights cache
    // entries via the standard 3-segment prefix match (`/api/users/me`),
    // so the next InsightsPage visit refetches fresh aggregates.
    setAcceptedExcludeFromInsights: async (acceptedId: number, excludeFromInsights: boolean) => {
      const result = await request<{ accepted: ApiAccepted }>(
        `/api/users/me/accepted/${acceptedId}`,
        { method: 'PATCH', body: JSON.stringify({ excludeFromInsights }) },
      );
      // The generic /api/users/me prefix sweep deliberately skips
      // /me/insights for performance. This particular write DOES affect
      // insights, so we manually drop the cached aggregates here.
      invalidateInsightsCache();
      return result;
    },
    // `since` filters acceptances to a sliding window. Defaults to all-time.
    // The 5-second GET cache is keyed on the full path, so each window picks
    // up its own cache entry — no extra invalidation logic needed.
    getInsights: (since: InsightsWindow = 'all') =>
      request<DecisionInsights>(`/api/users/me/insights?since=${encodeURIComponent(since)}`),
    getArchived: () =>
      request<{ archived: ApiRestaurant[] }>('/api/users/me/archived'),
    archiveRestaurant: (id: number) =>
      request('/api/users/me/archived/' + id, { method: 'POST' }),
    unarchiveRestaurant: (id: number) =>
      request('/api/users/me/archived/' + id, { method: 'DELETE' }),
    // The /me/all endpoint ships a NORMALIZED payload: one deduped
    // `restaurants` array + ID-only collection lists. Frontend joins
    // back via `restaurants[].id`. Replaces a previous shape that
    // nested ApiRestaurant under each collection row and silently
    // dropped accepted-only restaurants because the accepted slot
    // was thin.
    //
    // `apiVersion` is incremented when this shape breaks in a
    // non-additive way — clients use it to gate "please update."
    //   v1 → original deduped shape (restaurants[] + per-collection
    //        ID arrays).
    //   v2 → adds `favoriteLists[]` (multi-list favorites).
    //        `favoriteIds` stays as a derived view of the default
    //        list's entries during the migration; will be dropped
    //        in a future minor bump.
    // Mirrored by ME_ALL_API_VERSION in the server route.
    getAll: () =>
      request<{
        apiVersion: number;
        restaurants:     ApiRestaurant[];
        favoriteIds:     number[];
        optionIds:       number[];
        archivedIds:     number[];
        acceptedEntries: ApiAcceptedEntry[];
        reviews:         ApiReview[];
        addresses:       SavedAddress[];
        favoriteLists:   ApiFavoriteList[];
      }>('/api/users/me/all'),

    // ── Multi-list favorites ────────────────────────────────────
    // Every authed account has at least one list (the default,
    // auto-created on registration). Heart-icon toggles still target
    // the default list; explicit list-picker UI uses these endpoints
    // for non-default lists.
    listFavoriteLists: () =>
      request<{ lists: ApiFavoriteList[] }>('/api/users/me/favorite-lists'),
    createFavoriteList: (body: { name: string; description?: string | null; color?: string | null }) =>
      request<{ list: ApiFavoriteList }>('/api/users/me/favorite-lists', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    updateFavoriteList: (
      id: number,
      body: { name?: string; description?: string | null; color?: string | null },
    ) =>
      request<{ list: ApiFavoriteList }>(`/api/users/me/favorite-lists/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    deleteFavoriteList: (id: number) =>
      request<{ message: string }>(`/api/users/me/favorite-lists/${id}`, { method: 'DELETE' }),
    // Promotes this list to default in one shot — server demotes
    // any other default in the same transaction.
    promoteFavoriteList: (id: number) =>
      request<{ list: ApiFavoriteList }>(`/api/users/me/favorite-lists/${id}/default`, {
        method: 'POST',
      }),
    // Rewrites every list's position. Body must list every list id
    // the user owns exactly once — partial reorders are 400'd.
    reorderFavoriteLists: (order: number[]) =>
      request<{ message: string }>('/api/users/me/favorite-lists/positions', {
        method: 'PATCH',
        body: JSON.stringify({ order }),
      }),
    addFavoriteListEntry: (listId: number, body: { restaurantId: number; note?: string | null }) =>
      request<{ entry: ApiFavoriteListEntry }>(
        `/api/users/me/favorite-lists/${listId}/entries`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    removeFavoriteListEntry: (listId: number, restaurantId: number) =>
      request<{ message: string }>(
        `/api/users/me/favorite-lists/${listId}/entries/${restaurantId}`,
        { method: 'DELETE' },
      ),
    updateFavoriteListEntry: (listId: number, restaurantId: number, body: { note: string | null }) =>
      request<{ entry: ApiFavoriteListEntry }>(
        `/api/users/me/favorite-lists/${listId}/entries/${restaurantId}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      ),
    getReviews: () =>
      request<{ reviews: ApiReview[] }>('/api/users/me/reviews'),
    addReview: (body: { restaurantId: number; rating: number; content?: string }) =>
      request<{ review: ApiReview }>('/api/users/me/reviews', { method: 'POST', body: JSON.stringify(body) }),
    deleteReview: (id: number) =>
      request('/api/users/me/reviews/' + id, { method: 'DELETE' }),
    refreshPlaces: () =>
      request<{ updated: ApiRestaurant[] }>('/api/users/me/refresh-places', { method: 'POST' }),
    // "Just-in-time" single-row refresh. The detail modal fires this on
    // open so we only spend Place Details quota on restaurants the user
    // is actually viewing — cuts refresh spend ~80% vs the eager batch.
    // Always resolves; { refreshed: false, restaurant: null } when the
    // row was fresh, custom (no googlePlaceId), or any error occurred.
    refreshRestaurant: (restaurantId: number) =>
      request<{ refreshed: boolean; restaurant: ApiRestaurant | null }>(
        `/api/users/me/refresh-restaurant/${restaurantId}`,
        { method: 'POST' },
      ),
    recordFlip: () =>
      request<{ flipCount: number }>('/api/users/me/flip', { method: 'POST' }),
    removeFromHistory: (restaurantId: number) =>
      request<{ message: string }>('/api/users/me/history/' + restaurantId, { method: 'DELETE' }),
  },
  restaurants: {
    create: (body: {
      name: string;
      googlePlaceId?: string;
      cuisineType?: string;
      priceLevel?: number;
      googleRating?: number;
      // Total Google ratings backing the average. Stored on the Restaurant
      // row so the UI doesn't have to re-fetch from Places to display
      // "4.5 (800 ratings)".
      ratingCount?: number;
      hours?: string;
      phone?: string;
      website?: string;
      yelpUrl?: string;
      takeout?: boolean;
      delivery?: boolean;
      // Coords passed through when materializing a Places-API nearby
      // result so the Restaurant row gets geo data without a follow-up
      // refresh. Omit for custom user-typed entries.
      lat?: number;
      lng?: number;
      // Photos captured at materialize time. Server sanitizes (caps
      // array length, validates shape) before persisting; the frontend
      // can stream the raw Places response through. Reviews are no
      // longer captured here — the UI links out to Google Maps for
      // full reviews instead (see googleMapsUrl utility).
      photos?: PlacesPhoto[];
      // Structured weekly hours from the Places response. Server
      // re-sanitizes shape + caps periods/descriptions length.
      regularOpeningHours?: RegularOpeningHours;
    }) => request<{ restaurant: ApiRestaurant }>('/api/restaurants', { method: 'POST', body: JSON.stringify(body) }),
    // Public detail fetch — used by the voting page's info modal. Auth-optional
    // (guest voters can call it), returns only Restaurant-table fields (no
    // personal reviews, no favorites). The route is already gated this way
    // server-side via lack of requireAuth on GET /api/restaurants/:id.
    get: (id: number) =>
      request<{ restaurant: ApiRestaurant & { address?: string | null; communityRating?: string | null } }>(
        `/api/restaurants/${id}`,
      ),
    getReviews: (id: number) =>
      request<{ reviews: CommunityReview[]; averageRating: number | null; communityRating: number | null }>(
        `/api/restaurants/${id}/reviews`,
      ),
    // Toggle the post-search Place-match scan's opt-out for a custom
    // restaurant. Server validates ownership + that the row is
    // actually custom (no googlePlaceId) — returns 403/400 otherwise.
    setMatchSettings: (id: number, body: { excludeFromPlaceMatching: boolean }) =>
      request<{ restaurant: { id: number; excludeFromPlaceMatching: boolean } }>(
        `/api/restaurants/${id}/match-settings`,
        { method: 'PATCH', body: JSON.stringify(body) },
      ),
    // Merge a custom row into a Google Place row. Caller is expected
    // to have materialized the Place first (via restaurants.create
    // above) so `placeRestaurantId` exists. Server migrates all of
    // this user's collection references from the custom row to the
    // place row, then deletes the custom row if it was private. The
    // returned `mergedRestaurantId` is the Place row's id — caller
    // updates Redux to swap references.
    linkToPlace: (customId: number, body: { placeRestaurantId: number }) =>
      request<{ mergedRestaurantId: number }>(
        `/api/restaurants/${customId}/link-to-place`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
  },
  places: {
    // `cuisineType` (optional) is a Google Places type slug like
    // 'italian_restaurant'. When set, the server issues a single
    // searchNearby with `includedTypes: [cuisineType]` so only places
    // of that cuisine come back. When omitted, the server falls back
    // to its 3-slice fan-out across all food categories. The slug
    // must match one of the CUISINE_OPTIONS values in
    // src/utils/cuisineTypes.js — anything else is dropped server-
    // side (silently falls back to the fan-out).
    nearby: (address: string, radiusMeters: number, cuisineType?: string | null) => {
      const params = new URLSearchParams({
        address,
        radiusMeters: String(radiusMeters),
      });
      if (cuisineType) params.set('cuisineType', cuisineType);
      return request<{
        restaurants: PlacesRestaurant[];
        configured: boolean;
        resolvedAddress?: string;
        resolvedLat?: number;
        resolvedLng?: number;
      }>(`/api/places/nearby?${params.toString()}`);
    },
    search: (q: string) =>
      request<{ restaurants: PlacesRestaurant[]; configured: boolean }>(
        `/api/places/text-search?q=${encodeURIComponent(q)}`,
      ),
  },
  trips: {
    list: () =>
      request<{ trips: ApiTripListEntry[] }>('/api/trips'),
    create: (body: { name: string; destination: string; startDate?: string | null; endDate?: string | null }) =>
      request<{ trip: ApiTrip }>('/api/trips', { method: 'POST', body: JSON.stringify(body) }),
    get: (id: number) =>
      request<{ trip: ApiTrip }>(`/api/trips/${id}`),
    update: (id: number, body: { name?: string; destination?: string; startDate?: string | null; endDate?: string | null }) =>
      request<{ trip: ApiTrip }>(`/api/trips/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    archive: (id: number) =>
      request<{ trip: ApiTrip }>(`/api/trips/${id}/archive`, { method: 'POST' }),
    // Member lifecycle — invite/accept/decline replaces the old direct-add
    // flow. Host sends an invite; the invitee can accept (becomes a
    // TripMember) or decline.
    inviteMember: (id: number, username: string) =>
      request<{ trip: ApiTrip; invite: ApiTripInvite }>(`/api/trips/${id}/invites`, { method: 'POST', body: JSON.stringify({ username }) }),
    importInvitesFromGroup: (id: number, groupId: number) =>
      request<{ trip: ApiTrip; invited: number; skipped: number }>(`/api/trips/${id}/invites/import-from-group`, { method: 'POST', body: JSON.stringify({ groupId }) }),
    rescindInvite: (id: number, inviteId: number) =>
      request<{ trip: ApiTrip }>(`/api/trips/${id}/invites/${inviteId}`, { method: 'DELETE' }),
    respondToInvite: (id: number, inviteId: number, action: 'accept' | 'decline') =>
      request<{ trip?: ApiTrip; message?: string }>(`/api/trips/${id}/invites/${inviteId}/respond`, { method: 'POST', body: JSON.stringify({ action }) }),
    listMyInvites: () =>
      request<{ invites: ApiTripIncomingInvite[] }>('/api/trips/me/invites'),
    removeMember: (id: number, userId: number) =>
      request<{ trip?: ApiTrip; message?: string }>(`/api/trips/${id}/members/${userId}`, { method: 'DELETE' }),
    addAnchor: (id: number, body: { label: string; address: string; isPrimary?: boolean }) =>
      request<{ anchor: ApiTripAnchor }>(`/api/trips/${id}/anchors`, { method: 'POST', body: JSON.stringify(body) }),
    updateAnchor: (id: number, anchorId: number, body: { label?: string; address?: string; isPrimary?: boolean }) =>
      request<{ anchor: ApiTripAnchor }>(`/api/trips/${id}/anchors/${anchorId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteAnchor: (id: number, anchorId: number) =>
      request<{ message: string }>(`/api/trips/${id}/anchors/${anchorId}`, { method: 'DELETE' }),

    // ── Meal events ──────────────────────────────────────────────
    // Lifecycle mirrors groups' event API (groupsApi.js) but scoped to
    // the trip and with three trip-specific fields: scheduledFor (the
    // meal time), mealSlot, and participantUserIds.
    createEvent: (id: number, body: {
      name: string;
      scheduledFor?: string | null;
      mealSlot?: TripMealSlot | null;
      participantUserIds?: number[];
    }) =>
      request<{ event: ApiTripMealEvent }>(`/api/trips/${id}/events`, { method: 'POST', body: JSON.stringify(body) }),
    updateEvent: (id: number, eventId: number, body: {
      name?: string;
      scheduledFor?: string | null;
      mealSlot?: TripMealSlot | null;
      participantUserIds?: number[];
    }) =>
      request<{ event: ApiTripMealEvent }>(`/api/trips/${id}/events/${eventId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    deleteEvent: (id: number, eventId: number) =>
      request<{ message: string }>(`/api/trips/${id}/events/${eventId}`, { method: 'DELETE' }),
    addEventOption: (id: number, eventId: number, restaurantId: number) =>
      request<{ option: ApiTripMealOption }>(`/api/trips/${id}/events/${eventId}/options`, { method: 'POST', body: JSON.stringify({ restaurantId }) }),
    removeEventOption: (id: number, eventId: number, restaurantId: number) =>
      request<{ message: string }>(`/api/trips/${id}/events/${eventId}/options/${restaurantId}`, { method: 'DELETE' }),
    setVoteMethod: (id: number, eventId: number, voteMethod: 'SIMPLE' | 'RANKED') =>
      request<{ voteMethod: string }>(`/api/trips/${id}/events/${eventId}/vote-method`, { method: 'PATCH', body: JSON.stringify({ voteMethod }) }),
    // Set (or clear with null) the time at which the on-read sweeper opens
    // voting automatically. Mirrors groupsApi.setSchedule for symmetry.
    setSchedule: (id: number, eventId: number, votingStartsAt: string | null) =>
      request<{ votingStartsAt: string | null }>(`/api/trips/${id}/events/${eventId}/schedule`, { method: 'PATCH', body: JSON.stringify({ votingStartsAt }) }),
    startVoting: (id: number, eventId: number) =>
      request<{ sessionId: string }>(`/api/trips/${id}/events/${eventId}/start-voting`, { method: 'POST' }),
    cancelVoting: (id: number, eventId: number) =>
      request<{ message: string }>(`/api/trips/${id}/events/${eventId}/cancel-voting`, { method: 'POST' }),
    acceptResult: (id: number, eventId: number) =>
      request<{ message: string }>(`/api/trips/${id}/events/${eventId}/accept-result`, { method: 'POST' }),
    getEvent: (id: number, eventId: number) =>
      request<{ event: ApiTripMealEvent }>(`/api/trips/${id}/events/${eventId}`),
  },
};

// ── Trip types ─────────────────────────────────────────────────
export interface ApiTripMember {
  userId: number;
  joinedAt: string;
  user: { id: number; username: string; avatarUrl: string | null };
}

export interface ApiTripAnchor {
  id: number;
  tripId: number;
  label: string;
  address: string;
  isPrimary: boolean;
  createdAt: string;
}

export interface ApiTripInvite {
  id: number;
  invitedId: number;
  invitedById: number;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
  createdAt: string;
  invited:   { id: number; username: string; avatarUrl: string | null };
  invitedBy: { id: number; username: string; avatarUrl: string | null };
}

// Shape returned by /me/invites — pendings only, denormalized with the
// trip header so the navbar bell can render the trip name + destination
// without a follow-up fetch per row.
export interface ApiTripIncomingInvite {
  id: number;
  tripId: number;
  createdAt: string;
  trip: { id: number; name: string; destination: string };
  invitedBy: { id: number; username: string; avatarUrl: string | null };
}

export type TripMealSlot = 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'SNACK';

// A restaurant pinned as a candidate on a trip meal event. Matches the
// shape returned by the backend's mealEventInclude — denormalized restaurant
// fields are inlined so meal cards render in one pass.
export interface ApiTripMealOption {
  id: number;
  eventId: number;
  restaurantId: number;
  addedById: number;
  createdAt: string;
  restaurant: {
    id: number;
    name: string;
    cuisineType: string | null;
    priceLevel: number | null;
    address: string | null;
    lat: number | null;
    lng: number | null;
  };
  addedBy?: { id: number; username: string };
}

// Result row written when a trip meal vote concludes. Same shape family as
// the group-side GroupEventResult; the inline pool snapshot makes the
// "meal already happened" card self-contained even after the session expires.
export interface ApiTripMealResult {
  id: number;
  eventId: number;
  hostUsername: string;
  winnerName: string;
  method: string;
  voteMethod: string | null;
  participants: string[];
  scores: Record<string, number> | null;
  ballots: unknown;
  voterMeta: unknown;
  irvRounds: unknown;
  restaurantPool: unknown;
  createdAt: string;
}

export interface ApiTripMealEvent {
  id: number;
  tripId: number | null;
  groupId: number | null;       // always null for trip events; kept for clarity
  name: string;
  status: 'OPEN' | 'VOTING' | 'DONE';
  voteMethod: 'SIMPLE' | 'RANKED';
  mealSlot: TripMealSlot | null;
  participantUserIds: number[]; // empty array = "everyone on the trip"
  scheduledFor: string | null;
  votingStartsAt: string | null;
  sessionId: string | null;
  createdById: number | null;
  createdAt: string;
  options: ApiTripMealOption[];
  createdBy: { id: number; username: string } | null;
  result: ApiTripMealResult | null;
}

// Slim shape returned by `GET /api/trips` — the Trips landing list. Drops
// the heavy nested arrays (members, anchors, invites, events) in favor of
// inline counts so the list payload is O(trips), not O(trips × events ×
// options). TripDetailPage still gets the full `ApiTrip` from `GET /:id`.
export interface ApiTripListEntry {
  id: number;
  name: string;
  destination: string;
  startDate: string | null;
  endDate: string | null;
  hostId: number;
  archivedAt: string | null;
  createdAt: string;
  host: { id: number; username: string; avatarUrl: string | null };
  // Primary anchor only — SearchPage's trip-override banner needs it.
  // All anchors live on the detail endpoint's full ApiTrip.
  anchors: Array<{ id: number; label: string; address: string; isPrimary: boolean }>;
  _count: { members: number; events: number; anchors: number };
}

export interface ApiTrip {
  id: number;
  name: string;
  destination: string;
  startDate: string | null;
  endDate: string | null;
  hostId: number;
  archivedAt: string | null;
  createdAt: string;
  host: { id: number; username: string; avatarUrl: string | null };
  members: ApiTripMember[];
  anchors: ApiTripAnchor[];
  invites: ApiTripInvite[];
  events: ApiTripMealEvent[];
}
