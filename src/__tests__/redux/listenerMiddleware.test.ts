import { describe, it, expect, beforeEach, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

// Mock the API client BEFORE importing the listener — listenerMiddleware imports
// `api` at module scope, so the mock has to be in place when its module is evaluated.
vi.mock('../../lib/api', () => ({
  api: {
    users: {
      addFavorite:           vi.fn().mockResolvedValue(undefined),
      removeFavorite:        vi.fn().mockResolvedValue(undefined),
      addSelection:          vi.fn().mockResolvedValue(undefined),
      removeSelection:       vi.fn().mockResolvedValue(undefined),
      addAccepted:           vi.fn().mockResolvedValue({ accepted: { id: 1, restaurantId: 5, acceptedAt: new Date().toISOString(), restaurant: {} } }),
      deleteReview:          vi.fn().mockResolvedValue(undefined),
      removeFromHistory:     vi.fn().mockResolvedValue({ message: 'ok' }),
      archiveRestaurant:     vi.fn().mockResolvedValue(undefined),
      unarchiveRestaurant:   vi.fn().mockResolvedValue(undefined),
      updateProfile:         vi.fn().mockResolvedValue({ user: { id: 1, email: 'x', username: 'y' } }),
      recordFlip:            vi.fn().mockResolvedValue({ flipCount: 1 }),
      getAll:                vi.fn().mockResolvedValue({
        favorites: [], selections: [], accepted: [], archived: [], reviews: [],
      }),
      refreshPlaces:         vi.fn().mockResolvedValue({ updated: [] }),
    },
  },
}));

import { api } from '../../lib/api';
import { listenerMiddleware } from '../../redux/listenerMiddleware';
import authReducer from '../../redux/slices/authSlice';
import userInfoReducer, {
  setUserData,
  updateUserFavorites,
  addUserSelection,
  removeUserSelection,
  addUserAcceptance,
  removeUserReview,
  removeFromHistory,
  archiveRestaurant,
  unarchiveRestaurant,
  incrementFlipCount,
  updateUserInfo,
  addCustomRestaurant,
} from '../../redux/slices/userInfoSlice';

// Helper to wait for queued microtasks (the listener effects are async).
const flush = () => new Promise((r) => setTimeout(r, 0));

async function buildStore(authStatus: 'authenticated' | 'unauthenticated' = 'authenticated') {
  const store = configureStore({
    reducer: {
      auth: authReducer,
      userInfo: userInfoReducer,
    },
    middleware: (gd) => gd().prepend(listenerMiddleware.middleware),
  });
  if (authStatus === 'authenticated') {
    // Synthesize a fulfilled checkAuth so authReducer flips to 'authenticated'.
    // This also triggers the listener that dispatches `loadUserData`, which
    // hydrates state from api.users.getAll() (mocked, returns empty). We must
    // await that cascade BEFORE we set up our test-specific state — otherwise
    // the cascade resolves later and wipes our setup mid-test.
    store.dispatch({
      type: 'auth/checkAuth/fulfilled',
      payload: { id: 1, email: 'a@b.c', username: 'alice', flipCount: 0 },
      meta: { requestId: 't', requestStatus: 'fulfilled' },
    });
    await flush();
    await flush(); // two ticks: listener → loadUserData → getAll → setUserData → setDataLoaded
  }
  store.dispatch(setUserData({
    id: 1, email: 'a@b.c', username: 'alice',
    flipCount: 0, favorites: [], selections: [], accepted: [], archived: [], reviews: {},
  }));
  // Stash a known DB-backed restaurant in customRestaurants so isDbId/customRestaurants
  // guards pass for restaurant id 42.
  store.dispatch(addCustomRestaurant({ id: '42', data: { name: 'Pho 99', type: 'Vietnamese', price: 1 } }));
  // Clear mocks AFTER setup so the loadUserData getAll call doesn't pollute test assertions.
  vi.clearAllMocks();
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Guest mode skips every API sync', () => {
  it('does not call any api method for unauthenticated dispatches', async () => {
    const store = await buildStore('unauthenticated');
    store.dispatch(updateUserFavorites({ restaurantId: '42' }));
    store.dispatch(addUserSelection('42'));
    store.dispatch(removeUserSelection('42'));
    store.dispatch(addUserAcceptance({ restaurantId: 42 }));
    store.dispatch(archiveRestaurant('42'));
    store.dispatch(unarchiveRestaurant('42'));
    store.dispatch(incrementFlipCount());
    await flush();

    expect(api.users.addFavorite).not.toHaveBeenCalled();
    expect(api.users.addSelection).not.toHaveBeenCalled();
    expect(api.users.removeSelection).not.toHaveBeenCalled();
    expect(api.users.addAccepted).not.toHaveBeenCalled();
    expect(api.users.archiveRestaurant).not.toHaveBeenCalled();
    expect(api.users.unarchiveRestaurant).not.toHaveBeenCalled();
    expect(api.users.recordFlip).not.toHaveBeenCalled();
  });
});

describe('Custom (local) IDs are skipped — listener only syncs DB-backed integer ids', () => {
  it('addUserSelection with "custom-…" id does not call the API', async () => {
    const store = await buildStore();
    store.dispatch(addUserSelection('custom-12345'));
    await flush();
    expect(api.users.addSelection).not.toHaveBeenCalled();
  });

  it('addUserSelection without a customRestaurants entry does not call the API', async () => {
    const store = await buildStore();
    store.dispatch(addUserSelection('999')); // valid id format but unknown restaurant
    await flush();
    expect(api.users.addSelection).not.toHaveBeenCalled();
  });
});

describe('Favorites listener distinguishes add vs remove via the previous state', () => {
  it('calls addFavorite when toggling on', async () => {
    const store = await buildStore();
    store.dispatch(updateUserFavorites({ restaurantId: '42' }));
    await flush();
    expect(api.users.addFavorite).toHaveBeenCalledWith(42);
    expect(api.users.removeFavorite).not.toHaveBeenCalled();
  });

  it('calls removeFavorite when toggling off', async () => {
    const store = await buildStore();
    // First toggle adds locally
    store.dispatch(updateUserFavorites({ restaurantId: '42' }));
    await flush();
    vi.clearAllMocks();
    // Second toggle should remove
    store.dispatch(updateUserFavorites({ restaurantId: '42' }));
    await flush();
    expect(api.users.removeFavorite).toHaveBeenCalledWith(42);
    expect(api.users.addFavorite).not.toHaveBeenCalled();
  });
});

describe('Selections / accepted / archive listeners', () => {
  it('addUserSelection → api.users.addSelection', async () => {
    const store = await buildStore();
    store.dispatch(addUserSelection('42'));
    await flush();
    expect(api.users.addSelection).toHaveBeenCalledWith(42);
  });

  it('removeUserSelection → api.users.removeSelection', async () => {
    const store = await buildStore();
    store.dispatch(removeUserSelection('42'));
    await flush();
    expect(api.users.removeSelection).toHaveBeenCalledWith(42);
  });

  it('addUserAcceptance → api.users.addAccepted', async () => {
    const store = await buildStore();
    store.dispatch(addUserAcceptance({ restaurantId: 42 }));
    await flush();
    expect(api.users.addAccepted).toHaveBeenCalledWith(42);
  });

  it('archiveRestaurant → api.users.archiveRestaurant (only when restaurant exists locally)', async () => {
    const store = await buildStore();
    store.dispatch(archiveRestaurant('42'));
    await flush();
    expect(api.users.archiveRestaurant).toHaveBeenCalledWith(42);
  });

  it('unarchiveRestaurant → api.users.unarchiveRestaurant', async () => {
    const store = await buildStore();
    store.dispatch(unarchiveRestaurant('42'));
    await flush();
    expect(api.users.unarchiveRestaurant).toHaveBeenCalledWith(42);
  });

  it('incrementFlipCount → api.users.recordFlip', async () => {
    const store = await buildStore();
    store.dispatch(incrementFlipCount());
    await flush();
    expect(api.users.recordFlip).toHaveBeenCalled();
  });
});

describe('removeUserReview listener skips local-only ids', () => {
  it('integer review id → api.users.deleteReview', async () => {
    const store = await buildStore();
    store.dispatch(removeUserReview({ restaurantId: '42', id: 7, userId: 1 }));
    await flush();
    expect(api.users.deleteReview).toHaveBeenCalledWith(7);
  });

  it('string "local-…" review id → no API call', async () => {
    const store = await buildStore();
    store.dispatch(removeUserReview({ restaurantId: '42', id: 'local-abc', userId: 1 }));
    await flush();
    expect(api.users.deleteReview).not.toHaveBeenCalled();
  });
});

describe('removeFromHistory listener fires the bulk-wipe endpoint', () => {
  it('integer id → api.users.removeFromHistory', async () => {
    const store = await buildStore();
    store.dispatch(removeFromHistory(42));
    await flush();
    expect(api.users.removeFromHistory).toHaveBeenCalledWith(42);
  });

  it('non-DB id → no API call', async () => {
    const store = await buildStore();
    store.dispatch(removeFromHistory('custom-abc'));
    await flush();
    expect(api.users.removeFromHistory).not.toHaveBeenCalled();
  });

  it('guest mode → no API call', async () => {
    const store = await buildStore('unauthenticated');
    store.dispatch(removeFromHistory(42));
    await flush();
    expect(api.users.removeFromHistory).not.toHaveBeenCalled();
  });
});

describe('updateUserInfo listener', () => {
  it('forwards only truthy fields to the profile endpoint', async () => {
    const store = await buildStore();
    store.dispatch(updateUserInfo({ username: 'newname', email: '', password: 'hunter2A' }));
    await flush();
    expect(api.users.updateProfile).toHaveBeenCalledWith({ username: 'newname', password: 'hunter2A' });
  });

  it('skips API when nothing meaningful is provided', async () => {
    const store = await buildStore();
    store.dispatch(updateUserInfo({}));
    await flush();
    expect(api.users.updateProfile).not.toHaveBeenCalled();
  });
});

describe('Listener errors do not crash the store', () => {
  it('a rejected API call is caught and logged, store stays consistent', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (api.users.addFavorite as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('500'));
    const store = await buildStore();
    store.dispatch(updateUserFavorites({ restaurantId: '42' }));
    await flush();
    expect(errSpy).toHaveBeenCalled();
    // Local state still added the favorite even though the sync failed
    expect(store.getState().userInfo.users[0].favorites).toContain('42');
    errSpy.mockRestore();
  });
});
