import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import { api } from "../../lib/api";

const loadGuestData = () => {
  try {
    const raw = localStorage.getItem('pickyum_guest');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};

const savedGuest = typeof window !== 'undefined' ? loadGuestData() : null;

const initialState = {
  users: [
    {
      id: null,
      email: '',
      username: '',
      flipCount:  savedGuest?.flipCount  ?? 0,
      favorites:  savedGuest?.favorites  ?? [],
      selections: savedGuest?.selections ?? [],
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
    // Hydrates users[0] from API data after login/session restore
    setUserData: (state, action) => {
      const { id, email, username, flipCount, favorites, selections, accepted, archived, reviews } = action.payload;
      state.users[0] = {
        ...state.users[0],
        id,
        email,
        username,
        flipCount: flipCount ?? 0,
        favorites: favorites ?? [],
        selections: selections ?? [],
        accepted: accepted ?? [],
        archived: archived ?? [],
        reviews: reviews ?? {},
      };
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
      const { restaurantId } = action.payload;
      state.users[0].accepted = [
        ...state.users[0].accepted,
        { restaurantId, date: new Date().toLocaleDateString() },
      ];
    },

    removeUserSelection: (state, action) => {
      const id = String(action.payload);
      state.users[0].selections = state.users[0].selections.filter(
        (s) => String(s) !== id
      );
    },

    addUserSelection: (state, action) => {
      const id = String(action.payload);
      if (!state.users[0].selections.find((s) => String(s) === id)) {
        state.users[0].selections = [...state.users[0].selections, action.payload];
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
      state.users[0].selections = state.users[0].selections.filter((s) => String(s) !== id);
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

    // Resets all user data on logout so the next login triggers a fresh load
    clearUserData: (state) => {
      state.users[0] = {
        id: null, email: '', username: '', flipCount: 0,
        favorites: [], selections: [], accepted: [], archived: [], reviews: {}, notes: {},
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
  removeUserSelection,
  addUserSelection,
  archiveRestaurant,
  unarchiveRestaurant,
  removeFromHistory,
  setRestaurantNote,
  addCustomRestaurant,
  updateCustomRestaurant,
  incrementFlipCount,
  setDataLoaded,
  clearUserData,
} = userInfoSlice.actions;

// Fetches all user data from the API and hydrates users[0] in Redux
export const loadUserData = createAsyncThunk(
  'userInfo/loadUserData',
  async (user, { dispatch }) => {
  const { favorites, selections, accepted, archived, reviews } = await api.users.getAll();

  // Collect all unique restaurants from API responses
  const allApiRestaurants = [
    ...favorites,
    ...selections,
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
          hours: r.hours ?? 'N/A',
          phone: r.phone ?? 'N/A',
          website: r.website ?? 'N/A',
          yelp: r.yelpUrl ?? 'N/A',
          takeout: r.takeout ?? false,
          delivery: r.delivery ?? false,
          googlePlaceId: r.googlePlaceId ?? null,
        },
      }));
    }
  }

  dispatch(setUserData({
    id: user.id,
    email: user.email,
    username: user.username,
    flipCount: user.flipCount ?? 0,
    favorites: favorites.map((r) => String(r.id)),
    selections: selections.map((r) => String(r.id)),
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
            hours: r.hours ?? 'N/A',
            phone: r.phone ?? 'N/A',
            website: r.website ?? 'N/A',
            yelp: r.yelpUrl ?? 'N/A',
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

// Persists a new review and stores it in Redux with the API id (or a local id for guests)
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
