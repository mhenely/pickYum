import { describe, it, expect, beforeEach } from 'vitest';
import reducer, {
  setFavoriteLists,
  upsertFavoriteList,
  removeFavoriteList,
  addEntryToList,
  removeEntryFromList,
  setFavoriteListsOrder,
  updateUserFavorites,
  mergeCustomIntoPlace,
  clearUserData,
  addCustomRestaurant,
} from '../../redux/slices/userInfoSlice';
import {
  allLists,
  defaultList,
  isInDefaultList,
  isInAnyList,
  listsContaining,
  allEntryIdsUnion,
  legacyFavoritesArray,
  readActiveListIds,
  writeActiveListIds,
} from '../../utils/favoriteLists';

// Helper builder for a list row shaped like an /me/all favoriteLists entry.
const buildList = (overrides = {}) => ({
  id: 1,
  name: 'My Favorites',
  description: null,
  color: null,
  isDefault: true,
  position: 0,
  createdAt: '2026-05-15T00:00:00Z',
  entries: [],
  ...overrides,
});

const baseState = reducer(undefined, { type: '@@INIT' });

describe('favoriteLists slice reducers', () => {
  describe('setFavoriteLists', () => {
    it('hydrates byId / order / defaultId in position order', () => {
      const state = reducer(baseState, setFavoriteLists([
        buildList({ id: 2, name: 'Date Night', isDefault: false, position: 1 }),
        buildList({ id: 1, name: 'My Favorites', isDefault: true, position: 0 }),
      ]));
      expect(state.favoriteLists.order).toEqual([1, 2]);
      expect(state.favoriteLists.defaultId).toBe(1);
      expect(state.favoriteLists.byId[1].name).toBe('My Favorites');
      expect(state.favoriteLists.byId[2].name).toBe('Date Night');
    });

    it('resets to empty when passed a non-array', () => {
      const seeded = reducer(baseState, setFavoriteLists([buildList()]));
      const cleared = reducer(seeded, setFavoriteLists(undefined));
      expect(cleared.favoriteLists.order).toEqual([]);
      expect(cleared.favoriteLists.defaultId).toBeNull();
    });
  });

  describe('upsertFavoriteList', () => {
    it('inserts a new list and re-sorts by position', () => {
      const seeded = reducer(baseState, setFavoriteLists([buildList({ id: 1, position: 0 })]));
      const state = reducer(seeded, upsertFavoriteList(buildList({
        id: 2, name: 'Date Night', isDefault: false, position: 1,
      })));
      expect(state.favoriteLists.order).toEqual([1, 2]);
    });

    it('promoting a list to default clears the other defaults', () => {
      const seeded = reducer(baseState, setFavoriteLists([
        buildList({ id: 1, isDefault: true, position: 0 }),
        buildList({ id: 2, isDefault: false, position: 1, name: 'Date Night' }),
      ]));
      const state = reducer(seeded, upsertFavoriteList(buildList({
        id: 2, name: 'Date Night', isDefault: true, position: 1,
      })));
      expect(state.favoriteLists.defaultId).toBe(2);
      expect(state.favoriteLists.byId[1].isDefault).toBe(false);
    });
  });

  describe('removeFavoriteList', () => {
    it('drops the list and recomputes defaultId when the default was removed', () => {
      const seeded = reducer(baseState, setFavoriteLists([
        buildList({ id: 1, isDefault: true,  position: 0 }),
        buildList({ id: 2, isDefault: false, position: 1, name: 'Date Night' }),
      ]));
      const state = reducer(seeded, removeFavoriteList(1));
      expect(state.favoriteLists.order).toEqual([2]);
      expect(state.favoriteLists.defaultId).toBe(2);
    });
  });

  describe('addEntryToList / removeEntryFromList', () => {
    it('adds an entry and updates an existing one without duplicating', () => {
      const seeded = reducer(baseState, setFavoriteLists([buildList({ id: 1 })]));
      const added = reducer(seeded, addEntryToList({
        listId: 1,
        entry: { restaurantId: 42, note: null, addedAt: '2026-05-15T00:00:00Z' },
      }));
      expect(added.favoriteLists.byId[1].entries).toHaveLength(1);

      const updated = reducer(added, addEntryToList({
        listId: 1,
        entry: { restaurantId: 42, note: 'try omakase', addedAt: '2026-05-15T00:00:00Z' },
      }));
      expect(updated.favoriteLists.byId[1].entries).toHaveLength(1);
      expect(updated.favoriteLists.byId[1].entries[0].note).toBe('try omakase');
    });

    it('removes an entry; missing entries are a no-op', () => {
      const seeded = reducer(baseState, setFavoriteLists([buildList({
        id: 1,
        entries: [{ restaurantId: 42, note: null, addedAt: '2026-05-15' }],
      })]));
      const removed = reducer(seeded, removeEntryFromList({ listId: 1, restaurantId: 42 }));
      expect(removed.favoriteLists.byId[1].entries).toHaveLength(0);

      const noop = reducer(removed, removeEntryFromList({ listId: 1, restaurantId: 999 }));
      expect(noop.favoriteLists.byId[1].entries).toHaveLength(0);
    });
  });

  describe('setFavoriteListsOrder', () => {
    it('rewrites positions and re-sorts the order array', () => {
      const seeded = reducer(baseState, setFavoriteLists([
        buildList({ id: 1, position: 0 }),
        buildList({ id: 2, position: 1, isDefault: false, name: 'Date Night' }),
      ]));
      const state = reducer(seeded, setFavoriteListsOrder([2, 1]));
      expect(state.favoriteLists.order).toEqual([2, 1]);
      expect(state.favoriteLists.byId[2].position).toBe(0);
      expect(state.favoriteLists.byId[1].position).toBe(1);
    });
  });

  describe('updateUserFavorites mirror into default list', () => {
    it('toggles the legacy array AND the default list entries in sync', () => {
      const seeded = reducer(baseState, setFavoriteLists([buildList({ id: 1 })]));
      const added = reducer(seeded, updateUserFavorites({ restaurantId: 42 }));
      expect(added.users[0].favorites.map(String)).toContain('42');
      expect(added.favoriteLists.byId[1].entries.map((e) => e.restaurantId)).toContain(42);

      const removed = reducer(added, updateUserFavorites({ restaurantId: 42 }));
      expect(removed.users[0].favorites.map(String)).not.toContain('42');
      expect(removed.favoriteLists.byId[1].entries).toHaveLength(0);
    });

    it('with no default list, only touches the legacy array (guest path)', () => {
      const added = reducer(baseState, updateUserFavorites({ restaurantId: 42 }));
      expect(added.users[0].favorites.map(String)).toContain('42');
      // No default list means no mirror — favoriteLists state stays empty.
      expect(added.favoriteLists.order).toEqual([]);
    });
  });

  describe('mergeCustomIntoPlace re-points list entries', () => {
    it('moves a custom-row entry onto the place-row id', () => {
      const seeded = reducer(baseState, setFavoriteLists([buildList({
        id: 1,
        entries: [{ restaurantId: 100, note: 'best brunch', addedAt: '2026-05-15' }],
      })]));
      // Custom row 100 → place row 200. The merge reducer needs the
      // user record to exist; addCustomRestaurant warms the map so
      // the merge has somewhere to delete from.
      const withCustom = reducer(seeded, addCustomRestaurant({ id: '100', data: { name: 'Joe\'s' } }));
      const merged = reducer(withCustom, mergeCustomIntoPlace({ customId: 100, placeId: 200 }));
      const entries = merged.favoriteLists.byId[1].entries;
      expect(entries).toHaveLength(1);
      expect(entries[0].restaurantId).toBe(200);
      expect(entries[0].note).toBe('best brunch');
    });
  });

  describe('clearUserData wipes favoriteLists', () => {
    it('returns the byId/order/defaultId to an empty shape', () => {
      const seeded = reducer(baseState, setFavoriteLists([buildList()]));
      const cleared = reducer(seeded, clearUserData());
      expect(cleared.favoriteLists.byId).toEqual({});
      expect(cleared.favoriteLists.order).toEqual([]);
      expect(cleared.favoriteLists.defaultId).toBeNull();
    });
  });
});

// ── Selector tests ──────────────────────────────────────────────
describe('favoriteLists selectors', () => {
  const buildRootState = (lists) => ({
    userInfo: reducer(baseState, setFavoriteLists(lists)),
  });

  it('isInDefaultList only flags entries of the default list', () => {
    const state = buildRootState([
      buildList({ id: 1, isDefault: true, entries: [
        { restaurantId: 42, note: null, addedAt: '' },
      ]}),
      buildList({ id: 2, isDefault: false, name: 'Date Night', position: 1, entries: [
        { restaurantId: 99, note: null, addedAt: '' },
      ]}),
    ]);
    expect(isInDefaultList(state, 42)).toBe(true);
    expect(isInDefaultList(state, 99)).toBe(false);
  });

  it('isInAnyList flags membership across every list, including non-default', () => {
    const state = buildRootState([
      buildList({ id: 1, isDefault: true, entries: [
        { restaurantId: 42, note: null, addedAt: '' },
      ]}),
      buildList({ id: 2, isDefault: false, name: 'Date Night', position: 1, entries: [
        { restaurantId: 99, note: null, addedAt: '' },
      ]}),
    ]);
    // 42 lives in the default list — true for both selectors.
    expect(isInAnyList(state, 42)).toBe(true);
    // 99 is in Date Night only — isInAnyList catches it where the
    // narrower selector wouldn't, which is exactly the fill-state
    // distinction the heart icon uses.
    expect(isInAnyList(state, 99)).toBe(true);
    // 7 is in no list at all.
    expect(isInAnyList(state, 7)).toBe(false);
  });

  it('listsContaining returns the per-list membership map', () => {
    const state = buildRootState([
      buildList({ id: 1, entries: [{ restaurantId: 42, note: null, addedAt: '' }] }),
      buildList({ id: 2, isDefault: false, name: 'Date Night', position: 1, entries: [
        { restaurantId: 42, note: null, addedAt: '' },
        { restaurantId: 99, note: null, addedAt: '' },
      ]}),
    ]);
    const membership = listsContaining(state, 42);
    expect(membership[1]).toBe(true);
    expect(membership[2]).toBe(true);
    const nope = listsContaining(state, 7);
    expect(nope[1]).toBe(false);
    expect(nope[2]).toBe(false);
  });

  it('allLists returns lists in position order', () => {
    const state = buildRootState([
      buildList({ id: 2, isDefault: false, position: 1, name: 'Date Night' }),
      buildList({ id: 1, position: 0 }),
    ]);
    const lists = allLists(state);
    expect(lists.map((l) => l.id)).toEqual([1, 2]);
  });

  it('defaultList returns the default-flagged list', () => {
    const state = buildRootState([
      buildList({ id: 1, isDefault: false, position: 0 }),
      buildList({ id: 2, isDefault: true, position: 1, name: 'Date Night' }),
    ]);
    expect(defaultList(state).id).toBe(2);
  });

  it('allEntryIdsUnion dedupes across lists', () => {
    const state = buildRootState([
      buildList({ id: 1, entries: [
        { restaurantId: 42, note: null, addedAt: '' },
        { restaurantId: 99, note: null, addedAt: '' },
      ]}),
      buildList({ id: 2, isDefault: false, position: 1, name: 'Date Night', entries: [
        { restaurantId: 42, note: null, addedAt: '' },
        { restaurantId: 7,  note: null, addedAt: '' },
      ]}),
    ]);
    const union = allEntryIdsUnion(state).sort();
    expect(union).toEqual(['42', '7', '99'].sort());
  });

  it('legacyFavoritesArray prefers the default list, falls back to legacy', () => {
    const stateWithList = buildRootState([
      buildList({ id: 1, entries: [{ restaurantId: 42, note: null, addedAt: '' }] }),
    ]);
    expect(legacyFavoritesArray(stateWithList)).toEqual(['42']);

    // No lists → fall back to users[0].favorites
    const guestState = {
      userInfo: reducer(reducer(undefined, { type: '@@INIT' }), updateUserFavorites({ restaurantId: 7 })),
    };
    expect(legacyFavoritesArray(guestState)).toEqual(['7']);
  });
});

// ── Multi-select sessionStorage helpers ──────────────────────────
// Pages persist their checkbox selection across navigation but not
// across logins; the helpers below own the sessionStorage shape
// (JSON-encoded id array) and the legacy-value migration path.
describe('readActiveListIds / writeActiveListIds', () => {
  beforeEach(() => {
    // jsdom provides sessionStorage; clear per-test so state doesn't
    // leak across cases.
    sessionStorage.clear();
  });

  it('returns null when nothing was previously written', () => {
    expect(readActiveListIds('search')).toBeNull();
  });

  it('round-trips a multi-id selection', () => {
    writeActiveListIds('search', [1, 2, 3]);
    expect(readActiveListIds('search')).toEqual([1, 2, 3]);
  });

  it('writing null clears the stored value', () => {
    writeActiveListIds('search', [1, 2]);
    writeActiveListIds('search', null);
    expect(readActiveListIds('search')).toBeNull();
  });

  it('drops non-positive-integer entries from a stored array', () => {
    // Hand-edited / corrupt sessionStorage value — defend against it.
    sessionStorage.setItem('pickyum_active_list_search', '[1, "foo", -3, 4.5, 7]');
    expect(readActiveListIds('search')).toEqual([1, 7]);
  });

  it('migrates the legacy single-id value to a one-element array', () => {
    sessionStorage.setItem('pickyum_active_list_search', '42');
    expect(readActiveListIds('search')).toEqual([42]);
  });

  it('returns null for the legacy "all" sentinel (caller re-seeds)', () => {
    sessionStorage.setItem('pickyum_active_list_search', 'all');
    expect(readActiveListIds('search')).toBeNull();
  });
});
