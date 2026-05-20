import { describe, it, expect, beforeEach, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

vi.mock('../../lib/api', () => ({
  api: {
    users: {
      // /me/all is kept as a deprecated alias on the server, but the
      // client's loadUserData thunk now fires /me/identity and /me/data
      // in parallel (see Tier 1 #3 split). These mocks cover both
      // shapes — getAll stays for any test that still references it.
      getAll: vi.fn(),
      getIdentity: vi.fn().mockResolvedValue({
        apiVersion: 1,
        user: { id: 1, email: 'a@b.c', username: 'alice', flipCount: 0, avatarUrl: null, role: 'user', emailVerified: true },
        defaultListId: 1,
        favoriteIds: [],
      }),
      getData: vi.fn(),
      addReview: vi.fn(),
      updateReview: vi.fn().mockResolvedValue({
        review: { id: 123, restaurantId: 5, rating: '5', content: 'edited', createdAt: '2024-05-01' },
      }),
      refreshPlaces: vi.fn().mockResolvedValue({ updated: [] }),
    },
  },
}));

import { api } from '../../lib/api';
import authReducer from '../../redux/slices/authSlice';
import userInfoReducer, {
  loadUserData,
  persistAddReview,
  persistEditReview,
} from '../../redux/slices/userInfoSlice';

function buildStore(authStatus: 'authenticated' | 'unauthenticated' = 'authenticated') {
  const store = configureStore({
    reducer: { auth: authReducer, userInfo: userInfoReducer },
  });
  if (authStatus === 'authenticated') {
    store.dispatch({
      type: 'auth/checkAuth/fulfilled',
      payload: { id: 1, email: 'a@b.c', username: 'alice', flipCount: 0 },
      meta: { requestId: 't', requestStatus: 'fulfilled' },
    });
  }
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadUserData thunk', () => {
  it('hydrates state.user and customRestaurants from the API response', async () => {
    // /me/all returns the normalized shape: one deduped restaurants
    // array + ID-only collection lists. apiVersion is forward-compat
    // metadata for future mobile clients.
    (api.users.getData as ReturnType<typeof vi.fn>).mockResolvedValue({
      apiVersion: 1,
      restaurants: [
        { id: 10, name: 'Pho 99', cuisineType: 'Vietnamese', priceLevel: 1, googleRating: '4.6', hours: '11 AM' },
        { id: 11, name: 'Sushi Bar', cuisineType: 'Japanese', priceLevel: 3, googleRating: null },
      ],
      favoriteIds:     [10],
      optionIds:       [11],
      archivedIds:     [],
      acceptedEntries: [{ restaurantId: 10, acceptedAt: '2024-05-01T12:00:00Z' }],
      reviews: [
        { id: 7, restaurantId: 10, rating: '4.5', content: 'Solid', createdAt: '2024-04-01T00:00:00Z' },
      ],
    });

    const store = buildStore();
    await store.dispatch(loadUserData({ id: 1, email: 'a@b.c', username: 'alice', flipCount: 0 }) as never);

    const state = store.getState().userInfo;
    expect(state.user.favorites).toEqual(['10']);
    expect(state.user.options).toEqual(['11']);
    // Shape extended with `id` (server row id, needed for the InsightsPage
    // toggle) and `excludeFromInsights` (per-entry opt-out flag).
    expect(state.user.accepted).toEqual([
      { id: null, restaurantId: '10', date: '2024-05-01T12:00:00Z', excludeFromInsights: false },
    ]);

    // Reviews are keyed by restaurantId, with id (server-issued integer) preserved
    expect(state.user.reviews['10']).toBeDefined();
    expect(state.user.reviews['10']).toHaveLength(1);
    expect(state.user.reviews['10'][0]).toEqual(expect.objectContaining({
      id: 7,
      content: 'Solid',
      rating: 4.5,
    }));

    // customRestaurants populated from all collections
    expect(state.customRestaurants['10']).toEqual(expect.objectContaining({ name: 'Pho 99', rating: 4.6 }));
    expect(state.customRestaurants['11']).toEqual(expect.objectContaining({ name: 'Sushi Bar', rating: null }));
    expect(state.isDataLoaded).toBe(true);
  });

  it('is guarded by isDataLoaded — second call is a no-op', async () => {
    (api.users.getData as ReturnType<typeof vi.fn>).mockResolvedValue({
      apiVersion: 1,
      restaurants: [],
      favoriteIds: [], optionIds: [], archivedIds: [],
      acceptedEntries: [], reviews: [],
    });

    const store = buildStore();
    await store.dispatch(loadUserData({ id: 1, email: 'a@b.c', username: 'alice' }) as never);
    // The thunk now fires getIdentity + getData in parallel — either is a
    // reasonable "did we hit the network?" sentinel. Picking getData since
    // it's the heavier of the two and is the one most callers care about.
    expect(api.users.getData).toHaveBeenCalledTimes(1);

    await store.dispatch(loadUserData({ id: 1, email: 'a@b.c', username: 'alice' }) as never);
    // Second dispatch short-circuits via the `condition` predicate
    expect(api.users.getData).toHaveBeenCalledTimes(1);
  });

  it('coerces restaurant ids to strings to match string-keyed Redux collections', async () => {
    (api.users.getData as ReturnType<typeof vi.fn>).mockResolvedValue({
      apiVersion: 1,
      restaurants: [{ id: 42, name: 'X', cuisineType: null, priceLevel: null, googleRating: null }],
      favoriteIds: [42],
      optionIds: [], archivedIds: [],
      acceptedEntries: [], reviews: [],
    });

    const store = buildStore();
    await store.dispatch(loadUserData({ id: 1, email: 'a@b.c', username: 'alice' }) as never);

    const state = store.getState().userInfo;
    expect(state.user.favorites[0]).toBe('42');
    expect(typeof state.user.favorites[0]).toBe('string');
  });
});

describe('persistAddReview thunk', () => {
  it('AUTHENTICATED: awaits API then dispatches addUserReview with the server-issued id', async () => {
    (api.users.addReview as ReturnType<typeof vi.fn>).mockResolvedValue({
      review: { id: 123, restaurantId: 5, rating: '4', content: 'Good', createdAt: new Date().toISOString() },
    });

    const store = buildStore();
    // Pre-hydrate state.user so addUserReview can find user.id === 1
    store.dispatch({
      type: 'userInfo/setUserData',
      payload: { id: 1, email: 'a@b.c', username: 'alice', favorites: [], options: [], accepted: [], archived: [], reviews: {}, flipCount: 0 },
    });

    await store.dispatch(persistAddReview({
      restaurantId: '5', userId: 1, content: 'Good', rating: 4, date: '2024-05-01',
    }) as never);

    expect(api.users.addReview).toHaveBeenCalledWith({ restaurantId: 5, rating: 4, content: 'Good' });

    const state = store.getState().userInfo;
    expect(state.user.reviews['5']).toHaveLength(1);
    expect(state.user.reviews['5'][0]).toEqual({
      id: 123, // server-issued, NOT a local id
      content: 'Good',
      rating: 4,
      date: '2024-05-01',
    });
  });

  it('GUEST: skips API, generates a local-… id, still appends locally', async () => {
    const store = buildStore('unauthenticated');
    store.dispatch({
      type: 'userInfo/setUserData',
      payload: { id: 1, email: 'a@b.c', username: 'alice', favorites: [], options: [], accepted: [], archived: [], reviews: {}, flipCount: 0 },
    });

    await store.dispatch(persistAddReview({
      restaurantId: '5', userId: 1, content: 'Tasty', rating: 5, date: '2024-05-01',
    }) as never);

    expect(api.users.addReview).not.toHaveBeenCalled();
    const stored = store.getState().userInfo.user.reviews['5'][0];
    expect(stored.content).toBe('Tasty');
    // Guest reviews get a string "local-…" id so they're still distinguishable
    expect(typeof stored.id).toBe('string');
    expect(String(stored.id).startsWith('local-')).toBe(true);
  });

  it('AUTHENTICATED: two reviews with identical content remain distinguishable by id', async () => {
    (api.users.addReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ review: { id: 1, restaurantId: 5, rating: '4', content: 'Same', createdAt: '2024-05-01' } })
      .mockResolvedValueOnce({ review: { id: 2, restaurantId: 5, rating: '5', content: 'Same', createdAt: '2024-05-02' } });

    const store = buildStore();
    store.dispatch({
      type: 'userInfo/setUserData',
      payload: { id: 1, email: 'a@b.c', username: 'alice', favorites: [], options: [], accepted: [], archived: [], reviews: {}, flipCount: 0 },
    });

    await store.dispatch(persistAddReview({ restaurantId: '5', userId: 1, content: 'Same', rating: 4, date: '2024-05-01' }) as never);
    await store.dispatch(persistAddReview({ restaurantId: '5', userId: 1, content: 'Same', rating: 5, date: '2024-05-02' }) as never);

    const reviews = store.getState().userInfo.user.reviews['5'];
    expect(reviews).toHaveLength(2);
    expect(reviews.map((r: { id: number }) => r.id)).toEqual([1, 2]); // distinguishable
  });
});

describe('persistEditReview thunk', () => {
  // Helper that pre-seeds a single review for restaurant 5 so each test
  // starts from a "user already wrote one" state.
  function buildStoreWithReview(opts: { authenticated: boolean; reviewId: number | string }) {
    const store = buildStore(opts.authenticated ? 'authenticated' : 'unauthenticated');
    store.dispatch({
      type: 'userInfo/setUserData',
      payload: {
        id: 1, email: 'a@b.c', username: 'alice',
        favorites: [], options: [], accepted: [], archived: [],
        reviews: {
          '5': [{ id: opts.reviewId, content: 'original', rating: 3, date: '2024-05-01' }],
        },
        flipCount: 0,
      },
    });
    return store;
  }

  it('AUTHENTICATED: PATCHes the server and mirrors the new content+rating in Redux', async () => {
    const store = buildStoreWithReview({ authenticated: true, reviewId: 123 });

    await store.dispatch(persistEditReview({
      restaurantId: '5', reviewId: 123, content: 'edited', rating: 5,
    }) as never);

    // Server received only the editable fields — not the full review row.
    // Anything else would let a client overwrite createdAt / userId via a
    // PATCH meant only for content + rating revisions.
    expect(api.users.updateReview).toHaveBeenCalledWith(123, { content: 'edited', rating: 5 });

    const stored = store.getState().userInfo.user.reviews['5'];
    expect(stored).toHaveLength(1);
    // The date field is preserved — edits don't shift the original
    // timestamp (matches the server's PATCH-keeps-createdAt behavior).
    expect(stored[0]).toEqual({ id: 123, content: 'edited', rating: 5, date: '2024-05-01' });
  });

  it('GUEST: edits in-place without calling the server', async () => {
    // Guest reviews carry string "local-…" ids. Round-tripping to the
    // server would 404 (no row exists) and burn quota, so the thunk
    // short-circuits when the review id is non-numeric.
    const store = buildStoreWithReview({ authenticated: false, reviewId: 'local-abc' });

    await store.dispatch(persistEditReview({
      restaurantId: '5', reviewId: 'local-abc', content: 'guest edit', rating: 4,
    }) as never);

    expect(api.users.updateReview).not.toHaveBeenCalled();
    const stored = store.getState().userInfo.user.reviews['5'][0];
    expect(stored.content).toBe('guest edit');
    expect(stored.rating).toBe(4);
  });

  it('AUTHENTICATED with a still-local id: stays slice-only (handles pre-reconciliation edits)', async () => {
    // Race: user adds a review (guest mode), authenticates, then edits
    // before the server-issued id has reconciled into Redux. The local-
    // id row is still all the slice knows about. The thunk should treat
    // it the same as the guest path — patching the server would 404.
    const store = buildStoreWithReview({ authenticated: true, reviewId: 'local-xyz' });

    await store.dispatch(persistEditReview({
      restaurantId: '5', reviewId: 'local-xyz', content: 'edit', rating: 4,
    }) as never);

    expect(api.users.updateReview).not.toHaveBeenCalled();
    expect(store.getState().userInfo.user.reviews['5'][0].content).toBe('edit');
  });

  it('only mutates the matching review when multiple exist for the same restaurant', async () => {
    const store = buildStore('authenticated');
    store.dispatch({
      type: 'userInfo/setUserData',
      payload: {
        id: 1, email: 'a@b.c', username: 'alice',
        favorites: [], options: [], accepted: [], archived: [],
        reviews: {
          '5': [
            { id: 100, content: 'first',  rating: 3, date: '2024-05-01' },
            { id: 101, content: 'second', rating: 4, date: '2024-05-02' },
          ],
        },
        flipCount: 0,
      },
    });

    await store.dispatch(persistEditReview({
      restaurantId: '5', reviewId: 101, content: 'second edited', rating: 5,
    }) as never);

    const stored = store.getState().userInfo.user.reviews['5'];
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ id: 100, content: 'first',         rating: 3 });
    expect(stored[1]).toMatchObject({ id: 101, content: 'second edited', rating: 5 });
  });
});
