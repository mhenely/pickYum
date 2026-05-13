import { describe, it, expect } from 'vitest';
import reducer from '../../redux/slices/authSlice';
import { checkAuth, loginUser, registerUser, logoutUser } from '../../redux/slices/authSlice';

const initialState = { user: null, status: 'idle' as const, error: null };

const fakeUser = { id: 1, email: 'a@b.com', username: 'alice', flipCount: 0 };

describe('authSlice', () => {
  it('has the correct initial state', () => {
    const state = reducer(undefined, { type: '@@INIT' });
    expect(state.user).toBeNull();
    expect(state.status).toBe('idle');
    expect(state.error).toBeNull();
  });

  describe('checkAuth', () => {
    it('sets status to loading on pending', () => {
      const state = reducer(initialState, { type: checkAuth.pending.type });
      expect(state.status).toBe('loading');
    });

    it('sets user and status to authenticated on fulfilled', () => {
      const state = reducer(initialState, { type: checkAuth.fulfilled.type, payload: fakeUser });
      expect(state.user).toEqual(fakeUser);
      expect(state.status).toBe('authenticated');
    });

    it('clears user and sets unauthenticated on rejected', () => {
      const prev = { ...initialState, user: fakeUser, status: 'authenticated' as const };
      const state = reducer(prev, { type: checkAuth.rejected.type });
      expect(state.user).toBeNull();
      expect(state.status).toBe('unauthenticated');
    });
  });

  describe('loginUser', () => {
    it('sets user and status to authenticated on fulfilled', () => {
      const state = reducer(initialState, { type: loginUser.fulfilled.type, payload: fakeUser });
      expect(state.user).toEqual(fakeUser);
      expect(state.status).toBe('authenticated');
      expect(state.error).toBeNull();
    });

    it('sets error message on rejected', () => {
      const state = reducer(initialState, {
        type: loginUser.rejected.type,
        payload: 'Invalid email or password',
      });
      expect(state.error).toBe('Invalid email or password');
    });
  });

  describe('registerUser', () => {
    it('sets user and status to authenticated on fulfilled', () => {
      const state = reducer(initialState, { type: registerUser.fulfilled.type, payload: fakeUser });
      expect(state.user).toEqual(fakeUser);
      expect(state.status).toBe('authenticated');
    });

    it('sets error message on rejected', () => {
      const state = reducer(initialState, {
        type: registerUser.rejected.type,
        payload: 'That email is already taken',
      });
      expect(state.error).toBe('That email is already taken');
    });
  });

  describe('logoutUser', () => {
    it('clears user and sets unauthenticated on fulfilled', () => {
      const prev = { user: fakeUser, status: 'authenticated' as const, error: null };
      const state = reducer(prev, { type: logoutUser.fulfilled.type });
      expect(state.user).toBeNull();
      expect(state.status).toBe('unauthenticated');
    });
  });
});
