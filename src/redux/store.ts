import { configureStore } from "@reduxjs/toolkit";
import userInfoReducer from "./slices/userInfoSlice";
import chooseModalReducer from "./slices/chooseModalSlice";
import authReducer from "./slices/authSlice";
import ratingReducer from "./slices/ratingSlice";
import searchReducer from "./slices/searchSlice";
import { listenerMiddleware } from "./listenerMiddleware";

const store = configureStore({
  reducer: {
    auth: authReducer,
    userInfo: userInfoReducer,
    chooseModal: chooseModalReducer,
    rating: ratingReducer,
    search: searchReducer,
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
store.subscribe(() => {
  if (store.getState().auth.status === 'authenticated') return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const state = store.getState();
    if (state.auth.status === 'authenticated') return;
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
        customRestaurants: state.userInfo.customRestaurants,
      }));
    } catch { /* storage quota exceeded — non-fatal */ }
  }, GUEST_PERSIST_DEBOUNCE_MS);
});

export default store;
