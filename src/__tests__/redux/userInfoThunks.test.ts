import { describe, it, expect, beforeEach, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

vi.mock('../../lib/api', () => ({
  api: {
    users: {
      getAll: vi.fn(),
      addReview: vi.fn(),
      refreshPlaces: vi.fn().mockResolvedValue({ updated: [] }),
    },
  },
}));

import { api } from '../../lib/api';
import authReducer from '../../redux/slices/authSlice';
import userInfoReducer, {
  loadUserData,
  persistAddReview,
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
  it('hydrates users[0] and customRestaurants from the API response', async () => {
    (api.users.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      favorites: [
        { id: 10, name: 'Pho 99', cuisineType: 'Vietnamese', priceLevel: 1, googleRating: '4.6', hours: '11 AM' },
      ],
      options: [
        { id: 11, name: 'Sushi Bar', cuisineType: 'Japanese', priceLevel: 3, googleRating: null },
      ],
      accepted: [
        { id: 99, restaurantId: 10, acceptedAt: '2024-05-01T12:00:00Z', restaurant: { id: 10, name: 'Pho 99', cuisineType: 'Vietnamese', priceLevel: 1 } },
      ],
      archived: [],
      reviews: [
        { id: 7, restaurantId: 10, rating: '4.5', content: 'Solid', createdAt: '2024-04-01T00:00:00Z', restaurant: { id: 10, name: 'Pho 99' } },
      ],
    });

    const store = buildStore();
    await store.dispatch(loadUserData({ id: 1, email: 'a@b.c', username: 'alice', flipCount: 0 }) as never);

    const state = store.getState().userInfo;
    expect(state.users[0].favorites).toEqual(['10']);
    expect(state.users[0].options).toEqual(['11']);
    expect(state.users[0].accepted).toEqual([{ restaurantId: '10', date: '2024-05-01T12:00:00Z' }]);

    // Reviews are keyed by restaurantId, with id (server-issued integer) preserved
    expect(state.users[0].reviews['10']).toBeDefined();
    expect(state.users[0].reviews['10']).toHaveLength(1);
    expect(state.users[0].reviews['10'][0]).toEqual(expect.objectContaining({
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
    (api.users.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      favorites: [], options: [], accepted: [], archived: [], reviews: [],
    });

    const store = buildStore();
    await store.dispatch(loadUserData({ id: 1, email: 'a@b.c', username: 'alice' }) as never);
    expect(api.users.getAll).toHaveBeenCalledTimes(1);

    await store.dispatch(loadUserData({ id: 1, email: 'a@b.c', username: 'alice' }) as never);
    // Second dispatch short-circuits via the `condition` predicate
    expect(api.users.getAll).toHaveBeenCalledTimes(1);
  });

  it('coerces restaurant ids to strings to match string-keyed Redux collections', async () => {
    (api.users.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      favorites: [{ id: 42, name: 'X', cuisineType: null, priceLevel: null, googleRating: null }],
      options: [], accepted: [], archived: [], reviews: [],
    });

    const store = buildStore();
    await store.dispatch(loadUserData({ id: 1, email: 'a@b.c', username: 'alice' }) as never);

    const state = store.getState().userInfo;
    expect(state.users[0].favorites[0]).toBe('42');
    expect(typeof state.users[0].favorites[0]).toBe('string');
  });
});

describe('persistAddReview thunk', () => {
  it('AUTHENTICATED: awaits API then dispatches addUserReview with the server-issued id', async () => {
    (api.users.addReview as ReturnType<typeof vi.fn>).mockResolvedValue({
      review: { id: 123, restaurantId: 5, rating: '4', content: 'Good', createdAt: new Date().toISOString() },
    });

    const store = buildStore();
    // Pre-hydrate users[0] so addUserReview can find user.id === 1
    store.dispatch({
      type: 'userInfo/setUserData',
      payload: { id: 1, email: 'a@b.c', username: 'alice', favorites: [], options: [], accepted: [], archived: [], reviews: {}, flipCount: 0 },
    });

    await store.dispatch(persistAddReview({
      restaurantId: '5', userId: 1, content: 'Good', rating: 4, date: '2024-05-01',
    }) as never);

    expect(api.users.addReview).toHaveBeenCalledWith({ restaurantId: 5, rating: 4, content: 'Good' });

    const state = store.getState().userInfo;
    expect(state.users[0].reviews['5']).toHaveLength(1);
    expect(state.users[0].reviews['5'][0]).toEqual({
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
    const stored = store.getState().userInfo.users[0].reviews['5'][0];
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

    const reviews = store.getState().userInfo.users[0].reviews['5'];
    expect(reviews).toHaveLength(2);
    expect(reviews.map((r: { id: number }) => r.id)).toEqual([1, 2]); // distinguishable
  });
});
