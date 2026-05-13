import { describe, it, expect } from 'vitest';
import reducer, {
  togglePriceFilter,
  clearPriceFilters,
  toggleOpenNow,
  toggleDeliveryFilter,
  toggleTakeoutFilter,
  setQuery,
  setSortBy,
  setCuisineFilter,
  setNearbyResults,
  clearNearby,
  setLocationInput,
  setRadiusMeters,
  setOpenAtTime,
} from '../../redux/slices/searchSlice';

const base = reducer(undefined, { type: '@@INIT' });

describe('searchSlice', () => {
  describe('togglePriceFilter', () => {
    it('adds a price level when not present', () => {
      const state = reducer(base, togglePriceFilter(2));
      expect(state.priceFilters).toContain(2);
    });

    it('removes a price level when already present', () => {
      const added = reducer(base, togglePriceFilter(2));
      const removed = reducer(added, togglePriceFilter(2));
      expect(removed.priceFilters).not.toContain(2);
    });

    it('can hold multiple price levels', () => {
      let state = reducer(base, togglePriceFilter(1));
      state = reducer(state, togglePriceFilter(3));
      expect(state.priceFilters).toContain(1);
      expect(state.priceFilters).toContain(3);
    });
  });

  describe('clearPriceFilters', () => {
    it('empties the priceFilters array', () => {
      let state = reducer(base, togglePriceFilter(1));
      state = reducer(state, togglePriceFilter(2));
      state = reducer(state, clearPriceFilters());
      expect(state.priceFilters).toEqual([]);
    });
  });

  describe('toggleOpenNow', () => {
    it('flips openNowFilter from false to true', () => {
      const state = reducer(base, toggleOpenNow());
      expect(state.openNowFilter).toBe(true);
    });

    it('flips openNowFilter back to false', () => {
      const on = reducer(base, toggleOpenNow());
      const off = reducer(on, toggleOpenNow());
      expect(off.openNowFilter).toBe(false);
    });
  });

  describe('toggleDeliveryFilter / toggleTakeoutFilter', () => {
    it('toggles deliveryFilter', () => {
      expect(reducer(base, toggleDeliveryFilter()).deliveryFilter).toBe(true);
      expect(reducer(reducer(base, toggleDeliveryFilter()), toggleDeliveryFilter()).deliveryFilter).toBe(false);
    });

    it('toggles takeoutFilter', () => {
      expect(reducer(base, toggleTakeoutFilter()).takeoutFilter).toBe(true);
    });
  });

  describe('setQuery', () => {
    it('sets the query string', () => {
      const state = reducer(base, setQuery('pizza'));
      expect(state.query).toBe('pizza');
    });
  });

  describe('setSortBy', () => {
    it('sets the sortBy value', () => {
      const state = reducer(base, setSortBy('rating'));
      expect(state.sortBy).toBe('rating');
    });
  });

  describe('setCuisineFilter', () => {
    it('sets the cuisineFilter', () => {
      const state = reducer(base, setCuisineFilter('Italian'));
      expect(state.cuisineFilter).toBe('Italian');
    });
  });

  describe('setNearbyResults / clearNearby', () => {
    it('stores results and resolvedAddress', () => {
      const state = reducer(
        base,
        setNearbyResults({ results: [{ name: 'Burger Place' }], resolvedAddress: '123 Main St' }),
      );
      expect(state.nearbyResults).toHaveLength(1);
      expect(state.resolvedAddress).toBe('123 Main St');
    });

    it('clearNearby resets results and resolvedAddress', () => {
      let state = reducer(base, setNearbyResults({ results: [{}], resolvedAddress: '123 Main' }));
      state = reducer(state, clearNearby());
      expect(state.nearbyResults).toBeNull();
      expect(state.resolvedAddress).toBe('');
    });
  });

  describe('setLocationInput / setRadiusMeters / setOpenAtTime', () => {
    it('sets locationInput', () => {
      expect(reducer(base, setLocationInput('Chicago, IL')).locationInput).toBe('Chicago, IL');
    });

    it('sets radiusMeters', () => {
      expect(reducer(base, setRadiusMeters(5000)).radiusMeters).toBe(5000);
    });

    it('sets openAtTime', () => {
      expect(reducer(base, setOpenAtTime('18:00')).openAtTime).toBe('18:00');
    });
  });
});
