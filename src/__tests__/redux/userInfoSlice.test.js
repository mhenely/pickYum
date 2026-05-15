import { describe, it, expect } from 'vitest';
import reducer, {
  addUserOption,
  removeUserOption,
  updateUserFavorites,
  addUserAcceptance,
  setAcceptedExcludeFromInsights,
  reconcileAcceptedRowId,
  archiveRestaurant,
  unarchiveRestaurant,
  incrementFlipCount,
  setUserData,
  addCustomRestaurant,
  updateCustomRestaurant,
  updateUserInfo,
} from '../../redux/slices/userInfoSlice';

const baseState = reducer(undefined, { type: '@@INIT' });

describe('userInfoSlice', () => {
  describe('addUserOption', () => {
    it('adds a new restaurant id to options', () => {
      const state = reducer(baseState, addUserOption('42'));
      expect(state.users[0].options).toContain('42');
    });

    it('is a no-op when the id is already present', () => {
      const first = reducer(baseState, addUserOption('42'));
      const second = reducer(first, addUserOption('42'));
      expect(second.users[0].options.filter((id) => id == '42').length).toBe(1);
    });
  });

  describe('removeUserOption', () => {
    it('removes an existing id', () => {
      const withSel = reducer(baseState, addUserOption('7'));
      const removed = reducer(withSel, removeUserOption('7'));
      expect(removed.users[0].options).not.toContain('7');
    });

    it('is a no-op when id is not present', () => {
      const state = reducer(baseState, removeUserOption('999'));
      expect(state.users[0].options).toEqual(baseState.users[0].options);
    });
  });

  describe('updateUserFavorites', () => {
    it('adds a restaurant when it is not yet favorited', () => {
      const state = reducer(baseState, updateUserFavorites({ restaurantId: '3' }));
      expect(state.users[0].favorites).toContain('3');
    });

    it('removes a restaurant when it is already favorited', () => {
      const added = reducer(baseState, updateUserFavorites({ restaurantId: '3' }));
      const removed = reducer(added, updateUserFavorites({ restaurantId: '3' }));
      expect(removed.users[0].favorites).not.toContain('3');
    });
  });

  describe('addUserAcceptance', () => {
    it('appends an acceptance record with restaurantId and date', () => {
      const state = reducer(baseState, addUserAcceptance({ restaurantId: '10' }));
      const last = state.users[0].accepted[state.users[0].accepted.length - 1];
      expect(last.restaurantId).toBe('10');
      expect(last.date).toBeDefined();
    });

    it('defaults id=null and excludeFromInsights=false when caller omits them', () => {
      // Optimistic appends from legacy callers don't yet know the server
      // row id; both new fields default safely so the entry is valid in
      // the slice's expanded shape.
      const state = reducer(baseState, addUserAcceptance({ restaurantId: '11' }));
      const last = state.users[0].accepted[state.users[0].accepted.length - 1];
      expect(last.id).toBeNull();
      expect(last.excludeFromInsights).toBe(false);
    });

    it('preserves caller-provided id and excludeFromInsights', () => {
      const state = reducer(baseState, addUserAcceptance({
        restaurantId: 12, id: 99, excludeFromInsights: true,
      }));
      const last = state.users[0].accepted[state.users[0].accepted.length - 1];
      expect(last.id).toBe(99);
      expect(last.excludeFromInsights).toBe(true);
    });
  });

  describe('setAcceptedExcludeFromInsights', () => {
    it('flips the flag on the entry matching the given server id', () => {
      // Seed two entries with distinct server ids — toggle one, leave the
      // other untouched.
      const seeded = reducer(baseState, setUserData({
        id: 1, email: 'a@b.c', username: 'a',
        accepted: [
          { id: 10, restaurantId: '5', date: '2024-01-01', excludeFromInsights: false },
          { id: 11, restaurantId: '6', date: '2024-01-02', excludeFromInsights: false },
        ],
      }));
      const next = reducer(seeded, setAcceptedExcludeFromInsights({ id: 11, excludeFromInsights: true }));
      expect(next.users[0].accepted[0].excludeFromInsights).toBe(false);
      expect(next.users[0].accepted[1].excludeFromInsights).toBe(true);
    });

    it('no-ops when the server id is not in state', () => {
      const next = reducer(baseState, setAcceptedExcludeFromInsights({ id: 999, excludeFromInsights: true }));
      // baseState has an empty accepted list — the action shouldn't add a
      // phantom entry. The whole accepted slice should still be empty.
      expect(next.users[0].accepted).toEqual([]);
    });
  });

  describe('reconcileAcceptedRowId', () => {
    it('backfills the server id onto the oldest no-id entry for the restaurant', () => {
      // Simulate an optimistic append (id=null) followed by the listener
      // backfilling the real id once POST /me/accepted returns.
      const seeded = reducer(baseState, addUserAcceptance({ restaurantId: 7 }));
      const next = reducer(seeded, reconcileAcceptedRowId({ restaurantId: 7, id: 555 }));
      const target = next.users[0].accepted.find((a) => String(a.restaurantId) === '7');
      expect(target.id).toBe(555);
    });

    it('only backfills the FIRST no-id entry — concurrent appends are FIFO-reconciled', () => {
      // Two optimistic appends for the same restaurant before either
      // response lands. First response should claim the first append.
      const a = reducer(baseState, addUserAcceptance({ restaurantId: 8 }));
      const b = reducer(a,         addUserAcceptance({ restaurantId: 8 }));
      const next = reducer(b, reconcileAcceptedRowId({ restaurantId: 8, id: 100 }));
      const ids = next.users[0].accepted.map((e) => e.id);
      expect(ids).toEqual([100, null]);
    });
  });

  describe('archiveRestaurant / unarchiveRestaurant', () => {
    it('adds to archived on archiveRestaurant', () => {
      const state = reducer(baseState, archiveRestaurant('5'));
      expect(state.users[0].archived).toContain('5');
    });

    it('does not duplicate if already archived', () => {
      const once = reducer(baseState, archiveRestaurant('5'));
      const twice = reducer(once, archiveRestaurant('5'));
      expect(twice.users[0].archived.filter((id) => id === '5').length).toBe(1);
    });

    it('removes from archived on unarchiveRestaurant', () => {
      const archived = reducer(baseState, archiveRestaurant('5'));
      const unarchived = reducer(archived, unarchiveRestaurant('5'));
      expect(unarchived.users[0].archived).not.toContain('5');
    });
  });

  describe('incrementFlipCount', () => {
    it('increments flipCount by 1', () => {
      const state = reducer(baseState, incrementFlipCount());
      expect(state.users[0].flipCount).toBe(1);
    });

    it('accumulates correctly over multiple calls', () => {
      let state = baseState;
      state = reducer(state, incrementFlipCount());
      state = reducer(state, incrementFlipCount());
      state = reducer(state, incrementFlipCount());
      expect(state.users[0].flipCount).toBe(3);
    });
  });

  describe('setUserData', () => {
    it('hydrates all user fields from the payload', () => {
      const payload = {
        id: 99,
        email: 'test@example.com',
        username: 'testuser',
        flipCount: 7,
        favorites: ['1', '2'],
        options: ['3'],
        accepted: [{ restaurantId: '1', date: '2024-01-01' }],
        archived: [],
        reviews: { '1': [{ content: 'Great', rating: 5, date: '2024-01-01' }] },
      };
      const state = reducer(baseState, setUserData(payload));
      expect(state.users[0].id).toBe(99);
      expect(state.users[0].email).toBe('test@example.com');
      expect(state.users[0].username).toBe('testuser');
      expect(state.users[0].flipCount).toBe(7);
      expect(state.users[0].favorites).toEqual(['1', '2']);
      expect(state.users[0].options).toEqual(['3']);
    });

    it('defaults flipCount to 0 when not provided', () => {
      const state = reducer(baseState, setUserData({ id: 1, email: 'a@b.com', username: 'u' }));
      expect(state.users[0].flipCount).toBe(0);
    });
  });

  describe('addCustomRestaurant / updateCustomRestaurant', () => {
    it('stores a new custom restaurant by id', () => {
      const state = reducer(
        baseState,
        addCustomRestaurant({ id: 'custom-1', data: { name: 'Taco Town', type: 'Mexican' } }),
      );
      expect(state.customRestaurants['custom-1']).toEqual({ name: 'Taco Town', type: 'Mexican' });
    });

    it('merges fields into an existing custom restaurant', () => {
      const withRestaurant = reducer(
        baseState,
        addCustomRestaurant({ id: 'custom-1', data: { name: 'Taco Town', type: 'Mexican' } }),
      );
      const updated = reducer(
        withRestaurant,
        updateCustomRestaurant({ id: 'custom-1', data: { type: 'Tex-Mex', rating: 4.2 } }),
      );
      expect(updated.customRestaurants['custom-1'].name).toBe('Taco Town');
      expect(updated.customRestaurants['custom-1'].type).toBe('Tex-Mex');
      expect(updated.customRestaurants['custom-1'].rating).toBe(4.2);
    });

    it('does not create entry when updateCustomRestaurant targets missing id', () => {
      const state = reducer(baseState, updateCustomRestaurant({ id: 'missing', data: { name: 'X' } }));
      expect(state.customRestaurants['missing']).toBeUndefined();
    });
  });

  describe('updateUserInfo', () => {
    it('updates truthy fields on the user', () => {
      const state = reducer(baseState, updateUserInfo({ username: 'newname' }));
      expect(state.users[0].username).toBe('newname');
    });
  });
});
