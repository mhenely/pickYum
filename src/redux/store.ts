import { configureStore } from "@reduxjs/toolkit";
import userInfoReducer from "./slices/userInfoSlice";
import chooseModalReducer from "./slices/chooseModalSlice";
import authReducer from "./slices/authSlice";
import ratingReducer from "./slices/ratingSlice";
import searchReducer from "./slices/searchSlice";
import celebrationReducer from "./slices/celebrationSlice";
import { listenerMiddleware } from "./listenerMiddleware";

const store = configureStore({
  reducer: {
    auth: authReducer,
    userInfo: userInfoReducer,
    chooseModal: chooseModalReducer,
    rating: ratingReducer,
    search: searchReducer,
    // Transient UI state for the post-Choose-Now celebration modal.
    // Not persisted to localStorage — it's a popup, not user data.
    celebration: celebrationReducer,
  },
  middleware: (getDefault) =>
    getDefault().prepend(listenerMiddleware.middleware),
});

export type RootState   = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// Persist guest-mode state to localStorage so unauthenticated users keep their
// favorites/options/etc. across page reloads. Authenticated users skip this
// path — their data is the server's source of truth.
//
// 300 ms debounce: keeps subscribe cheap during burst dispatches (e.g. loading
// a list of restaurants fires one action per item) without losing the most
// recent state on tab close. Anything < ~100 ms hits localStorage on every
// dispatch; > ~500 ms risks losing data on rapid close.
const GUEST_PERSIST_DEBOUNCE_MS = 300;

let persistTimer: ReturnType<typeof setTimeout> | null = null;

// Helper: the persist subscribe must NOT snapshot the previous authed user's
// state into `pickyum_guest` during the brief window between
// logoutUser.fulfilled (status → 'unauthenticated') and clearUserData
// running. The hop is normally microsecond-scale because the listener
// middleware fires immediately, but a slow tick or long task could let the
// 300 ms debounce window catch the still-populated state. We gate on the
// `isDataLoaded` flag: it's set only after `loadUserData` succeeds and is
// reset by `clearUserData`. Status 'unauthenticated' + isDataLoaded=true
// is exactly the inconsistent window we want to skip.
function shouldPersistGuest(state: ReturnType<typeof store.getState>): boolean {
  if (state.auth.status === 'authenticated') return false;
  // Idle/loading: nothing meaningful to persist yet (checkAuth hasn't run).
  if (state.auth.status !== 'unauthenticated') return false;
  // The transition gap — logout dispatched, status flipped, clearUserData
  // not yet run. Skip; the next dispatch (clearUserData) will land us in a
  // safe state and re-trigger the subscribe.
  if (state.userInfo.isDataLoaded) return false;
  return true;
}

store.subscribe(() => {
  if (!shouldPersistGuest(store.getState())) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const state = store.getState();
    // Re-check at flush time — state may have changed during the debounce.
    if (!shouldPersistGuest(state)) return;
    const user = state.userInfo.users[0];
    try {
      localStorage.setItem('pickyum_guest', JSON.stringify({
        favorites:         user.favorites,
        options:           user.options,
        accepted:          user.accepted,
        archived:          user.archived   ?? [],
        reviews:           user.reviews,
        notes:             user.notes      ?? {},
        flipCount:         user.flipCount  ?? 0,
        // Guest address book — kept in localStorage so the Search page
        // prefill works without an account. Each entry has the same
        // shape as the server-side SavedAddress; guest entries use
        // negative ids to avoid colliding with future server ids.
        addresses:         user.addresses    ?? [],
        customRestaurants: state.userInfo.customRestaurants,
      }));
    } catch { /* storage quota exceeded — non-fatal */ }
  }, GUEST_PERSIST_DEBOUNCE_MS);
});

export default store;
