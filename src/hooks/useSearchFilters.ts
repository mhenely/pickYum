// Single-call accessor for the persisted search/filter state in
// searchSlice. Used primarily by SearchPage but designed so any other
// surface (a future "saved searches" panel, the Compare page) can
// pull current filter state with one line.
//
// What the hook bundles:
//   - Every persisted field (search mode, location, results, filters,
//     sort, pagination) from src/redux/slices/searchSlice.js.
//   - A `priceFilters` Set view derived from the serialized number[]
//     so consumers don't reinvent the Set conversion in every render.
//   - Stable setter callbacks (via useCallback) for every action, so
//     callers can pass them to memoized children without busting memo.
//
// The hook intentionally does NOT add new state — it's a pure
// accessor + dispatch wrapper. Anything that needs to live across
// route navigation still lives in Redux.

import { useCallback, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  setNearbyResults,
  setLocationInput,
  setSearchMode,
  setNameQuery,
  setRadiusMeters,
  setSearchCuisineType,
  clearNearby,
  togglePriceFilter,
  clearPriceFilters,
  toggleOpenNow,
  setOpenAtTime,
  toggleDeliveryFilter,
  toggleTakeoutFilter,
  setSortBy,
  setQuery,
  setCuisineFilter,
  setCurrentPage,
} from '../redux/slices/searchSlice';

interface SearchState {
  searchMode: 'nearby' | 'name';
  nameQuery: string;
  nearbyResults: unknown[] | null;
  locationInput: string;
  radiusMeters: number | null;
  searchCuisineType: string | null;
  resolvedAddress: string;
  resolvedLat: number | null;
  resolvedLng: number | null;
  priceFilters: number[];
  openNowFilter: boolean;
  openAtTime: string;
  deliveryFilter: boolean;
  takeoutFilter: boolean;
  sortBy: string;
  query: string;
  cuisineFilter: string;
  currentPage: number;
}

export function useSearchFilters() {
  const dispatch = useDispatch();
  const state = useSelector((s: { search: SearchState }) => s.search);

  // Set view over the persisted price filters array — O(1) membership
  // checks for the filter pills. Re-memoized whenever the underlying
  // array reference changes (which happens only on toggle/clear).
  const priceFilterSet = useMemo(
    () => new Set(state.priceFilters),
    [state.priceFilters],
  );

  // Setters: each wrapped in useCallback with [dispatch] as the
  // dependency. dispatch is a stable reference from react-redux, so
  // these callbacks are effectively constant across renders.
  return {
    // ── Persisted state (passthrough) ──
    searchMode: state.searchMode,
    nameQuery: state.nameQuery,
    nearbyResults: state.nearbyResults,
    locationInput: state.locationInput,
    radiusMeters: state.radiusMeters,
    searchCuisineType: state.searchCuisineType,
    resolvedAddress: state.resolvedAddress,
    resolvedLat: state.resolvedLat,
    resolvedLng: state.resolvedLng,
    openNowFilter: state.openNowFilter,
    openAtTime: state.openAtTime,
    deliveryFilter: state.deliveryFilter,
    takeoutFilter: state.takeoutFilter,
    sortBy: state.sortBy,
    query: state.query,
    cuisineFilter: state.cuisineFilter,
    currentPage: state.currentPage,

    // ── Derived ──
    /** Raw serialized array (for places that need ordering, e.g. URL persistence) */
    priceFilters: state.priceFilters,
    /** Set view for O(1) membership checks in render */
    priceFilterSet,

    // ── Setters ──
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dispatch is stable, action creators are module-level constants
    setNearbyResults:     useCallback((p: Parameters<typeof setNearbyResults>[0])     => dispatch(setNearbyResults(p)),     [dispatch]),
    setLocationInput:     useCallback((p: string)                                    => dispatch(setLocationInput(p)),     [dispatch]),
    setSearchMode:        useCallback((p: 'nearby' | 'name')                         => dispatch(setSearchMode(p)),        [dispatch]),
    setNameQuery:         useCallback((p: string)                                    => dispatch(setNameQuery(p)),         [dispatch]),
    setRadiusMeters:      useCallback((p: number | null)                             => dispatch(setRadiusMeters(p)),      [dispatch]),
    setSearchCuisineType: useCallback((p: string | null)                             => dispatch(setSearchCuisineType(p)), [dispatch]),
    clearNearby:          useCallback(()                                             => dispatch(clearNearby()),           [dispatch]),
    togglePriceFilter:    useCallback((p: number)                                    => dispatch(togglePriceFilter(p)),    [dispatch]),
    clearPriceFilters:    useCallback(()                                             => dispatch(clearPriceFilters()),     [dispatch]),
    toggleOpenNow:        useCallback(()                                             => dispatch(toggleOpenNow()),         [dispatch]),
    setOpenAtTime:        useCallback((p: string)                                    => dispatch(setOpenAtTime(p)),        [dispatch]),
    toggleDeliveryFilter: useCallback(()                                             => dispatch(toggleDeliveryFilter()),  [dispatch]),
    toggleTakeoutFilter:  useCallback(()                                             => dispatch(toggleTakeoutFilter()),   [dispatch]),
    setSortBy:            useCallback((p: string)                                    => dispatch(setSortBy(p)),            [dispatch]),
    setQuery:             useCallback((p: string)                                    => dispatch(setQuery(p)),             [dispatch]),
    setCuisineFilter:     useCallback((p: string)                                    => dispatch(setCuisineFilter(p)),     [dispatch]),
    setCurrentPage:       useCallback((p: number)                                    => dispatch(setCurrentPage(p)),       [dispatch]),
  };
}
