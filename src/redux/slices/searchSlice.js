import { createSlice } from "@reduxjs/toolkit";

// Redux state must be serializable, so priceFilters is stored as an array.
// SearchPage converts it to a Set for O(1) membership checks.
const initialState = {
  // Nearby search
  nearbyResults: null,      // PlacesRestaurant[] | null — null means local-list mode
  locationInput: "",
  radiusMeters: null,
  resolvedAddress: "",

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
};

export const searchSlice = createSlice({
  name: 'search',
  initialState,
  reducers: {
    setNearbyResults: (state, action) => {
      state.nearbyResults    = action.payload.results;
      state.resolvedAddress  = action.payload.resolvedAddress;
    },
    setLocationInput:    (state, action) => { state.locationInput  = action.payload; },
    setRadiusMeters:     (state, action) => { state.radiusMeters   = action.payload; },
    clearNearby: (state) => {
      state.nearbyResults   = null;
      state.resolvedAddress = "";
      state.sortBy          = "none";
    },
    togglePriceFilter: (state, action) => {
      const level = action.payload;
      const idx   = state.priceFilters.indexOf(level);
      if (idx >= 0) state.priceFilters.splice(idx, 1);
      else          state.priceFilters.push(level);
    },
    clearPriceFilters:   (state)         => { state.priceFilters  = []; },
    toggleOpenNow:       (state)         => { state.openNowFilter = !state.openNowFilter; },
    setOpenAtTime:       (state, action) => { state.openAtTime    = action.payload; },
    toggleDeliveryFilter:(state)         => { state.deliveryFilter = !state.deliveryFilter; },
    toggleTakeoutFilter: (state)         => { state.takeoutFilter  = !state.takeoutFilter; },
    setSortBy:           (state, action) => { state.sortBy        = action.payload; },
    setQuery:            (state, action) => { state.query         = action.payload; },
    setCuisineFilter:    (state, action) => { state.cuisineFilter = action.payload; },
  },
});

export const {
  setNearbyResults,
  setLocationInput,
  setRadiusMeters,
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
} = searchSlice.actions;

export default searchSlice.reducer;
