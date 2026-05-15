import { describe, it, expect } from 'vitest';
import reducer, {
  setUserData,
  addCustomRestaurant,
  archiveRestaurant,
  addUserOption,
  updateUserFavorites,
  addUserAcceptance,
  addUserReview,
  setRestaurantNote,
  setFavoriteLists,
  mergeCustomIntoPlace,
} from '../../redux/slices/userInfoSlice';

// Holistic regression test for the link-to-place flow (TIER_2_3_PLAN.md
// #17). Drives every collection the slice maintains, then runs the merge
// and asserts each one re-pointed correctly.
//
// This is the test that would catch "I added a new collection and
// forgot to remap it on link-to-place" — the most common failure mode
// of the previous inline-blocks implementation. If a new id-bearing
// collection ships without a corresponding remap helper, this test
// will fail on that collection's assertion.

const baseRestaurant = {
  name: 'Custom Place',
  type: 'Custom',
  price: 1,
  rating: null,
  ratingCount: null,
  address: null,
  hours: null,
  phone: null,
  website: null,
  takeout: false,
  delivery: false,
  googlePlaceId: null,
  lat: null,
  lng: null,
  photos: [],
  regularOpeningHours: null,
  excludeFromPlaceMatching: false,
  googleDataUpdatedAt: null,
} as const;

describe('mergeCustomIntoPlace — full collection sweep', () => {
  it('re-points every id-bearing collection from customId to placeId', () => {
    let state = reducer(undefined, { type: '@@INIT' });

    // Seed identity so favorites toggle works
    state = reducer(state, setUserData({ id: 1, email: 'a@b.c', username: 'a' }));

    // Seed custom + place restaurants in the dedup map.
    state = reducer(state, addCustomRestaurant({ id: 'custom-1', data: { ...baseRestaurant, name: 'My Spot' } }));
    state = reducer(state, addCustomRestaurant({ id: '42',       data: { ...baseRestaurant, name: 'Google Place' } }));

    // Seed every id-bearing collection with the CUSTOM id.
    state = reducer(state, updateUserFavorites({ restaurantId: 'custom-1' }));
    state = reducer(state, addUserOption('custom-1'));
    state = reducer(state, archiveRestaurant('custom-1'));
    state = reducer(state, addUserAcceptance({ restaurantId: 'custom-1' }));
    state = reducer(state, addUserReview({ restaurantId: 'custom-1', userId: 1, id: 'local-r', content: 'Solid', rating: 4, date: '2024-01-01' }));
    state = reducer(state, setRestaurantNote({ restaurantId: 'custom-1', text: 'Good for lunch' }));

    // Seed a favorite list whose entry references the custom row.
    // Note: list entries use numeric ids, so the custom id must parse
    // as a positive integer for the remap to apply — we use 7 here
    // for the custom id specifically because string 'custom-1' won't
    // round-trip through Number().
    let state2 = reducer(state, addCustomRestaurant({ id: '7', data: { ...baseRestaurant, name: 'Numeric Custom' } }));
    state2 = reducer(state2, setFavoriteLists([
      {
        id: 100, userId: 1, groupId: null, name: 'My Favorites',
        description: null, color: null, isDefault: true, position: 0,
        createdAt: '2024-01-01',
        entries: [
          { restaurantId: 7,  note: 'note-from-custom', addedAt: '2024-01-01' },
          { restaurantId: 99, note: 'unrelated',        addedAt: '2024-01-01' },
        ],
      },
    ]));

    // The merge. customId=custom-1 → placeId=42 (covers the stringy path).
    state = reducer(state, mergeCustomIntoPlace({ customId: 'custom-1', placeId: '42' }));

    // String-id arrays
    expect(state.user.favorites.map(String)).toContain('42');
    expect(state.user.favorites.map(String)).not.toContain('custom-1');
    expect(state.user.options.map(String)).toContain('42');
    expect(state.user.options.map(String)).not.toContain('custom-1');
    expect(state.user.archived).toContain('42');
    expect(state.user.archived).not.toContain('custom-1');

    // Accepted entries (objects with restaurantId)
    expect(state.user.accepted.some((a) => a.restaurantId === '42')).toBe(true);
    expect(state.user.accepted.some((a) => a.restaurantId === 'custom-1')).toBe(false);

    // Reviews dict — re-keyed
    expect(state.user.reviews['42']).toHaveLength(1);
    expect(state.user.reviews['42'][0].content).toBe('Solid');
    expect(state.user.reviews['custom-1']).toBeUndefined();

    // Notes dict — re-keyed
    expect(state.user.notes?.['42']).toBe('Good for lunch');
    expect(state.user.notes?.['custom-1']).toBeUndefined();

    // Custom row dropped from the deduped map
    expect(state.customRestaurants['custom-1']).toBeUndefined();
    // Place row preserved (caller materialized it before linking)
    expect(state.customRestaurants['42']).toBeDefined();

    // ── Numeric-id favorite list path (separate fixture, since the
    //    stringy 'custom-1' can't appear in a list-entry's numeric
    //    restaurantId field) ────────────────────────────────────────
    const merged = reducer(state2, mergeCustomIntoPlace({ customId: 7, placeId: 42 }));
    const list = merged.favoriteLists.byId[100];
    expect(list.entries.some((e) => e.restaurantId === 7)).toBe(false);
    const placeEntry = list.entries.find((e) => e.restaurantId === 42);
    expect(placeEntry).toBeDefined();
    // Note + addedAt preserved when the place wasn't already in the list.
    expect(placeEntry!.note).toBe('note-from-custom');
  });

  it('drops the custom-list entry rather than overwriting when place is already in the list', () => {
    // Both ids appear in the same list before the merge — the custom
    // row's entry should disappear, and the place's existing entry
    // (including its own note) should survive untouched.
    let state = reducer(undefined, { type: '@@INIT' });
    state = reducer(state, setFavoriteLists([
      {
        id: 1, userId: 1, groupId: null, name: 'L',
        description: null, color: null, isDefault: true, position: 0,
        createdAt: '2024-01-01',
        entries: [
          { restaurantId: 7,  note: 'custom-row-note', addedAt: '2024-01-01' },
          { restaurantId: 42, note: 'place-note',      addedAt: '2024-01-02' },
        ],
      },
    ]));

    state = reducer(state, mergeCustomIntoPlace({ customId: 7, placeId: 42 }));

    const list = state.favoriteLists.byId[1];
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0].restaurantId).toBe(42);
    expect(list.entries[0].note).toBe('place-note'); // place's note wins
  });

  it('keeps the place note when both rows had a global note (no overwrite)', () => {
    // Per-restaurant note (not per-list note). If both rows had one,
    // we keep the place's — overwriting a deliberate place note with
    // a leftover custom-row note would be quiet data loss.
    let state = reducer(undefined, { type: '@@INIT' });
    state = reducer(state, setUserData({ id: 1, email: 'a', username: 'a' }));
    state = reducer(state, setRestaurantNote({ restaurantId: 'custom-1', text: 'custom note' }));
    state = reducer(state, setRestaurantNote({ restaurantId: '42',       text: 'place note'  }));

    state = reducer(state, mergeCustomIntoPlace({ customId: 'custom-1', placeId: '42' }));

    expect(state.user.notes?.['42']).toBe('place note');
    expect(state.user.notes?.['custom-1']).toBeUndefined();
  });

  it('no-ops when customId === placeId', () => {
    // Defensive — the server-side link-to-place shouldn't issue a no-op
    // payload, but if it ever does, the reducer must not corrupt state.
    let state = reducer(undefined, { type: '@@INIT' });
    state = reducer(state, setUserData({ id: 1, email: 'a', username: 'a' }));
    state = reducer(state, updateUserFavorites({ restaurantId: '42' }));

    const before = state.user.favorites;
    state = reducer(state, mergeCustomIntoPlace({ customId: 42, placeId: 42 }));
    expect(state.user.favorites).toEqual(before);
  });
});
