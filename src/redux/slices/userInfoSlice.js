import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import { api } from "../../lib/api";

const loadGuestData = () => {
  try {
    const raw = localStorage.getItem('pickyum_guest');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
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

const savedGuest = typeof window !== 'undefined' ? loadGuestData() : null;

// Multi-list favorites — empty default for unauthed/guest accounts.
// Authed users hydrate this from /me/all (apiVersion 2). Guests don't
// get multi-list (server-side concept); their `users[0].favorites`
// flat array stays the source of truth for them.
//
// Shape:
//   byId:      { [listId]: ApiFavoriteList }  (entries inlined)
//   order:     [listId, ...]                  (sorted by position asc)
//   defaultId: listId | null                  (set after hydrate)
//
// Helpers + selectors live in src/utils/favoriteLists.js so consumers
// import from one place. Mutations go through the reducers below.
const emptyFavoriteLists = () => ({ byId: {}, order: [], defaultId: null });

const initialState = {
  users: [
    {
      id: null,
      email: '',
      username: '',
      // Address book — replaces the older single defaultAddress string.
      // Each entry: { id, label, address, isDefault, createdAt }. Exactly
      // one entry has isDefault=true (enforced server-side). Frontend
      // derives the Search-page prefill from `addresses.find(a => a.isDefault)`.
      addresses:  savedGuest?.addresses  ?? [],
      flipCount:  savedGuest?.flipCount  ?? 0,
      favorites:  savedGuest?.favorites  ?? [],
      options:    savedGuest?.options    ?? [],
      accepted:   savedGuest?.accepted   ?? [],
      archived:   savedGuest?.archived   ?? [],
      reviews:    savedGuest?.reviews    ?? {},
      notes:      savedGuest?.notes      ?? {},
    },
  ],
  customRestaurants: savedGuest?.customRestaurants ?? {},
  favoriteLists: emptyFavoriteLists(),
  isDataLoaded: false,
};

export const userInfoSlice = createSlice({
  name: 'userInfo',
  initialState,
  reducers: {
    // Hydrates users[0] from API data after login/session restore.
    // `addresses` falls back to the existing value when omitted so
    // callers that update only profile fields (e.g. a username change)
    // don't accidentally clear the address book.
    setUserData: (state, action) => {
      const { id, email, username, addresses, flipCount, favorites, options, accepted, archived, reviews } = action.payload;
      state.users[0] = {
        ...state.users[0],
        id,
        email,
        username,
        addresses: addresses ?? state.users[0].addresses ?? [],
        flipCount: flipCount ?? 0,
        favorites: favorites ?? [],
        options: options ?? [],
        accepted: accepted ?? [],
        archived: archived ?? [],
        reviews: reviews ?? {},
      };
    },

    // ── Address book mutations ─────────────────────────────────
    // The reducer is the source of truth for in-memory state; the
    // thunks below (or component-level callers) fire the network call
    // and dispatch these on success. Optimistic-then-rollback isn't
    // worth the complexity for an address book that's edited rarely.
    setAddresses: (state, action) => {
      state.users[0].addresses = action.payload ?? [];
    },
    addAddress: (state, action) => {
      const next = action.payload;
      if (!next) return;
      // If the incoming row is the new default, demote the others to
      // keep the "exactly one default" invariant intact on the client.
      const current = state.users[0].addresses ?? [];
      const updated = next.isDefault
        ? current.map((a) => ({ ...a, isDefault: false }))
        : current;
      state.users[0].addresses = [...updated, next];
    },
    updateAddress: (state, action) => {
      const next = action.payload;
      if (!next) return;
      const current = state.users[0].addresses ?? [];
      // Same demote-others logic when an existing row is promoted.
      state.users[0].addresses = current.map((a) => {
        if (a.id === next.id) return next;
        if (next.isDefault) return { ...a, isDefault: false };
        return a;
      });
    },
    removeAddress: (state, action) => {
      const id = action.payload;
      const current = state.users[0].addresses ?? [];
      const removed = current.find((a) => a.id === id);
      const remaining = current.filter((a) => a.id !== id);
      // If we deleted the default, promote the oldest remaining entry
      // (matches the server's transaction in DELETE /me/addresses/:id).
      if (removed?.isDefault && remaining.length > 0) {
        const oldest = remaining.reduce((a, b) =>
          new Date(a.createdAt) <= new Date(b.createdAt) ? a : b
        );
        state.users[0].addresses = remaining.map((a) =>
          a.id === oldest.id ? { ...a, isDefault: true } : a
        );
      } else {
        state.users[0].addresses = remaining;
      }
    },

    updateUserInfo: (state, action) => {
      Object.keys(action.payload).forEach((key) => {
        if (action.payload[key]) {
          state.users[0][key] = action.payload[key];
        }
      });
    },

    // Reviews are keyed by `id` for lookups (server-issued integer for authenticated
    // users, local string like `local-...` for guests). Identical-content reviews
    // are then distinguishable.
    addUserReview: (state, action) => {
      const { restaurantId, userId, id, content, rating, date } = action.payload;
      const newReview = { id, content, rating, date };

      state.users = state.users.map((user) => {
        if (user.id === userId) {
          if (user.reviews[restaurantId]) {
            user.reviews[restaurantId] = [...user.reviews[restaurantId], newReview];
          } else {
            user.reviews[restaurantId] = [newReview];
          }
        }
        return user;
      });
    },

    removeUserReview: (state, action) => {
      const { restaurantId, id } = action.payload;
      const reviews = state.users[0].reviews[restaurantId];
      if (!reviews) return;
      state.users[0].reviews[restaurantId] = reviews.filter((r) => r.id !== id);
    },

    updateUserFavorites: (state, action) => {
      const { restaurantId } = action.payload;
      const id = String(restaurantId);
      const wasFavorited = state.users[0].favorites.some((f) => String(f) === id);
      // Toggle the legacy flat favorites array first — this is what
      // every existing card consumer reads through useCurrentUser.
      if (wasFavorited) {
        state.users[0].favorites = state.users[0].favorites.filter((f) => String(f) !== id);
      } else {
        state.users[0].favorites = [...state.users[0].favorites, restaurantId];
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

    addUserAcceptance: (state, action) => {
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
      // next /me/all refresh.
      const { restaurantId, id = null, excludeFromInsights = false } = action.payload;
      state.users[0].accepted = [
        ...state.users[0].accepted,
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
    setAcceptedExcludeFromInsights: (state, action) => {
      const { id, excludeFromInsights } = action.payload;
      const list = state.users[0].accepted;
      const idx = list.findIndex((a) => a.id === id);
      if (idx >= 0) list[idx].excludeFromInsights = Boolean(excludeFromInsights);
    },

    // Backfill the server row id onto an optimistically-appended accepted
    // entry. addUserAcceptance writes `{ id: null, ... }` for instant UI;
    // the listener fires POST /me/accepted, then dispatches this with the
    // real id so the InsightsPage toggle can target the row without
    // waiting for the next /me/all refresh. We match the oldest no-id
    // entry for this restaurantId — concurrent appends for the same
    // restaurant are reconciled FIFO against their responses.
    reconcileAcceptedRowId: (state, action) => {
      const { restaurantId, id } = action.payload;
      const ridStr = String(restaurantId);
      const idx = state.users[0].accepted.findIndex(
        (a) => String(a.restaurantId) === ridStr && a.id == null,
      );
      if (idx >= 0) state.users[0].accepted[idx].id = id;
    },

    removeUserOption: (state, action) => {
      const id = String(action.payload);
      state.users[0].options = state.users[0].options.filter(
        (s) => String(s) !== id
      );
    },

    addUserOption: (state, action) => {
      const id = String(action.payload);
      if (!state.users[0].options.find((s) => String(s) === id)) {
        state.users[0].options = [...state.users[0].options, action.payload];
      }
    },

    archiveRestaurant: (state, action) => {
      const id = String(action.payload);
      if (!state.users[0].archived.includes(id)) {
        state.users[0].archived = [...state.users[0].archived, id];
      }
    },

    unarchiveRestaurant: (state, action) => {
      const id = String(action.payload);
      state.users[0].archived = state.users[0].archived.filter((a) => a !== id);
    },

    incrementFlipCount: (state) => {
      state.users[0].flipCount = (state.users[0].flipCount ?? 0) + 1;
    },

    setRestaurantNote: (state, action) => {
      const { restaurantId, text } = action.payload;
      const id = String(restaurantId);
      if (text.trim()) {
        state.users[0].notes[id] = text.trim();
      } else {
        delete state.users[0].notes[id];
      }
    },

    removeFromHistory: (state, action) => {
      const id = String(action.payload);
      state.users[0].accepted = state.users[0].accepted.filter(
        (a) => String(a.restaurantId) !== id
      );
      delete state.users[0].reviews[id];
      state.users[0].favorites = state.users[0].favorites.filter((f) => String(f) !== id);
      state.users[0].archived = state.users[0].archived.filter((a) => a !== id);
      state.users[0].options = state.users[0].options.filter((s) => String(s) !== id);
      if (state.users[0].notes) delete state.users[0].notes[id];
    },

    addCustomRestaurant: (state, action) => {
      const { id, data } = action.payload;
      state.customRestaurants[id] = data;
    },

    // Merges refreshed fields into an existing customRestaurants entry without clearing other fields
    updateCustomRestaurant: (state, action) => {
      const { id, data } = action.payload;
      if (state.customRestaurants[id]) {
        state.customRestaurants[id] = { ...state.customRestaurants[id], ...data };
      }
    },

    // Toggle a custom restaurant's opt-out flag for the Search-page
    // Place-match scan. Caller fires `api.restaurants.setMatchSettings`
    // server-side first, then dispatches this on success. Action
    // payload: { id, excludeFromPlaceMatching }.
    setMatchOptOut: (state, action) => {
      const { id, excludeFromPlaceMatching } = action.payload;
      const row = state.customRestaurants[String(id)];
      if (row) row.excludeFromPlaceMatching = !!excludeFromPlaceMatching;
    },

    // Migrate the user's references from a custom restaurant to a
    // Google Place restaurant. Server-side `link-to-place` endpoint
    // has already done the equivalent DB migration; this reducer
    // mirrors the change in Redux so the UI updates without a full
    // /me/all refetch. Payload: { customId, placeId }. Both as
    // numbers OR strings — we stringify before comparison since
    // the slice keys everything as strings.
    //
    // Steps (all on users[0]):
    //   1. Re-point ID arrays (favorites/options/archived) —
    //      replace customId with placeId, dedupe in case the place
    //      was already in that collection.
    //   2. Re-point accepted entries' restaurantId — multiple
    //      accept events may reference the same custom row; all
    //      get migrated.
    //   3. Re-key reviews dict — append custom-row reviews under
    //      the placeId key, delete the customId key.
    //   4. Re-key notes dict if a note was set on the custom row.
    //   5. Drop customRestaurants[customId] — caller should have
    //      already loaded customRestaurants[placeId] via materialize.
    mergeCustomIntoPlace: (state, action) => {
      const cId = String(action.payload.customId);
      const pId = String(action.payload.placeId);
      if (cId === pId) return;
      const u = state.users[0];
      if (!u) return;

      // Re-point ID arrays + dedupe (place might already be present).
      for (const key of ['favorites', 'options', 'archived']) {
        if (!Array.isArray(u[key])) continue;
        const remapped = u[key].map((id) => (String(id) === cId ? pId : String(id)));
        u[key] = [...new Set(remapped)];
      }

      // Re-point accepted entries (objects with restaurantId).
      if (Array.isArray(u.accepted)) {
        u.accepted = u.accepted.map((a) =>
          String(a.restaurantId) === cId ? { ...a, restaurantId: pId } : a,
        );
      }

      // Re-key reviews — concat in case both keys had entries.
      if (u.reviews && u.reviews[cId]) {
        u.reviews[pId] = [...(u.reviews[pId] ?? []), ...u.reviews[cId]];
        delete u.reviews[cId];
      }

      // Re-key notes — custom row's note becomes the place's note
      // unless the place already had one (rare; keep place's).
      if (u.notes && u.notes[cId]) {
        if (!u.notes[pId]) u.notes[pId] = u.notes[cId];
        delete u.notes[cId];
      }

      // Re-point favorite-list entries — the merged restaurant gets
      // membership of every list the custom row was in. If the
      // place is already in the same list, we drop the custom entry
      // and keep the place entry (which may have its own note).
      const cIdNum = Number(cId);
      const pIdNum = Number(pId);
      if (Number.isInteger(cIdNum) && Number.isInteger(pIdNum)) {
        for (const listId of state.favoriteLists.order) {
          const list = state.favoriteLists.byId[listId];
          if (!list) continue;
          const cEntryIdx = list.entries.findIndex((e) => e.restaurantId === cIdNum);
          if (cEntryIdx < 0) continue;
          const hasPlace = list.entries.some((e) => e.restaurantId === pIdNum);
          if (hasPlace) {
            // Place already there — drop the custom row, keep place.
            list.entries.splice(cEntryIdx, 1);
          } else {
            // Swap restaurantId in place; preserve note/addedAt.
            list.entries[cEntryIdx] = { ...list.entries[cEntryIdx], restaurantId: pIdNum };
          }
        }
      }

      // Drop the custom row from the restaurant map. The place row
      // should already be loaded (the caller materialized it before
      // calling link-to-place); if not, this is still safe — UI
      // just falls back to its self-fetch path in the detail modal.
      delete state.customRestaurants[cId];
    },

    // ── Multi-list favorites mutations ─────────────────────────
    // The slice keeps the lists in a normalized {byId, order, defaultId}
    // shape so selectors can scan O(lists) without re-sorting on every
    // read. Server is the source of truth on every write — the thunks /
    // call sites fire the network request first and dispatch these on
    // success. No optimistic-then-rollback yet; the writes are fast
    // enough that a brief "in-flight" feels fine.

    // Hydrate every list from /me/all or /me/favorite-lists. Sorts by
    // position so render order is stable regardless of array order
    // server returned. Re-derives defaultId — `isDefault` is the
    // source of truth, position is just display order.
    setFavoriteLists: (state, action) => {
      const lists = Array.isArray(action.payload) ? action.payload : [];
      const sorted = [...lists].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      state.favoriteLists.byId = {};
      for (const list of sorted) state.favoriteLists.byId[list.id] = list;
      state.favoriteLists.order     = sorted.map((l) => l.id);
      state.favoriteLists.defaultId = sorted.find((l) => l.isDefault)?.id ?? null;
    },

    // Insert-or-update one list (after create / update / promote).
    // Position is honored if present; we re-sort `order` to absorb
    // any reorder caused by an external update.
    upsertFavoriteList: (state, action) => {
      const list = action.payload;
      if (!list || typeof list.id !== 'number') return;
      const prev = state.favoriteLists.byId[list.id];
      // Preserve entries when the patch only carries metadata
      // (PATCH /favorite-lists/:id returns entries too, but the
      // promote endpoint also does — every server response is fully
      // hydrated, so this is mostly defensive).
      state.favoriteLists.byId[list.id] = {
        ...prev,
        ...list,
        entries: Array.isArray(list.entries) ? list.entries : (prev?.entries ?? []),
      };
      // Promoting one list to default clears the other defaults — we
      // mirror that here so the in-memory view stays consistent if
      // a single-list response came back without re-hydrating peers.
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
      // Re-sort by position so re-renders are stable.
      state.favoriteLists.order.sort((a, b) =>
        (state.favoriteLists.byId[a]?.position ?? 0) - (state.favoriteLists.byId[b]?.position ?? 0),
      );
    },

    // Drop a list (after DELETE). Server-side guard ensures the
    // default list can't be deleted, so we don't need to repair
    // defaultId here in the typical path — but we do defend
    // against a stale view by recomputing if we drop the default.
    removeFavoriteList: (state, action) => {
      const id = action.payload;
      if (id == null) return;
      delete state.favoriteLists.byId[id];
      state.favoriteLists.order = state.favoriteLists.order.filter((x) => x !== id);
      if (state.favoriteLists.defaultId === id) {
        state.favoriteLists.defaultId = state.favoriteLists.order[0] ?? null;
      }
    },

    // Add (or update) one entry inside a list. Idempotent — same
    // restaurantId twice updates the note without duplicating the row.
    addEntryToList: (state, action) => {
      const { listId, entry } = action.payload ?? {};
      const list = state.favoriteLists.byId[listId];
      if (!list || !entry) return;
      const idx = list.entries.findIndex((e) => e.restaurantId === entry.restaurantId);
      if (idx >= 0) list.entries[idx] = { ...list.entries[idx], ...entry };
      else list.entries = [entry, ...list.entries];
    },

    // Remove a single entry from a list. No-op when missing.
    removeEntryFromList: (state, action) => {
      const { listId, restaurantId } = action.payload ?? {};
      const list = state.favoriteLists.byId[listId];
      if (!list) return;
      list.entries = list.entries.filter((e) => e.restaurantId !== restaurantId);
    },

    // Apply a reorder result. Caller passes the order array used in
    // the PATCH; we re-stamp `position` on each list and rebuild
    // `order`. Lists not in the payload are left unchanged but
    // resorted (shouldn't happen — the server validates exact-set).
    setFavoriteListsOrder: (state, action) => {
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
    // `addresses` is included explicitly — leaving it out leaves the previous
    // user's address book stuck on the Search page until the next mount.
    clearUserData: (state) => {
      state.users[0] = {
        id: null, email: '', username: '', flipCount: 0,
        favorites: [], options: [], accepted: [], archived: [], reviews: {}, notes: {},
        addresses: [],
      };
      state.customRestaurants = {};
      state.favoriteLists = emptyFavoriteLists();
      state.isDataLoaded = false;
    },
  },
});

export const {
  setUserData,
  updateUserInfo,
  addUserReview,
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

/**
 * Fetches all user data from the API and hydrates users[0] in Redux.
 * @type {import('@reduxjs/toolkit').AsyncThunk<void, { id: number; email: string; username: string; flipCount?: number }, {}>}
 */
export const loadUserData = createAsyncThunk(
  'userInfo/loadUserData',
  async (user, { dispatch }) => {
  // /me/all ships a normalized response: one deduped `restaurants`
  // array + ID-only collection lists + multi-list favorites +
  // `apiVersion`. The previous loader had to walk five separate
  // per-collection arrays (each carrying full restaurant data) and
  // dedup client-side, AND it silently dropped accepted-only
  // restaurants because the accepted slot was thin. Both gone.
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
  } = await api.users.getAll();

  // Future-proofing: surface a console warning if we get a higher
  // apiVersion than this client knows how to consume. Doesn't fail
  // hard — additive shape changes stay forward-compatible — but
  // flags the case in dev logs. Bumped to >2 alongside the multi-
  // list favorites shape change.
  if (typeof apiVersion === 'number' && apiVersion > 2) {
    console.warn(`[loadUserData] /me/all responded with apiVersion ${apiVersion}; this client expects 2. Consider updating.`);
  }

  // Single pass over the deduped restaurants array — no dedup loop
  // needed, no map/filter chain over five collections.
  for (const r of restaurants) {
    dispatch(addCustomRestaurant({
      id: String(r.id),
      data: {
        name: r.name,
        type: r.cuisineType ?? 'Custom',
        price: r.priceLevel ?? 1,
        rating: r.googleRating != null ? Number(r.googleRating) : null,
        // Total Google ratings backing the average — surfaces
        // "(800)" alongside the star rating on cards/modals.
        ratingCount: r.ratingCount ?? null,
        // Address rendered in the Contact info grid on the modal
        // + the address line on the Search card.
        address: r.address ?? null,
        // null (not 'N/A') for missing values — downstream UIs do
        // truthiness checks to skip empty rows, so a literal "N/A"
        // would render as visible text. Yelp dropped — no UI uses it.
        hours:   r.hours   ?? null,
        phone:   r.phone   ?? null,
        website: r.website ?? null,
        takeout: r.takeout ?? false,
        delivery: r.delivery ?? false,
        googlePlaceId: r.googlePlaceId ?? null,
        // Coords for the Compare-page map. Custom user-typed rows
        // have null here and stay off the map.
        lat: r.lat ?? null,
        lng: r.lng ?? null,
        // Cached Google Places photos array. Empty for custom rows
        // or legacy rows pre-rollout. Card consumers gate on
        // `photos.length > 0` before rendering the carousel.
        photos: Array.isArray(r.photos) ? r.photos : [],
        // Structured weekly hours — drives the open-now /
        // closing-soon badge and the collapsible hours table.
        regularOpeningHours: r.regularOpeningHours ?? null,
        // Per-row opt-out for the Search page's post-search
        // Place-match scan. Always false for Google-sourced rows
        // (they can't match themselves); legacy rows pre-rollout
        // default false until the user toggles them.
        excludeFromPlaceMatching: r.excludeFromPlaceMatching ?? false,
        // Timestamp of the last Google data refresh — drives the
        // "Google data updated X ago" hint on the detail modal.
        // Null for custom rows + legacy rows.
        googleDataUpdatedAt: r.googleDataUpdatedAt ?? null,
      },
    }));
  }

  dispatch(setUserData({
    id: user.id,
    email: user.email,
    username: user.username,
    addresses: addresses ?? [],
    flipCount: user.flipCount ?? 0,
    // ID lists arrive pre-deduped + ordered from the server, so we
    // just stringify (the slice keeps everything as strings to
    // tolerate both numeric and `local-…` guest IDs in the same field).
    favorites: favoriteIds.map(String),
    options:   optionIds.map(String),
    archived:  archivedIds.map(String),
    accepted: acceptedEntries.map((a) => ({
      // Server row id. Needed by the per-entry insights toggle
      // (PATCH /me/accepted/:id). Pre-rollout server builds that
      // don't yet ship `id` fall back to null — the toggle simply
      // becomes a no-op for those rows until the next /me/all refresh.
      id: a.id ?? null,
      restaurantId: String(a.restaurantId),
      date: a.acceptedAt,
      // Pre-rollout server builds also won't ship excludeFromInsights;
      // the column default is false, so coercing here gives every
      // row a stable boolean instead of a sometimes-missing field.
      excludeFromInsights: Boolean(a.excludeFromInsights),
    })),
    reviews: reviews.reduce((acc, r) => {
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

  // Multi-list favorites. /me/all always sends `favoriteLists`
  // on apiVersion ≥ 2, including a single default list for users
  // who don't have any custom lists yet. Empty array fallback
  // handles the (impossible-in-practice) case of an old server
  // still on v1 — the heart icon will still work via the legacy
  // favorites array.
  dispatch(setFavoriteLists(Array.isArray(favoriteLists) ? favoriteLists : []));

  // Fire stale-data refresh in the background — don't await, failures are non-fatal
  dispatch(refreshStaleRestaurants());
  dispatch(setDataLoaded());
  },
  { condition: (_, { getState }) => !getState().userInfo.isDataLoaded }
);

// Fetches refreshed Place data for stale restaurants and merges into
// Redux. Every field the initial /me/all loader sets must also be
// mirrored here — otherwise a row that's missing data on first load
// (e.g. backfilled photos null) stays missing in Redux even after
// the server refreshes the DB row, because Redux only repopulates
// from the refresh response.
export const refreshStaleRestaurants = createAsyncThunk(
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
            // Refreshed weekly hours overwrite whatever was previously
            // cached. Null fallback so a row that no longer returns
            // hours from Google goes back to "no schedule available"
            // instead of holding stale data forever.
            regularOpeningHours: r.regularOpeningHours ?? null,
            // Photos were previously omitted here — the bug that
            // left old-but-recently-refreshed rows photo-less in
            // Redux even when the DB had fresh photos. Empty array
            // (not null) to keep the shape stable for consumers
            // that do `photos.length` or `.find(...)`.
            photos: Array.isArray(r.photos) ? r.photos : [],
            takeout: r.takeout ?? false,
            delivery: r.delivery ?? false,
            googlePlaceId: r.googlePlaceId ?? null,
            // Coords mirrored so the Compare map updates when a row
            // gets backfilled lat/lng from a refresh.
            lat: r.lat ?? null,
            lng: r.lng ?? null,
            // Mirror the timestamp + opt-out flag so the "Updated X
            // ago" hint and the post-search match-skip flag stay
            // current after a refresh.
            googleDataUpdatedAt: r.googleDataUpdatedAt ?? null,
            excludeFromPlaceMatching: r.excludeFromPlaceMatching ?? false,
          },
        }));
      }
    } catch (err) {
      // Non-fatal — stale data is better than a broken session
      console.warn('[refresh] Stale restaurant refresh failed:', err);
    }
  }
);

/**
 * Persists a new review and stores it in Redux with the API id (or a local id for guests).
 * @type {import('@reduxjs/toolkit').AsyncThunk<void, { restaurantId: string | number; userId: number; content: string; rating: number; date: string }, {}>}
 */
export const persistAddReview = createAsyncThunk(
  'userInfo/persistAddReview',
  async ({ restaurantId, userId, content, rating, date }, { dispatch, getState }) => {
    const isAuthenticated = getState().auth?.status === 'authenticated';
    if (!isAuthenticated) {
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

// Optimistic toggle of the InsightsPage opt-out flag on a single accepted
// row. Updates Redux first for instant UI feedback, fires the PATCH, and
// rolls back on failure. Server is the source of truth — its returned
// boolean overrides ours if there's any drift (shouldn't happen in normal
// flow but defends against a race with another tab).
//
// Returns the new flag value on success; throws the underlying error on
// failure (callers may show a toast). No-ops if the entry isn't found
// locally or its `id` is null (optimistic-not-yet-reconciled row).
export const toggleAcceptedExcludeFromInsights = createAsyncThunk(
  'userInfo/toggleAcceptedExcludeFromInsights',
  async ({ acceptedId, excludeFromInsights }, { dispatch, getState }) => {
    if (acceptedId == null) return;
    const before = getState().userInfo.users[0].accepted.find((a) => a.id === acceptedId);
    if (!before) return;

    // Optimistic local flip — feels instant; the kebab item's checkmark
    // updates before the network roundtrip completes.
    dispatch(setAcceptedExcludeFromInsights({ id: acceptedId, excludeFromInsights }));
    try {
      const { accepted } = await api.users.setAcceptedExcludeFromInsights(acceptedId, excludeFromInsights);
      // Reconcile with the server's canonical value (paranoia — should
      // match what we just sent unless another tab raced us).
      dispatch(setAcceptedExcludeFromInsights({
        id: acceptedId,
        excludeFromInsights: accepted.excludeFromInsights,
      }));
      return accepted.excludeFromInsights;
    } catch (err) {
      // Roll back so the UI reflects reality. The kebab item's label
      // flips back; any toast surface can read the rejection.
      dispatch(setAcceptedExcludeFromInsights({
        id: acceptedId,
        excludeFromInsights: before.excludeFromInsights,
      }));
      throw err;
    }
  },
);

export default userInfoSlice.reducer;
