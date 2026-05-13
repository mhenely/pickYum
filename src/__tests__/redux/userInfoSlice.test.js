import { describe, it, expect } from 'vitest';
import reducer, {
  addUserSelection,
  removeUserSelection,
  updateUserFavorites,
  addUserAcceptance,
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
  describe('addUserSelection', () => {
    it('adds a new restaurant id to selections', () => {
      const state = reducer(baseState, addUserSelection('42'));
      expect(state.users[0].selections).toContain('42');
    });

    it('is a no-op when the id is already present', () => {
      const first = reducer(baseState, addUserSelection('42'));
      const second = reducer(first, addUserSelection('42'));
      expect(second.users[0].selections.filter((id) => id == '42').length).toBe(1);
    });
  });

  describe('removeUserSelection', () => {
    it('removes an existing id', () => {
      const withSel = reducer(baseState, addUserSelection('7'));
      const removed = reducer(withSel, removeUserSelection('7'));
      expect(removed.users[0].selections).not.toContain('7');
    });

    it('is a no-op when id is not present', () => {
      const state = reducer(baseState, removeUserSelection('999'));
      expect(state.users[0].selections).toEqual(baseState.users[0].selections);
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
        selections: ['3'],
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
      expect(state.users[0].selections).toEqual(['3']);
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
