import { createListenerMiddleware, type TypedStartListening } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import type { RootState, AppDispatch } from './store';
import {
  updateUserFavorites,
  addUserOption,
  removeUserOption,
  addUserAcceptance,
  reconcileAcceptedRowId,
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
import { syncWithFeedback } from './syncHelper';

export const listenerMiddleware = createListenerMiddleware();

type AppStartListening = TypedStartListening<RootState, AppDispatch>;
const listen = listenerMiddleware.startListening as AppStartListening;

// Custom restaurant IDs are local-only (e.g. "custom-1234567890") and have no
// corresponding DB row. Skip API calls for anything that isn't a plain integer.
// `isDbId` is centralized in utils/resourceId.ts — this file used to inline
// the same predicate, but the dichotomy is needed in enough places (and
// gets a follow-up complement `isLocalId`) that lifting it to a shared
// helper made sense. See TIER_2_3_PLAN.md #11.
import { isDbId } from '../utils/resourceId';

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

// Session restore: user already identified; populate identity
// immediately (mirroring the login path) so components that read
// userInfo.username / .email — the delete-account confirm modal, the
// change-username placeholder, etc. — have correct values before
// loadUserData's network round-trip resolves. Previously, only
// loadUserData was dispatched here, which meant any UI rendered
// before the GET /me/all promise settled saw the slice's empty
// initial values (id: null, email: '', username: '').
listen({
  actionCreator: checkAuth.fulfilled,
  effect: (_action, api_) => {
    try { localStorage.removeItem('pickyum_guest'); } catch { /* ignore */ }
    api_.dispatch(setUserData(emptyUserData(_action.payload)));
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

// ── Background sync listeners ─────────────────────────────────
// Every effect below routes through `syncWithFeedback` instead of the
// old `try { ... } catch (err) { console.error(...) }` pattern. That
// gives every mutation: retry on transient errors, Sentry capture on
// final failure, and a visible toast surface (see <Toaster>) so the
// user knows when their action didn't actually persist.
//
// `silent: true` is used only for telemetry-style writes where the
// user doesn't care about the result (flip-count increment). Everything
// the user "did" (favorite, accept, remove, archive) surfaces a toast.

// Favorites toggle. The action originates from the heart icon
// (now `<HeartWithKebab>`) and toggles the user's DEFAULT FavoriteList
// membership server-side. The Redux reducer has already updated
// `user.favorites` for legacy consumers AND mirrored the entry
// into `favoriteLists.byId[defaultId]`, so the listener's job is
// purely to persist the change.
//
// Routing logic:
//   - Authed + default list exists → POST/DELETE the new
//     /me/favorite-lists/:id/entries endpoint. This also mirrors
//     server-side into `user_favorites`, so the legacy table stays
//     consistent for any reader (insights, /me/all derivation, etc).
//   - Authed + no default list yet → fall back to the legacy
//     /me/favorites endpoint. Should be effectively impossible
//     post-rollout (ensureDefaultFavoriteList is called on register
//     and /me/favorite-lists hydration), but the fallback prevents
//     a heart click from being a silent no-op if the new hierarchy
//     is somehow absent.
//   - Guests → handled by the early isGuest() return.
listen({
  actionCreator: updateUserFavorites,
  effect: async (action, listenerApi) => {
    if (isGuest(listenerApi)) return;
    const { restaurantId } = action.payload;
    if (!isDbId(restaurantId)) return;
    const prevState = listenerApi.getOriginalState();
    const wasFavorited = prevState.userInfo.user.favorites
      .map(String)
      .includes(String(restaurantId));
    if (!wasFavorited) {
      const state = listenerApi.getState();
      if (!state.userInfo.customRestaurants[String(restaurantId)]) return;
    }
    const defaultId = listenerApi.getState().userInfo.favoriteLists?.defaultId ?? null;
    const numericId = Number(restaurantId);
    await syncWithFeedback(listenerApi, {
      label: wasFavorited ? 'Removing from favorites' : 'Adding to favorites',
      context: { feature: 'favorites', action: wasFavorited ? 'remove' : 'add', restaurantId: numericId },
      call: async () => {
        if (defaultId) {
          if (wasFavorited) await api.users.removeFavoriteListEntry(defaultId, numericId);
          else              await api.users.addFavoriteListEntry(defaultId, { restaurantId: numericId });
        } else if (wasFavorited) {
          await api.users.removeFavorite(numericId);
        } else {
          await api.users.addFavorite(numericId);
        }
      },
      // No rollback here yet: heart toggle is symmetric, and the user
      // can click again to re-toggle if the error toast surfaces. A
      // future enhancement would dispatch updateUserFavorites again on
      // rollback, but that fires the same listener and risks a loop —
      // safer to leave manual.
    });
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
    await syncWithFeedback(listenerApi, {
      label: 'Adding to selections',
      context: { feature: 'options', action: 'add', restaurantId: Number(action.payload) },
      call: () => api.users.addOption(Number(action.payload)),
    });
  },
});
listen({
  actionCreator: removeUserOption,
  effect: async (action, listenerApi) => {
    if (isGuest(listenerApi)) return;
    if (!isDbId(action.payload)) return;
    await syncWithFeedback(listenerApi, {
      label: 'Removing from selections',
      context: { feature: 'options', action: 'remove', restaurantId: Number(action.payload) },
      call: () => api.users.removeOption(Number(action.payload)),
    });
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
    await syncWithFeedback(listenerApi, {
      label: 'Recording your pick',
      context: { feature: 'accepted', restaurantId: Number(restaurantId), chooseMethod: chooseMethod ?? 'none' },
      call: () => api.users.addAccepted(Number(restaurantId), { optionsSnapshot, chooseMethod }),
      onSuccess: ({ accepted }) => {
        // Backfill the server row id onto the optimistic local entry so
        // the InsightsPage toggle can target this row without waiting for
        // the next /me/all refresh. Only fires on success — failed POSTs
        // leave the optimistic entry with id=null until /me/all reconciles.
        listenerApi.dispatch(reconcileAcceptedRowId({ restaurantId, id: accepted.id }));
      },
    });
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
    await syncWithFeedback(listenerApi, {
      label: 'Deleting review',
      context: { feature: 'reviews', action: 'delete', reviewId: id },
      call: () => api.users.deleteReview(id),
    });
  },
});

// History wipe — server endpoint atomically removes favorites/options/archived/accepted/reviews
listen({
  actionCreator: removeFromHistory,
  effect: async (action, listenerApi) => {
    if (isGuest(listenerApi)) return;
    if (!isDbId(action.payload)) return;
    await syncWithFeedback(listenerApi, {
      label: 'Removing from history',
      context: { feature: 'history', action: 'remove', restaurantId: Number(action.payload) },
      call: () => api.users.removeFromHistory(Number(action.payload)),
    });
  },
});

// Profile update
listen({
  actionCreator: updateUserInfo,
  effect: async (action, listenerApi) => {
    if (isGuest(listenerApi)) return;
    // The slice's payload type is `Partial<UserState> & Record<string, unknown>`
    // so it tolerates ad-hoc fields. We narrow each field to string here
    // before forwarding — anything non-string is silently ignored.
    const payload = action.payload as Record<string, unknown>;
    const username = typeof payload.username === 'string' ? payload.username : '';
    const email    = typeof payload.email    === 'string' ? payload.email    : '';
    const password = typeof payload.password === 'string' ? payload.password : '';
    if (!username && !email && !password) return;
    await syncWithFeedback(listenerApi, {
      // Profile changes are the most user-visible mutation — a
      // misleading toast here ("saved!" when it failed) would be
      // particularly bad. syncWithFeedback only emits success after
      // the API resolves, so the user never sees a green check on a
      // failed update.
      label: 'Saving profile',
      context: {
        feature: 'profile',
        fieldsChanged: [username && 'username', email && 'email', password && 'password']
          .filter(Boolean)
          .join(','),
      },
      call: () => {
        // Build the payload as a typed object literal instead of
        // spreading conditionals. The previous shape used
        // `...(field && { field })`, which is fragile under TS — an
        // empty string short-circuits to "" (illegal as a spread
        // source) and the ternary fallback narrows too aggressively.
        const body: { username?: string; email?: string; password?: string } = {};
        if (username) body.username = username;
        if (email)    body.email    = email;
        if (password) body.password = password;
        return api.users.updateProfile(body);
      },
    });
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
    await syncWithFeedback(listenerApi, {
      label: 'Archiving',
      context: { feature: 'archive', action: 'add', restaurantId: Number(action.payload) },
      call: () => api.users.archiveRestaurant(Number(action.payload)),
    });
  },
});
listen({
  actionCreator: unarchiveRestaurant,
  effect: async (action, listenerApi) => {
    if (isGuest(listenerApi)) return;
    if (!isDbId(action.payload)) return;
    await syncWithFeedback(listenerApi, {
      label: 'Restoring',
      context: { feature: 'archive', action: 'remove', restaurantId: Number(action.payload) },
      call: () => api.users.unarchiveRestaurant(Number(action.payload)),
    });
  },
});

// Flip / spin counter. Telemetry-style write — the user has already
// seen the coin land; a failed increment is invisible to them and
// doesn't change anything they care about. `silent: true` skips the
// toast push but keeps Sentry capture so we can see if these start
// failing at unusual rates.
listen({
  actionCreator: incrementFlipCount,
  effect: async (_action, listenerApi) => {
    if (isGuest(listenerApi)) return;
    await syncWithFeedback(listenerApi, {
      label: 'Recording flip',
      silent: true,
      context: { feature: 'flipCount' },
      call: () => api.users.recordFlip(),
    });
  },
});
