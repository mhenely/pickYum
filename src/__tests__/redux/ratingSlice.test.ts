import { describe, it, expect } from 'vitest';
import reducer, { fetchCommunityRating } from '../../redux/slices/ratingSlice';

const base = reducer(undefined, { type: '@@INIT' });

describe('ratingSlice', () => {
  it('starts with empty communityRatings and pendingIds', () => {
    expect(base.communityRatings).toEqual({});
    expect(base.pendingIds).toEqual([]);
  });

  describe('fetchCommunityRating.pending', () => {
    it('adds the restaurantId to pendingIds', () => {
      const state = reducer(base, {
        type: fetchCommunityRating.pending.type,
        meta: { arg: '5' },
      });
      expect(state.pendingIds).toContain('5');
    });

    it('does not duplicate an id already in pendingIds', () => {
      const pending = reducer(base, { type: fetchCommunityRating.pending.type, meta: { arg: '5' } });
      const again = reducer(pending, { type: fetchCommunityRating.pending.type, meta: { arg: '5' } });
      expect(again.pendingIds.filter((id) => id === '5').length).toBe(1);
    });
  });

  describe('fetchCommunityRating.fulfilled', () => {
    it('stores the community rating and removes from pendingIds', () => {
      const pending = reducer(base, { type: fetchCommunityRating.pending.type, meta: { arg: '5' } });
      const state = reducer(pending, {
        type: fetchCommunityRating.fulfilled.type,
        payload: { restaurantId: '5', communityRating: 4.2 },
      });
      expect(state.communityRatings['5']).toBe(4.2);
      expect(state.pendingIds).not.toContain('5');
    });

    it('stores null communityRating when there are no reviews', () => {
      const state = reducer(base, {
        type: fetchCommunityRating.fulfilled.type,
        payload: { restaurantId: '7', communityRating: null },
      });
      expect(state.communityRatings['7']).toBeNull();
    });

    it('is a no-op when payload is null (already fetched / skipped)', () => {
      const state = reducer(base, { type: fetchCommunityRating.fulfilled.type, payload: null });
      expect(state.communityRatings).toEqual({});
    });
  });

  describe('fetchCommunityRating.rejected', () => {
    it('removes the restaurantId from pendingIds', () => {
      const pending = reducer(base, { type: fetchCommunityRating.pending.type, meta: { arg: '9' } });
      const state = reducer(pending, {
        type: fetchCommunityRating.rejected.type,
        meta: { arg: '9' },
      });
      expect(state.pendingIds).not.toContain('9');
    });
  });
});
