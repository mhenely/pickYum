import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import { api, type ApiFavoriteList, type ApiFavoriteListEntry, type ChooseMethod } from '../../lib/api';
import { syncWithFeedback } from '../syncHelper';
import { mintLocalId } from '../../utils/resourceId';

// ──────────────────────────────────────────────────────────────────
// State shape
//
// Flattened from the legacy `users: [{...}]` singleton-as-array shape.
// The array was speculative for a multi-account-on-one-device case that
// never shipped — every consumer accessed `[0]` and contributed type
// `any` to the store. Flattening to `user: {...}` removes 100+ inline
// `[0]` accesses and unlocks proper typing.
//
// localStorage round-trip is unaffected: the `pickyum_guest` blob was
// already flat (see store.ts persist subscriber), so the migration is
// purely in-memory.
// ──────────────────────────────────────────────────────────────────

export interface Address {
  id: number;
  label: string;
  address: string;
  isDefault: boolean;
  createdAt: string;
}

export interface Review {
  id: number | string;
  content: string;
  rating: number;
  date: string;
}

// Per-acceptance entry as stored in Redux. `id` is the server row id
// when known (PATCH /me/accepted/:id targets it for the insights opt-out);
// optimistic appends have id=null until the listener's reconcile step
// runs. `restaurantId` is always a string in this layer — the slice
// normalizes at write time so downstream `String(x) === String(y)`
// comparisons never lie. Pre-rollout shape was `{ restaurantId, date }`.
export interface AcceptedEntry {
  id: number | null;
  restaurantId: string;
  date: string;
  excludeFromInsights: boolean;
}

// A custom or Google-Place-backed restaurant kept in the deduped map.
// Most fields are optional because custom (user-typed) rows often lack
// Google data, and legacy rows pre-rollout may lack newer columns.
export interface CustomRestaurant {
  name: string;
  type: string;
  price: number;
  rating: number | null;
  ratingCount: number | null;
  address: string | null;
  hours: string | null;
  phone: string | null;
  website: string | null;
  takeout: boolean;
  delivery: boolean;
  googlePlaceId: string | null;
  lat: number | null;
  lng: number | null;
  photos: unknown[];
  regularOpeningHours: unknown | null;
  excludeFromPlaceMatching: boolean;
  googleDataUpdatedAt: string | null;
}

// Inner user state — single account, flattened from the legacy array.
export interface UserState {
  id: number | null;
  email: string;
  username: string;
  addresses: Address[];
  flipCount: number;
  // Free-form dietary tag list surfaced in group/trip member rows.
  // Defaults to [] for guests + new accounts. Edited via /api/users/me/
  // dietary-tags; the PATCH response is folded back here.
  dietaryTags: string[];
  // Favorites / options / archived are stringy IDs to tolerate both
  // server ints AND the legacy `local-…` guest IDs in the same array.
  favorites: Array<string | number>;
  options: Array<string | number>;
  accepted: AcceptedEntry[];
  archived: string[];
  reviews: Record<string, Review[]>;
  notes?: Record<string, string>;
}

export interface FavoriteListsState {
  byId: Record<number, ApiFavoriteList>;
  order: number[];
  defaultId: number | null;
}

export interface UserInfoState {
  user: UserState;
  customRestaurants: Record<string, CustomRestaurant>;
  favoriteLists: FavoriteListsState;
  isDataLoaded: boolean;
}

// ──────────────────────────────────────────────────────────────────
// Initial state + guest hydration
// ──────────────────────────────────────────────────────────────────

interface GuestBlob extends Partial<UserState> {
  customRestaurants?: Record<string, CustomRestaurant>;
  // The pre-rename shape called this `selections`. Migrate forward.
  selections?: Array<string | number>;
}

const loadGuestData = (): GuestBlob | null => {
  try {
    const raw = localStorage.getItem('pickyum_guest');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GuestBlob;
    // One-shot migration: the field used to be called `selections`. If a guest
    // has the old shape in localStorage, carry it forward under the new name
    // so they don't lose their pre-rename list on their next page load.
    if (parsed && Array.isArray(parsed.selections) && !Array.isArray(parsed.options)) {
      parsed.options = parsed.selections;
      delete parsed.selections;
    }
    return parsed;
  } catch { return null; }
};

const savedGuest: GuestBlob | null = typeof window !== 'undefined' ? loadGuestData() : null;

// Multi-list favorites — empty default for unauthed/guest accounts.
// Authed users hydrate this from /me/data (apiVersion 2). Guests don't
// get multi-list (server-side concept); their `user.favorites` flat
// array stays the source of truth for them.
const emptyFavoriteLists = (): FavoriteListsState => ({ byId: {}, order: [], defaultId: null });

const emptyUser = (): UserState => ({
  id: null,
  email: '',
  username: '',
  // Address book — replaces the older single defaultAddress string.
  // Each entry: { id, label, address, isDefault, createdAt }. Exactly
  // one entry has isDefault=true (enforced server-side).
  addresses:  savedGuest?.addresses  ?? [],
  flipCount:  savedGuest?.flipCount  ?? 0,
  dietaryTags: savedGuest?.dietaryTags ?? [],
  favorites:  savedGuest?.favorites  ?? [],
  options:    savedGuest?.options    ?? [],
  accepted:   (savedGuest?.accepted as AcceptedEntry[] | undefined)   ?? [],
  archived:   savedGuest?.archived   ?? [],
  reviews:    savedGuest?.reviews    ?? {},
  notes:      savedGuest?.notes      ?? {},
});

const initialState: UserInfoState = {
  user: emptyUser(),
  customRestaurants: savedGuest?.customRestaurants ?? {},
  favoriteLists: emptyFavoriteLists(),
  isDataLoaded: false,
};

// ──────────────────────────────────────────────────────────────────
// mergeCustomIntoPlace internals
//
// Every collection in the slice that can reference a restaurantId needs
// to be remapped when the user links a custom row to a real Google
// Place. The reducer used to inline 6 different blocks; the registry
// below is the single place that knows the full list, so adding a new
// id-bearing collection means adding one entry — the reducer body
// doesn't change.
//
// Each step is a small named function so the per-collection nuance
// (string array vs object array vs dict vs dict-of-arrays) stays
// explicit. We do NOT try to force every shape into one abstract
// `remap(collection, cId, pId)` — the shapes are different enough
// that pretending otherwise would obscure the intent.
// ──────────────────────────────────────────────────────────────────

function applyMergeCustomIntoPlace(
  state: UserInfoState,
  cId: string,
  pId: string,
): void {
  const u = state.user;
  if (!u) return;
  remapStringIdArrays(u, cId, pId);
  remapAcceptedEntries(u, cId, pId);
  remapReviewsDict(u, cId, pId);
  remapNotesDict(u, cId, pId);
  remapFavoriteListEntries(state, cId, pId);
  // Drop the custom row from the restaurant map. The place row should
  // already be loaded (the caller materialized it before calling
  // link-to-place); if not, this is still safe — UI falls back to its
  // self-fetch path in the detail modal.
  delete state.customRestaurants[cId];
}

// Steps below are deliberately exported as module-private helpers so a
// future test file can target one at a time without driving the whole
// merge flow. Keeps the reducer testable without a fixture explosion.

function remapStringIdArrays(u: UserState, cId: string, pId: string): void {
  // favorites / options / archived all store IDs as a mix of string
  // and number (the slice's tolerance for guest "local-…" ids).
  // `as const` so TS narrows each key to its array type.
  for (const key of ['favorites', 'options', 'archived'] as const) {
    const arr = u[key];
    if (!Array.isArray(arr)) continue;
    const remapped = arr.map((id) => (String(id) === cId ? pId : String(id)));
    // Dedupe — the place might already be in this collection independently.
    u[key] = [...new Set(remapped)];
  }
}

function remapAcceptedEntries(u: UserState, cId: string, pId: string): void {
  // accepted is an array of {id, restaurantId, date, excludeFromInsights}.
  // Every entry whose restaurantId matches cId is rewritten — a user
  // may have multiple accepts for the same custom row.
  if (!Array.isArray(u.accepted)) return;
  u.accepted = u.accepted.map((a) =>
    String(a.restaurantId) === cId ? { ...a, restaurantId: pId } : a,
  );
}

function remapReviewsDict(u: UserState, cId: string, pId: string): void {
  // reviews is { [restaurantId]: Review[] }. If both keys had entries,
  // we concat — the user wrote multiple reviews under the custom row
  // before linking; the place's existing reviews come first.
  if (!u.reviews?.[cId]) return;
  u.reviews[pId] = [...(u.reviews[pId] ?? []), ...u.reviews[cId]];
  delete u.reviews[cId];
}

function remapNotesDict(u: UserState, cId: string, pId: string): void {
  // notes is { [restaurantId]: string }. The custom row's note becomes
  // the place's note ONLY if the place doesn't already have one —
  // overwriting a deliberate place note with a stray custom-row note
  // would be a quiet data loss.
  if (!u.notes?.[cId]) return;
  if (!u.notes[pId]) u.notes[pId] = u.notes[cId];
  delete u.notes[cId];
}

function remapFavoriteListEntries(state: UserInfoState, cId: string, pId: string): void {
  // FavoriteList entries store restaurantId as a number. Skip the whole
  // step if either id isn't a valid integer (custom rows that haven't
  // been materialized server-side yet — shouldn't happen via the link
  // flow but defensive).
  const cIdNum = Number(cId);
  const pIdNum = Number(pId);
  if (!Number.isInteger(cIdNum) || !Number.isInteger(pIdNum)) return;
  for (const listId of state.favoriteLists.order) {
    const list = state.favoriteLists.byId[listId];
    if (!list) continue;
    const cEntryIdx = list.entries.findIndex((e: ApiFavoriteListEntry) => e.restaurantId === cIdNum);
    if (cEntryIdx < 0) continue;
    const hasPlace = list.entries.some((e: ApiFavoriteListEntry) => e.restaurantId === pIdNum);
    if (hasPlace) {
      // Place already in this list — drop the custom row entry, keep
      // the place entry (which may carry its own per-list note).
      list.entries.splice(cEntryIdx, 1);
    } else {
      // Swap restaurantId in place; preserve note + addedAt so the
      // user's "wanted to try since X" history isn't reset by linking.
      list.entries[cEntryIdx] = { ...list.entries[cEntryIdx], restaurantId: pIdNum };
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// Slice
// ──────────────────────────────────────────────────────────────────

export const userInfoSlice = createSlice({
  name: 'userInfo',
  initialState,
  reducers: {
    // Hydrates user from API data after login/session restore.
    // `addresses` falls back to the existing value when omitted so
    // callers that update only profile fields (e.g. a username change)
    // don't accidentally clear the address book.
    setUserData: (state, action: PayloadAction<Partial<UserState> & { id: number | null; email: string; username: string }>) => {
      const { id, email, username, addresses, flipCount, dietaryTags, favorites, options, accepted, archived, reviews } = action.payload;
      state.user = {
        ...state.user,
        id,
        email,
        username,
        addresses: addresses ?? state.user.addresses ?? [],
        flipCount: flipCount ?? 0,
        dietaryTags: dietaryTags ?? state.user.dietaryTags ?? [],
        favorites: favorites ?? [],
        options: options ?? [],
        accepted: accepted ?? [],
        archived: archived ?? [],
        reviews: reviews ?? {},
      };
    },

    // Identity-only refresh used by the checkAuth.fulfilled listener so a
    // page refresh doesn't wipe an already-populated user (collections,
    // customRestaurants, favoriteLists) back to empty before loadUserData
    // arrives. setUserData IS the right call when the identity might be a
    // DIFFERENT user (login flow) — there we want collections empty until
    // loadUserData replaces them. checkAuth is the session-restore path,
    // where the previous in-memory data is still this user's own data, so
    // a wipe just produces a visible "data → empty → data" flicker.
    //
    // If the id changes (rare: cookie now belongs to a different user),
    // the reducer wipes collections defensively — we never want user A's
    // favorites visible to user B even for a frame.
    patchUserIdentity: (state, action: PayloadAction<{ id: number; email: string; username: string; flipCount?: number }>) => {
      const { id, email, username, flipCount } = action.payload;
      const prevId = state.user.id;
      const sameUser = prevId != null && prevId === id;
      state.user.id = id;
      state.user.email = email;
      state.user.username = username;
      if (flipCount !== undefined) state.user.flipCount = flipCount;
      if (!sameUser) {
        state.user.favorites = [];
        state.user.options   = [];
        state.user.accepted  = [];
        state.user.archived  = [];
        state.user.reviews   = {};
      }
    },

    // ── Address book mutations ─────────────────────────────────
    setAddresses: (state, action: PayloadAction<Address[] | null | undefined>) => {
      state.user.addresses = action.payload ?? [];
    },
    addAddress: (state, action: PayloadAction<Address | null | undefined>) => {
      const next = action.payload;
      if (!next) return;
      // If the incoming row is the new default, demote the others to
      // keep the "exactly one default" invariant intact on the client.
      const current = state.user.addresses ?? [];
      const updated = next.isDefault
        ? current.map((a) => ({ ...a, isDefault: false }))
        : current;
      state.user.addresses = [...updated, next];
    },
    updateAddress: (state, action: PayloadAction<Address | null | undefined>) => {
      const next = action.payload;
      if (!next) return;
      const current = state.user.addresses ?? [];
      // Same demote-others logic when an existing row is promoted.
      state.user.addresses = current.map((a) => {
        if (a.id === next.id) return next;
        if (next.isDefault) return { ...a, isDefault: false };
        return a;
      });
    },
    removeAddress: (state, action: PayloadAction<number>) => {
      const id = action.payload;
      const current = state.user.addresses ?? [];
      const removed = current.find((a) => a.id === id);
      const remaining = current.filter((a) => a.id !== id);
      // If we deleted the default, promote the oldest remaining entry
      // (matches the server's transaction in DELETE /me/addresses/:id).
      if (removed?.isDefault && remaining.length > 0) {
        const oldest = remaining.reduce((a, b) =>
          new Date(a.createdAt) <= new Date(b.createdAt) ? a : b
        );
        state.user.addresses = remaining.map((a) =>
          a.id === oldest.id ? { ...a, isDefault: true } : a
        );
      } else {
        state.user.addresses = remaining;
      }
    },

    updateUserInfo: (state, action: PayloadAction<Partial<UserState> & Record<string, unknown>>) => {
      Object.keys(action.payload).forEach((key) => {
        const value = (action.payload as Record<string, unknown>)[key];
        if (value) {
          (state.user as unknown as Record<string, unknown>)[key] = value;
        }
      });
    },

    // Reviews are keyed by `id` for lookups (server-issued integer for authenticated
    // users, local string like `local-...` for guests). Identical-content reviews
    // are then distinguishable.
    //
    // The legacy implementation iterated `state.users` and filtered by userId — a
    // single-user app never had >1 entry, so we simplify to a direct mutation here.
    // `userId` is kept in the payload for back-compat with callers but is ignored.
    addUserReview: (state, action: PayloadAction<{ restaurantId: string | number; userId?: number; id: number | string; content: string; rating: number; date: string }>) => {
      const { restaurantId, id, content, rating, date } = action.payload;
      const key = String(restaurantId);
      const newReview: Review = { id, content, rating, date };
      if (state.user.reviews[key]) {
        state.user.reviews[key] = [...state.user.reviews[key], newReview];
      } else {
        state.user.reviews[key] = [newReview];
      }
    },

    // In-place edit of a single review's content + rating. Preserves the
    // existing `date` field so the original timestamp doesn't shift when the
    // user fixes a typo — matches the server's behavior (PATCH preserves
    // createdAt). Fields default to the existing values when omitted.
    editUserReview: (state, action: PayloadAction<{
      restaurantId: string | number;
      id: number | string;
      content?: string;
      rating?: number;
    }>) => {
      const { restaurantId, id, content, rating } = action.payload;
      const reviews = state.user.reviews[String(restaurantId)];
      if (!reviews) return;
      state.user.reviews[String(restaurantId)] = reviews.map((r) =>
        r.id === id
          ? { ...r, content: content ?? r.content, rating: rating ?? r.rating }
          : r,
      );
    },

    removeUserReview: (state, action: PayloadAction<{ restaurantId: string | number; id: number | string }>) => {
      const { restaurantId, id } = action.payload;
      const reviews = state.user.reviews[String(restaurantId)];
      if (!reviews) return;
      state.user.reviews[String(restaurantId)] = reviews.filter((r) => r.id !== id);
    },

    updateUserFavorites: (state, action: PayloadAction<{ restaurantId: string | number }>) => {
      const { restaurantId } = action.payload;
      const id = String(restaurantId);
      const wasFavorited = state.user.favorites.some((f) => String(f) === id);
      // Toggle the legacy flat favorites array first — this is what
      // every existing card consumer reads through useCurrentUser.
      if (wasFavorited) {
        state.user.favorites = state.user.favorites.filter((f) => String(f) !== id);
      } else {
        state.user.favorites = [...state.user.favorites, restaurantId];
      }
      // Mirror the toggle into the user's default FavoriteList so
      // any new code reading state.userInfo.favoriteLists stays in
      // sync. No-op when no default exists yet (guests / pre-hydrate).
      // The listener middleware persists the change server-side; this
      // is the in-memory companion.
      const defaultId = state.favoriteLists?.defaultId ?? null;
      if (!defaultId) return;
      const defList = state.favoriteLists.byId[defaultId];
      if (!defList) return;
      const numericId = Number(restaurantId);
      if (!Number.isInteger(numericId) || numericId <= 0) return;
      if (wasFavorited) {
        defList.entries = defList.entries.filter((e) => e.restaurantId !== numericId);
      } else if (!defList.entries.some((e) => e.restaurantId === numericId)) {
        defList.entries = [
          { restaurantId: numericId, note: null, addedAt: new Date().toISOString() },
          ...defList.entries,
        ];
      }
    },

    addUserAcceptance: (state, action: PayloadAction<{ restaurantId: string | number; id?: number | null; excludeFromInsights?: boolean; optionsSnapshot?: string[]; chooseMethod?: ChooseMethod; _serverHandled?: boolean }>) => {
      // Callers pass restaurantId as a Number (GroupSessionPage parses
      // session.result through Number()) or a String (HelpMeChoosePage,
      // custom IDs). Every downstream consumer normalizes with String(...)
      // before lookup, so storing strings here at the reducer boundary
      // eliminates the recurring foot-gun without touching consumers.
      //
      // `id` is the server-assigned UserAccepted row id, included when
      // available so the per-entry insights toggle (PATCH /me/accepted/:id)
      // can target this row. Optimistic appends (legacy callers that don't
      // await the server) get `id: null`; the row is reconciled by the
      // next /me/data refresh.
      const { restaurantId, id = null, excludeFromInsights = false } = action.payload;
      state.user.accepted = [
        ...state.user.accepted,
        {
          id,
          restaurantId: String(restaurantId),
          date: new Date().toLocaleDateString(),
          excludeFromInsights: Boolean(excludeFromInsights),
        },
      ];
    },

    // Per-entry toggle for the InsightsPage opt-out. Action payload:
    // `{ id, excludeFromInsights }`. Looked up by the server-assigned row id
    // so two entries with the same restaurantId (re-visited place) are
    // independently flippable. No-op if the id isn't in state (e.g. legacy
    // pre-rollout row not yet refreshed).
    setAcceptedExcludeFromInsights: (state, action: PayloadAction<{ id: number; excludeFromInsights: boolean }>) => {
      const { id, excludeFromInsights } = action.payload;
      const list = state.user.accepted;
      const idx = list.findIndex((a) => a.id === id);
      if (idx >= 0) list[idx].excludeFromInsights = Boolean(excludeFromInsights);
    },

    // Backfill the server row id onto an optimistically-appended accepted
    // entry. addUserAcceptance writes `{ id: null, ... }` for instant UI;
    // the listener fires POST /me/accepted, then dispatches this with the
    // real id so the InsightsPage toggle can target the row without
    // waiting for the next /me/data refresh. We match the oldest no-id
    // entry for this restaurantId — concurrent appends for the same
    // restaurant are reconciled FIFO against their responses.
    reconcileAcceptedRowId: (state, action: PayloadAction<{ restaurantId: string | number; id: number }>) => {
      const { restaurantId, id } = action.payload;
      const ridStr = String(restaurantId);
      const idx = state.user.accepted.findIndex(
        (a) => String(a.restaurantId) === ridStr && a.id == null,
      );
      if (idx >= 0) state.user.accepted[idx].id = id;
    },

    removeUserOption: (state, action: PayloadAction<string | number>) => {
      const id = String(action.payload);
      state.user.options = state.user.options.filter(
        (s) => String(s) !== id
      );
    },

    addUserOption: (state, action: PayloadAction<string | number>) => {
      const id = String(action.payload);
      if (!state.user.options.find((s) => String(s) === id)) {
        state.user.options = [...state.user.options, action.payload];
      }
    },

    archiveRestaurant: (state, action: PayloadAction<string | number>) => {
      const id = String(action.payload);
      if (!state.user.archived.includes(id)) {
        state.user.archived = [...state.user.archived, id];
      }
    },

    unarchiveRestaurant: (state, action: PayloadAction<string | number>) => {
      const id = String(action.payload);
      state.user.archived = state.user.archived.filter((a) => a !== id);
    },

    incrementFlipCount: (state) => {
      state.user.flipCount = (state.user.flipCount ?? 0) + 1;
    },

    setRestaurantNote: (state, action: PayloadAction<{ restaurantId: string | number; text: string }>) => {
      const { restaurantId, text } = action.payload;
      const id = String(restaurantId);
      if (!state.user.notes) state.user.notes = {};
      if (text.trim()) {
        state.user.notes[id] = text.trim();
      } else {
        delete state.user.notes[id];
      }
    },

    removeFromHistory: (state, action: PayloadAction<string | number>) => {
      const id = String(action.payload);
      state.user.accepted = state.user.accepted.filter(
        (a) => String(a.restaurantId) !== id
      );
      delete state.user.reviews[id];
      state.user.favorites = state.user.favorites.filter((f) => String(f) !== id);
      state.user.archived = state.user.archived.filter((a) => a !== id);
      state.user.options = state.user.options.filter((s) => String(s) !== id);
      if (state.user.notes) delete state.user.notes[id];
    },

    addCustomRestaurant: (state, action: PayloadAction<{ id: string; data: CustomRestaurant }>) => {
      const { id, data } = action.payload;
      state.customRestaurants[id] = data;
    },

    // Merges refreshed fields into an existing customRestaurants entry without clearing other fields
    updateCustomRestaurant: (state, action: PayloadAction<{ id: string; data: Partial<CustomRestaurant> }>) => {
      const { id, data } = action.payload;
      if (state.customRestaurants[id]) {
        state.customRestaurants[id] = { ...state.customRestaurants[id], ...data };
      }
    },

    // Toggle a custom restaurant's opt-out flag for the Search-page
    // Place-match scan. Caller fires `api.restaurants.setMatchSettings`
    // server-side first, then dispatches this on success.
    setMatchOptOut: (state, action: PayloadAction<{ id: string | number; excludeFromPlaceMatching: boolean }>) => {
      const { id, excludeFromPlaceMatching } = action.payload;
      const row = state.customRestaurants[String(id)];
      if (row) row.excludeFromPlaceMatching = !!excludeFromPlaceMatching;
    },

    // Migrate the user's references from a custom restaurant to a Google
    // Place restaurant. Delegates to `applyMergeCustomIntoPlace` (below
    // this slice file), which keeps every per-collection remap step in
    // one named function — adding a new id-bearing collection means
    // editing exactly one place, instead of remembering to update an
    // inline block here.
    //
    // Server-side `link-to-place` endpoint has already done the
    // equivalent DB migration; this reducer mirrors the change in Redux
    // so the UI updates without a full /me/data refetch.
    mergeCustomIntoPlace: (state, action: PayloadAction<{ customId: string | number; placeId: string | number }>) => {
      const cId = String(action.payload.customId);
      const pId = String(action.payload.placeId);
      if (cId === pId) return;
      applyMergeCustomIntoPlace(state, cId, pId);
    },

    // ── Multi-list favorites mutations ─────────────────────────
    setFavoriteLists: (state, action: PayloadAction<ApiFavoriteList[]>) => {
      const lists = Array.isArray(action.payload) ? action.payload : [];
      const sorted = [...lists].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      state.favoriteLists.byId = {};
      for (const list of sorted) state.favoriteLists.byId[list.id] = list;
      state.favoriteLists.order     = sorted.map((l) => l.id);
      state.favoriteLists.defaultId = sorted.find((l) => l.isDefault)?.id ?? null;
    },

    upsertFavoriteList: (state, action: PayloadAction<ApiFavoriteList | null | undefined>) => {
      const list = action.payload;
      if (!list || typeof list.id !== 'number') return;
      const prev = state.favoriteLists.byId[list.id];
      // Preserve entries when the patch only carries metadata.
      state.favoriteLists.byId[list.id] = {
        ...prev,
        ...list,
        entries: Array.isArray(list.entries) ? list.entries : (prev?.entries ?? []),
      };
      // Promoting one list to default clears the other defaults — mirror
      // that here so the in-memory view stays consistent if a single-list
      // response came back without re-hydrating peers.
      if (list.isDefault) {
        for (const id of state.favoriteLists.order) {
          if (id !== list.id && state.favoriteLists.byId[id]) {
            state.favoriteLists.byId[id].isDefault = false;
          }
        }
        state.favoriteLists.defaultId = list.id;
      }
      if (!state.favoriteLists.order.includes(list.id)) {
        state.favoriteLists.order.push(list.id);
      }
      state.favoriteLists.order.sort((a, b) =>
        (state.favoriteLists.byId[a]?.position ?? 0) - (state.favoriteLists.byId[b]?.position ?? 0),
      );
    },

    removeFavoriteList: (state, action: PayloadAction<number | null | undefined>) => {
      const id = action.payload;
      if (id == null) return;
      delete state.favoriteLists.byId[id];
      state.favoriteLists.order = state.favoriteLists.order.filter((x) => x !== id);
      if (state.favoriteLists.defaultId === id) {
        state.favoriteLists.defaultId = state.favoriteLists.order[0] ?? null;
      }
    },

    addEntryToList: (state, action: PayloadAction<{ listId: number; entry: ApiFavoriteListEntry } | undefined>) => {
      const { listId, entry } = action.payload ?? ({} as { listId?: number; entry?: ApiFavoriteListEntry });
      if (listId == null || !entry) return;
      const list = state.favoriteLists.byId[listId];
      if (!list) return;
      const idx = list.entries.findIndex((e: ApiFavoriteListEntry) => e.restaurantId === entry.restaurantId);
      if (idx >= 0) list.entries[idx] = { ...list.entries[idx], ...entry };
      else list.entries = [entry, ...list.entries];
    },

    removeEntryFromList: (state, action: PayloadAction<{ listId: number; restaurantId: number } | undefined>) => {
      const { listId, restaurantId } = action.payload ?? ({} as { listId?: number; restaurantId?: number });
      if (listId == null || restaurantId == null) return;
      const list = state.favoriteLists.byId[listId];
      if (!list) return;
      list.entries = list.entries.filter((e: ApiFavoriteListEntry) => e.restaurantId !== restaurantId);
    },

    setFavoriteListsOrder: (state, action: PayloadAction<number[]>) => {
      const order = Array.isArray(action.payload) ? action.payload : [];
      order.forEach((id, idx) => {
        if (state.favoriteLists.byId[id]) state.favoriteLists.byId[id].position = idx;
      });
      state.favoriteLists.order = [...state.favoriteLists.order].sort((a, b) =>
        (state.favoriteLists.byId[a]?.position ?? 0) - (state.favoriteLists.byId[b]?.position ?? 0),
      );
    },

    // Marks all user data as fully loaded — prevents duplicate loadUserData calls
    setDataLoaded: (state) => {
      state.isDataLoaded = true;
    },

    // Resets all user data on logout so the next login triggers a fresh load.
    clearUserData: (state) => {
      state.user = {
        id: null, email: '', username: '', flipCount: 0,
        favorites: [], options: [], accepted: [], archived: [], reviews: {}, notes: {},
        addresses: [],
        dietaryTags: [],
      };
      state.customRestaurants = {};
      state.favoriteLists = emptyFavoriteLists();
      state.isDataLoaded = false;
    },
  },
});

export const {
  setUserData,
  patchUserIdentity,
  updateUserInfo,
  addUserReview,
  editUserReview,
  removeUserReview,
  updateUserFavorites,
  addUserAcceptance,
  setAcceptedExcludeFromInsights,
  reconcileAcceptedRowId,
  removeUserOption,
  addUserOption,
  archiveRestaurant,
  unarchiveRestaurant,
  removeFromHistory,
  setRestaurantNote,
  addCustomRestaurant,
  updateCustomRestaurant,
  setMatchOptOut,
  mergeCustomIntoPlace,
  incrementFlipCount,
  setDataLoaded,
  clearUserData,
  setAddresses,
  addAddress,
  updateAddress,
  removeAddress,
  // Multi-list favorites
  setFavoriteLists,
  upsertFavoriteList,
  removeFavoriteList,
  addEntryToList,
  removeEntryFromList,
  setFavoriteListsOrder,
} = userInfoSlice.actions;

// ──────────────────────────────────────────────────────────────────
// Thunks
// ──────────────────────────────────────────────────────────────────

interface LoadUserDataArg {
  id: number;
  email: string;
  username: string;
  flipCount?: number;
}

export const loadUserData = createAsyncThunk<void, LoadUserDataArg>(
  'userInfo/loadUserData',
  async (user, { dispatch }) => {
    // Two-stage load: identity (fast critical path) + data (heavier
    // extended payload). Fired in PARALLEL so the slower /me/data fetch
    // doesn't gate identity arrival.
    const [identityResult, dataResult] = await Promise.allSettled([
      api.users.getIdentity(),
      api.users.getData(),
    ]);

    // Identity must succeed — heart fills + nav identity depend on it.
    // Data is allowed to fail-soft: a 5xx on /me/data just leaves
    // History/Insights empty until the next refresh, with an error toast.
    if (identityResult.status === 'rejected') {
      throw identityResult.reason;
    }
    if (dataResult.status === 'rejected') {
      // eslint-disable-next-line no-console
      console.error('[loadUserData] /me/data failed; rendering with identity only:', dataResult.reason);
    }

    const dataPayload = dataResult.status === 'fulfilled'
      ? dataResult.value
      : {
          apiVersion: 2,
          restaurants: [],
          favoriteIds: identityResult.value.favoriteIds,
          optionIds: [], archivedIds: [], acceptedEntries: [],
          reviews: [], addresses: [], favoriteLists: [],
        };

    const {
      apiVersion,
      restaurants,
      favoriteIds,
      optionIds,
      archivedIds,
      acceptedEntries,
      reviews,
      addresses,
      favoriteLists,
    } = dataPayload;

    // Future-proofing: warn if we get a higher apiVersion than this
    // client knows how to consume.
    if (typeof apiVersion === 'number' && apiVersion > 2) {
      // eslint-disable-next-line no-console
      console.warn(`[loadUserData] /me/data responded with apiVersion ${apiVersion}; this client expects 2. Consider updating.`);
    }

    // Single pass over the deduped restaurants array.
    for (const r of restaurants) {
      dispatch(addCustomRestaurant({
        id: String(r.id),
        data: {
          name: r.name,
          type: r.cuisineType ?? 'Custom',
          price: r.priceLevel ?? 1,
          rating: r.googleRating != null ? Number(r.googleRating) : null,
          ratingCount: r.ratingCount ?? null,
          address: r.address ?? null,
          // null (not 'N/A') for missing values — downstream UIs do
          // truthiness checks to skip empty rows.
          hours:   r.hours   ?? null,
          phone:   r.phone   ?? null,
          website: r.website ?? null,
          takeout: r.takeout ?? false,
          delivery: r.delivery ?? false,
          googlePlaceId: r.googlePlaceId ?? null,
          lat: r.lat ?? null,
          lng: r.lng ?? null,
          photos: Array.isArray(r.photos) ? r.photos : [],
          regularOpeningHours: r.regularOpeningHours ?? null,
          excludeFromPlaceMatching: r.excludeFromPlaceMatching ?? false,
          googleDataUpdatedAt: r.googleDataUpdatedAt ?? null,
        },
      }));
    }

    dispatch(setUserData({
      id: user.id,
      email: user.email,
      username: user.username,
      addresses: (addresses as Address[] | undefined) ?? [],
      flipCount: user.flipCount ?? 0,
      dietaryTags: (user as { dietaryTags?: string[] }).dietaryTags ?? [],
      favorites: favoriteIds.map(String),
      options:   optionIds.map(String),
      archived:  archivedIds.map(String),
      accepted: acceptedEntries.map((a) => ({
        id: a.id ?? null,
        restaurantId: String(a.restaurantId),
        date: a.acceptedAt,
        excludeFromInsights: Boolean(a.excludeFromInsights),
      })),
      reviews: reviews.reduce<Record<string, Review[]>>((acc, r) => {
        const key = String(r.restaurantId);
        if (!acc[key]) acc[key] = [];
        acc[key].push({
          id: r.id,
          content: r.content ?? '',
          rating: Number(r.rating),
          date: new Date(r.createdAt).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          }),
        });
        return acc;
      }, {}),
    }));

    dispatch(setFavoriteLists(Array.isArray(favoriteLists) ? favoriteLists : []));

    // Fire stale-data refresh in the background — don't await.
    dispatch(refreshStaleRestaurants());
    dispatch(setDataLoaded());
  },
  { condition: (_, { getState }) => !(getState() as { userInfo: UserInfoState }).userInfo.isDataLoaded }
);

export const refreshStaleRestaurants = createAsyncThunk<void, void>(
  'userInfo/refreshStaleRestaurants',
  async (_, { dispatch }) => {
    try {
      const { updated } = await api.users.refreshPlaces();
      for (const r of updated) {
        dispatch(updateCustomRestaurant({
          id: String(r.id),
          // Same projection shape the initial loader uses. Keep
          // these two in lockstep — divergence means refreshed
          // rows display differently than freshly-loaded ones.
          data: {
            name: r.name,
            type: r.cuisineType ?? 'Custom',
            price: r.priceLevel ?? 1,
            rating: r.googleRating != null ? Number(r.googleRating) : null,
            ratingCount: r.ratingCount ?? null,
            address: r.address ?? null,
            hours:   r.hours   ?? null,
            phone:   r.phone   ?? null,
            website: r.website ?? null,
            regularOpeningHours: r.regularOpeningHours ?? null,
            photos: Array.isArray(r.photos) ? r.photos : [],
            takeout: r.takeout ?? false,
            delivery: r.delivery ?? false,
            googlePlaceId: r.googlePlaceId ?? null,
            lat: r.lat ?? null,
            lng: r.lng ?? null,
            googleDataUpdatedAt: r.googleDataUpdatedAt ?? null,
            excludeFromPlaceMatching: r.excludeFromPlaceMatching ?? false,
          },
        }));
      }
    } catch (err) {
      // Non-fatal — stale data is better than a broken session.
      //
      // A 429 here is the server's `externalApiLimiter` doing its job
      // (10 calls / 15 min on /me/refresh-places). Treat it as an
      // expected backpressure signal, not a failure — log at debug
      // level so we don't pollute the console during normal dev cycles
      // where rapid reloads fire the refresh on every boot. The user-
      // visible effect is the same either way: restaurants stay at
      // their current data; the next page load tries again.
      const status = (err as { status?: number })?.status;
      if (status === 429) {
        // eslint-disable-next-line no-console
        console.debug('[refresh] Skipped — server is rate-limiting refresh-places. Will retry on the next boot.');
        return;
      }
      // eslint-disable-next-line no-console
      console.warn('[refresh] Stale restaurant refresh failed:', err);
    }
  }
);

interface PersistAddReviewArg {
  restaurantId: string | number;
  userId: number;
  content: string;
  rating: number;
  date: string;
}

export const persistAddReview = createAsyncThunk<void, PersistAddReviewArg>(
  'userInfo/persistAddReview',
  async ({ restaurantId, userId, content, rating, date }, { dispatch, getState }) => {
    const isAuthenticated = (getState() as { auth?: { status: string } }).auth?.status === 'authenticated';
    if (!isAuthenticated) {
      // Guest mode — mint a local id so the slice has a unique key for
      // the review without colliding with future server-issued integers.
      // See utils/resourceId.ts for the helper.
      const localId = mintLocalId();
      dispatch(addUserReview({ restaurantId, userId, id: localId, content, rating, date }));
      return;
    }
    const { review } = await api.users.addReview({
      restaurantId: Number(restaurantId),
      rating,
      content,
    });
    dispatch(addUserReview({ restaurantId, userId, id: review.id, content, rating, date }));
  }
);

// Edits an existing review's content + rating. Guest reviews (local-* ids)
// are updated in Redux only; authenticated users round-trip through the
// server's PATCH /me/reviews/:id, then mirror the canonical response back
// into the slice. Mirrors persistAddReview's auth-vs-guest branch.
export interface PersistEditReviewArg {
  restaurantId: string | number;
  reviewId: number | string;
  content: string;
  rating: number;
}

export const persistEditReview = createAsyncThunk<void, PersistEditReviewArg>(
  'userInfo/persistEditReview',
  async ({ restaurantId, reviewId, content, rating }, { dispatch, getState }) => {
    const isAuthenticated = (getState() as { auth?: { status: string } }).auth?.status === 'authenticated';
    if (!isAuthenticated || typeof reviewId !== 'number') {
      // Guest path OR a local-id row that hasn't reconciled yet — slice-only.
      dispatch(editUserReview({ restaurantId, id: reviewId, content, rating }));
      return;
    }
    await api.users.updateReview(reviewId, { content, rating });
    dispatch(editUserReview({ restaurantId, id: reviewId, content, rating }));
  }
);

// Optimistic toggle of the InsightsPage opt-out flag on a single accepted
// row. Built on the generalized optimisticThunk helper (see
// src/redux/optimisticThunk.ts) — was previously a hand-rolled
// try/catch/rollback. The pattern is identical to what addUserAcceptance's
// listener middleware does for accepted-row backfills, so factoring both
// onto the same helper means corrections to retry / telemetry / toast
// behavior propagate to both.
//
// Two guard rails the helper can't handle for us:
//   1. `acceptedId == null` (the optimistic local row hasn't reconciled
//      yet) — silently no-op. The helper would happily PATCH /me/accepted/null
//      and surface a 404 toast for a state the user can't see.
//   2. Capturing the "previous" excludeFromInsights value for rollback —
//      the helper doesn't have access to slice state. We read it here
//      and close over it in the rollback callback.
//
// This means the wrapper is still a thin createAsyncThunk; it just delegates
// the meat to optimisticThunk through a manual dispatch chain. Treat this as
// the template for similar "needs current state" optimistic flows.
export const toggleAcceptedExcludeFromInsights = createAsyncThunk<
  boolean | undefined,
  { acceptedId: number | null; excludeFromInsights: boolean }
>(
  'userInfo/toggleAcceptedExcludeFromInsights',
  async ({ acceptedId, excludeFromInsights }, { dispatch, getState }) => {
    if (acceptedId == null) return;
    const before = (getState() as { userInfo: UserInfoState }).userInfo.user.accepted.find((a) => a.id === acceptedId);
    if (!before) return;

    // Inline the optimistic-mutation pattern. We can't use optimisticThunk
    // directly here because the rollback value depends on slice state we
    // captured above (`before.excludeFromInsights`), and the helper's
    // rollback receives only the original arg.
    dispatch(setAcceptedExcludeFromInsights({ id: acceptedId, excludeFromInsights }));
    const result = await syncWithFeedback({ dispatch }, {
      label: excludeFromInsights ? 'Excluding from insights' : 'Including in insights',
      context: { feature: 'insights', acceptedId },
      call: () => api.users.setAcceptedExcludeFromInsights(acceptedId, excludeFromInsights),
    });
    if (!result) {
      // Roll back to the previous value — user sees the toggle revert
      // alongside the error toast.
      dispatch(setAcceptedExcludeFromInsights({
        id: acceptedId,
        excludeFromInsights: before.excludeFromInsights,
      }));
      return;
    }
    // Reconcile with the server's canonical value — should match what
    // we sent, but defends against a race with another tab.
    dispatch(setAcceptedExcludeFromInsights({
      id: acceptedId,
      excludeFromInsights: result.accepted.excludeFromInsights,
    }));
    return result.accepted.excludeFromInsights;
  },
);

export default userInfoSlice.reducer;
