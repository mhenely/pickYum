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
      if (state.users[0].favorites.find((f) => String(f) === id)) {
        state.users[0].favorites = state.users[0].favorites.filter((f) => String(f) !== id);
      } else {
        state.users[0].favorites = [...state.users[0].favorites, restaurantId];
      }
    },

    addUserAcceptance: (state, action) => {
      // Callers pass restaurantId as a Number (GroupSessionPage parses
      // session.result through Number()) or a String (HelpMeChoosePage,
      // custom IDs). Every downstream consumer normalizes with String(...)
      // before lookup, so storing strings here at the reducer boundary
      // eliminates the recurring foot-gun without touching consumers.
      const { restaurantId } = action.payload;
      state.users[0].accepted = [
        ...state.users[0].accepted,
        { restaurantId: String(restaurantId), date: new Date().toLocaleDateString() },
      ];
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
  removeUserOption,
  addUserOption,
  archiveRestaurant,
  unarchiveRestaurant,
  removeFromHistory,
  setRestaurantNote,
  addCustomRestaurant,
  updateCustomRestaurant,
  incrementFlipCount,
  setDataLoaded,
  clearUserData,
  setAddresses,
  addAddress,
  updateAddress,
  removeAddress,
} = userInfoSlice.actions;

/**
 * Fetches all user data from the API and hydrates users[0] in Redux.
 * @type {import('@reduxjs/toolkit').AsyncThunk<void, { id: number; email: string; username: string; flipCount?: number }, {}>}
 */
export const loadUserData = createAsyncThunk(
  'userInfo/loadUserData',
  async (user, { dispatch }) => {
  const { favorites, options, accepted, archived, reviews, addresses } = await api.users.getAll();

  // Collect all unique restaurants from API responses
  const allApiRestaurants = [
    ...favorites,
    ...options,
    ...archived,
    ...accepted.map((a) => a.restaurant),
    ...reviews.map((r) => r.restaurant),
  ].filter(Boolean);

  const seen = new Set();
  for (const r of allApiRestaurants) {
    const id = String(r.id);
    if (!seen.has(id)) {
      seen.add(id);
      dispatch(addCustomRestaurant({
        id,
        data: {
          name: r.name,
          type: r.cuisineType ?? 'Custom',
          price: r.priceLevel ?? 1,
          rating: r.googleRating != null ? Number(r.googleRating) : null,
          // Total Google ratings backing the average. Surfaced so cards
          // (Search saved, Compare, Choose) can show "(800)" alongside
          // the star rating — matches the nearby-search experience.
          ratingCount: r.ratingCount ?? null,
          // Address surfaced from the loader so Compare/Choose cards
          // display the same content as Search cards. Was previously
          // omitted because those pages didn't render an address line.
          address: r.address ?? null,
          // null (not 'N/A') for missing values — downstream cards and
          // modals do truthiness checks to decide whether to render the
          // row, so a literal "N/A" string would render as visible text.
          // Yelp is intentionally dropped from the projection — we no
          // longer surface it in any UI surface.
          hours:   r.hours   ?? null,
          phone:   r.phone   ?? null,
          website: r.website ?? null,
          takeout: r.takeout ?? false,
          delivery: r.delivery ?? false,
          googlePlaceId: r.googlePlaceId ?? null,
          // Coords from /me/all so the Compare-page map can render
          // pins for saved restaurants without re-fetching. Custom
          // (user-typed) rows have null here and stay off the map.
          lat: r.lat ?? null,
          lng: r.lng ?? null,
          // Cached Google Places photos. Empty array for custom rows /
          // legacy rows pre-rollout. Card consumers do `photos.length > 0`
          // to decide whether to render the thumb. Reviews are NOT
          // loaded — the UI links out to Google Maps for full reviews
          // instead (see googleMapsUrl utility).
          photos: Array.isArray(r.photos) ? r.photos : [],
          // Structured weekly opening hours — periods drive the
          // open-now / closing-soon badge in the detail modal,
          // weekdayDescriptions render the hours table. Null when
          // Google didn't return any (or for custom rows).
          regularOpeningHours: r.regularOpeningHours ?? null,
        },
      }));
    }
  }

  dispatch(setUserData({
    id: user.id,
    email: user.email,
    username: user.username,
    addresses: addresses ?? [],
    flipCount: user.flipCount ?? 0,
    favorites: favorites.map((r) => String(r.id)),
    options: options.map((r) => String(r.id)),
    archived: archived.map((r) => String(r.id)),
    accepted: accepted.map((a) => ({
      restaurantId: String(a.restaurantId),
      date: a.acceptedAt,
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

  // Fire stale-data refresh in the background — don't await, failures are non-fatal
  dispatch(refreshStaleRestaurants());
  dispatch(setDataLoaded());
  },
  { condition: (_, { getState }) => !getState().userInfo.isDataLoaded }
);

// Fetches refreshed Place data for stale restaurants and merges into Redux
export const refreshStaleRestaurants = createAsyncThunk(
  'userInfo/refreshStaleRestaurants',
  async (_, { dispatch }) => {
    try {
      const { updated } = await api.users.refreshPlaces();
      for (const r of updated) {
        dispatch(updateCustomRestaurant({
          id: String(r.id),
          data: {
            name: r.name,
            type: r.cuisineType ?? 'Custom',
            price: r.priceLevel ?? 1,
            rating: r.googleRating != null ? Number(r.googleRating) : null,
            // Mirror the null-fallback used in the initial loader so
            // post-refresh data behaves the same downstream (see loader
            // for the rationale). Yelp dropped — no UI surface uses it.
            hours:   r.hours   ?? null,
            phone:   r.phone   ?? null,
            website: r.website ?? null,
            // Refreshed weekly hours overwrite whatever was previously
            // cached. Null fallback so a row that no longer returns
            // hours from Google goes back to "no schedule available"
            // instead of holding stale data forever.
            regularOpeningHours: r.regularOpeningHours ?? null,
            takeout: r.takeout ?? false,
            delivery: r.delivery ?? false,
            googlePlaceId: r.googlePlaceId ?? null,
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

export default userInfoSlice.reducer;
