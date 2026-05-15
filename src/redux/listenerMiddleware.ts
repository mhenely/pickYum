import { createListenerMiddleware, type TypedStartListening } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import type { RootState, AppDispatch } from './store';
import {
  updateUserFavorites,
  addUserOption,
  removeUserOption,
  addUserAcceptance,
  removeUserReview,
  removeFromHistory,
  updateUserInfo,
  archiveRestaurant,
  unarchiveRestaurant,
  incrementFlipCount,
  setUserData,
  clearUserData,
  loadUserData,
} from './slices/userInfoSlice';
import { checkAuth, loginUser, registerUser, logoutUser } from './slices/authSlice';

export const listenerMiddleware = createListenerMiddleware();

type AppStartListening = TypedStartListening<RootState, AppDispatch>;
const listen = listenerMiddleware.startListening as AppStartListening;

// Custom restaurant IDs are local-only (e.g. "custom-1234567890") and have no
// corresponding DB row. Skip API calls for anything that isn't a plain integer.
const isDbId = (id: unknown): boolean => Number.isInteger(Number(id)) && Number(id) > 0;

// Helper accepts anything with a getState() — keeps tests cheap to mock.
const isGuest = (listenerApi: { getState: () => RootState }): boolean =>
  listenerApi.getState().auth.status !== 'authenticated';

const emptyUserData = (user: { id: number; email: string; username: string; flipCount?: number }) => ({
  id: user.id,
  email: user.email,
  username: user.username,
  flipCount: user.flipCount ?? 0,
  favorites: [] as string[],
  options: [] as string[],
  accepted: [] as never[],
  archived: [] as string[],
  reviews: {} as Record<string, never[]>,
});

// Login: immediately populate identity so components never see null, then load app data
listen({
  actionCreator: loginUser.fulfilled,
  effect: (_action, api_) => {
    try { localStorage.removeItem('pickyum_guest'); } catch { /* ignore */ }
    api_.dispatch(setUserData(emptyUserData(_action.payload)));
    api_.dispatch(loadUserData(_action.payload));
  },
});

// Register: new account has no data; just populate identity and skip the load
listen({
  actionCreator: registerUser.fulfilled,
  effect: (_action, api_) => {
    try { localStorage.removeItem('pickyum_guest'); } catch { /* ignore */ }
    api_.dispatch(setUserData(emptyUserData(_action.payload)));
  },
});

// Session restore: user already identified; load their data from API
listen({
  actionCreator: checkAuth.fulfilled,
  effect: (_action, api_) => {
    try { localStorage.removeItem('pickyum_guest'); } catch { /* ignore */ }
    api_.dispatch(loadUserData(_action.payload));
  },
});

// Logout: clear all user data so the next login triggers a fresh load.
// Fires on BOTH fulfilled and rejected — a 5xx on the API call shouldn't
// leave the previous user's favorites/options/reviews visible on a shared
// device. The auth slice mirrors this by transitioning to 'unauthenticated'
// on rejection too. The cookie may still be valid server-side; next mount's
// checkAuth resolves that.
listen({
  actionCreator: logoutUser.fulfilled,
  effect: (_, api_) => {
    api_.dispatch(clearUserData());
  },
});
listen({
  actionCreator: logoutUser.rejected,
  effect: (_, api_) => {
    api_.dispatch(clearUserData());
  },
});

// Favorites toggle — check previous state to know add vs remove
listen({
  actionCreator: updateUserFavorites,
  effect: async (action, listenerApi) => {
    if (isGuest(listenerApi)) return;
    const { restaurantId } = action.payload;
    if (!isDbId(restaurantId)) return;
    const prevState = listenerApi.getOriginalState();
    const wasFavorited = prevState.userInfo.users[0].favorites
      .map(String)
      .includes(String(restaurantId));
    if (!wasFavorited) {
      const state = listenerApi.getState();
      if (!state.userInfo.customRestaurants[String(restaurantId)]) return;
    }
    try {
      if (wasFavorited) {
        await api.users.removeFavorite(Number(restaurantId));
      } else {
        await api.users.addFavorite(Number(restaurantId));
      }
    } catch (err) {
      console.error('Failed to sync favorite:', err);
    }
  },
});

// Options
listen({
  actionCreator: addUserOption,
  effect: async (action, listenerApi) => {
    if (isGuest(listenerApi)) return;
    if (!isDbId(action.payload)) return;
    const state = listenerApi.getState();
    if (!state.userInfo.customRestaurants[String(action.payload)]) return;
    try {
      await api.users.addOption(Number(action.payload));
    } catch (err) {
      console.error('Failed to sync option add:', err);
    }
  },
});
listen({
  actionCreator: removeUserOption,
  effect: async (action, listenerApi) => {
    if (isGuest(listenerApi)) return;
    if (!isDbId(action.payload)) return;
    try {
      await api.users.removeOption(Number(action.payload));
    } catch (err) {
      console.error('Failed to sync option remove:', err);
    }
  },
});

// Accepted history. For solo accepts, the listener writes to the API. For
// group accepts the server's accept-result endpoint already creates the row
// (with optionsSnapshot + chooseMethod), so the dispatch site sets
// `_serverHandled: true` and we skip the API write to avoid a duplicate. Local
// Redux state still updates either way so the UI feels instant.
listen({
  actionCreator: addUserAcceptance,
  effect: async (action, listenerApi) => {
    if (isGuest(listenerApi)) return;
    const { restaurantId, optionsSnapshot, chooseMethod, _serverHandled } = action.payload;
    if (_serverHandled) return;
    if (!isDbId(restaurantId)) return;
    try {
      await api.users.addAccepted(Number(restaurantId), { optionsSnapshot, chooseMethod });
    } catch (err) {
      console.error('Failed to sync accepted:', err);
    }
  },
});

// Review deletion — payload carries the review id directly (server int or local string)
listen({
  actionCreator: removeUserReview,
  effect: async (action, listenerApi) => {
    if (isGuest(listenerApi)) return;
    const { id } = action.payload as { id: number | string };
    // Local-only ids (from guest mode that later signed in) have no server row to delete.
    if (typeof id !== 'number') return;
    try {
      await api.users.deleteReview(id);
    } catch (err) {
      console.error('Failed to sync review delete:', err);
    }
  },
});

// History wipe — server endpoint atomically removes favorites/options/archived/accepted/reviews
listen({
  actionCreator: removeFromHistory,
  effect: async (action, listenerApi) => {
    if (isGuest(listenerApi)) return;
    if (!isDbId(action.payload)) return;
    try {
      await api.users.removeFromHistory(Number(action.payload));
    } catch (err) {
      console.error('Failed to sync history remove:', err);
    }
  },
});

// Profile update
listen({
  actionCreator: updateUserInfo,
  effect: async (action, listenerApi) => {
    if (isGuest(listenerApi)) return;
    const { username, email, password } = action.payload;
    if (!username && !email && !password) return;
    try {
      await api.users.updateProfile({
        ...(username && { username }),
        ...(email && { email }),
        ...(password && { password }),
      });
    } catch (err) {
      console.error('Failed to sync profile update:', err);
    }
  },
});

// Archive / unarchive
listen({
  actionCreator: archiveRestaurant,
  effect: async (action, listenerApi) => {
    if (isGuest(listenerApi)) return;
    if (!isDbId(action.payload)) return;
    const state = listenerApi.getState();
    if (!state.userInfo.customRestaurants[String(action.payload)]) return;
    try {
      await api.users.archiveRestaurant(Number(action.payload));
    } catch (err) {
      console.error('Failed to sync archive:', err);
    }
  },
});
listen({
  actionCreator: unarchiveRestaurant,
  effect: async (action, listenerApi) => {
    if (isGuest(listenerApi)) return;
    if (!isDbId(action.payload)) return;
    try {
      await api.users.unarchiveRestaurant(Number(action.payload));
    } catch (err) {
      console.error('Failed to sync unarchive:', err);
    }
  },
});

// Flip / spin counter
listen({
  actionCreator: incrementFlipCount,
  effect: async (_action, listenerApi) => {
    if (isGuest(listenerApi)) return;
    try {
      await api.users.recordFlip();
    } catch (err) {
      console.error('Failed to sync flip count:', err);
    }
  },
});
