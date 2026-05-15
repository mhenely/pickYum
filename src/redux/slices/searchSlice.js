import { createSlice } from "@reduxjs/toolkit";

// Redux state must be serializable, so priceFilters is stored as an array.
// SearchPage converts it to a Set for O(1) membership checks.
const initialState = {
  // Nearby search
  nearbyResults: null,      // PlacesRestaurant[] | null — null means local-list mode
  locationInput: "",
  radiusMeters: null,
  // SEARCH-TIME cuisine filter: a single Google Places type
  // (e.g. 'italian_restaurant') passed to /api/places/nearby so we
  // only get back restaurants of that cuisine. null = no filter,
  // which triggers the server's default 3-slice fan-out across all
  // food categories. Distinct from `cuisineFilter` below — that one
  // post-filters the already-fetched results. See utils/cuisineTypes.js
  // for the allowed values.
  searchCuisineType: null,
  resolvedAddress: "",
  // Geocoded center of the last nearby search. Used to anchor the map when
  // results don't cover the searched point (e.g. all hits to the north of
  // the user's address). null in local-list mode.
  resolvedLat: null,
  resolvedLng: null,

  // Filters
  priceFilters: [],         // number[]
  openNowFilter: false,
  openAtTime: "",
  deliveryFilter: false,
  takeoutFilter: false,

  // Sort & name search
  sortBy: "none",
  query: "",
  cuisineFilter: "All",

  // Pagination — persisted so navigating to a detail page and back keeps
  // the user on the page they were viewing. Auto-reset to 0 by any reducer
  // that changes the result set (filters, sort, query, new search). The
  // page-size constant lives in SearchPage; the slice just stores the
  // current index.
  currentPage: 0,
};

// Reducer helper: any filter/sort change invalidates the current page index
// because pagination is computed off `sortedNearby`. Centralising the reset
// here keeps the reducers below short and prevents drift if a new filter is
// added — touch this one line and every existing setter inherits it.
const resetPage = (state) => { state.currentPage = 0; };

export const searchSlice = createSlice({
  name: 'search',
  initialState,
  reducers: {
    setNearbyResults: (state, action) => {
      state.nearbyResults    = action.payload.results;
      state.resolvedAddress  = action.payload.resolvedAddress;
      state.resolvedLat      = action.payload.resolvedLat ?? null;
      state.resolvedLng      = action.payload.resolvedLng ?? null;
      resetPage(state);
    },
    setLocationInput:    (state, action) => { state.locationInput  = action.payload; },
    setRadiusMeters:     (state, action) => { state.radiusMeters   = action.payload; },
    // Accepts a slug from CUISINE_OPTIONS or null/'' to clear. No
    // resetPage call — changing the cuisine doesn't change the
    // displayed results until the user fires the search.
    setSearchCuisineType:(state, action) => {
      state.searchCuisineType = action.payload || null;
    },
    clearNearby: (state) => {
      state.nearbyResults   = null;
      state.resolvedAddress = "";
      state.resolvedLat     = null;
      state.resolvedLng     = null;
      state.sortBy          = "none";
      resetPage(state);
    },
    togglePriceFilter: (state, action) => {
      const level = action.payload;
      const idx   = state.priceFilters.indexOf(level);
      if (idx >= 0) state.priceFilters.splice(idx, 1);
      else          state.priceFilters.push(level);
      resetPage(state);
    },
    clearPriceFilters:   (state)         => { state.priceFilters  = []; resetPage(state); },
    toggleOpenNow:       (state)         => { state.openNowFilter = !state.openNowFilter; resetPage(state); },
    setOpenAtTime:       (state, action) => { state.openAtTime    = action.payload; resetPage(state); },
    toggleDeliveryFilter:(state)         => { state.deliveryFilter = !state.deliveryFilter; resetPage(state); },
    toggleTakeoutFilter: (state)         => { state.takeoutFilter  = !state.takeoutFilter; resetPage(state); },
    setSortBy:           (state, action) => { state.sortBy        = action.payload; resetPage(state); },
    setQuery:            (state, action) => { state.query         = action.payload; resetPage(state); },
    setCuisineFilter:    (state, action) => { state.cuisineFilter = action.payload; resetPage(state); },
    // Explicit setter — used by the pagination controls. Doesn't call
    // resetPage because that would defeat the point.
    setCurrentPage:      (state, action) => { state.currentPage   = action.payload; },
  },
});

export const {
  setNearbyResults,
  setLocationInput,
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
} = searchSlice.actions;

export default searchSlice.reducer;
