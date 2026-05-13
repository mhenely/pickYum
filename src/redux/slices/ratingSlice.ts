import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { api } from '../../lib/api';

export type RatingMode = 'personal' | 'google' | 'community';

interface RatingState {
  // undefined = not yet fetched; null = fetched, no data; number = fetched value
  communityRatings: Record<string, number | null>;
  pendingIds: string[];
}

const initialState: RatingState = {
  communityRatings: {},
  pendingIds: [],
};

export const fetchCommunityRating = createAsyncThunk(
  'rating/fetchCommunity',
  async (restaurantId: string | number, { getState }) => {
    const idStr = String(restaurantId);
    const state = getState() as { rating: RatingState };
    if (idStr in state.rating.communityRatings || state.rating.pendingIds.includes(idStr)) return null;
    const { communityRating } = await api.restaurants.getReviews(Number(restaurantId));
    return { restaurantId: idStr, communityRating };
  },
);

const ratingSlice = createSlice({
  name: 'rating',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchCommunityRating.pending, (state, action) => {
        const idStr = String(action.meta.arg);
        if (!state.pendingIds.includes(idStr)) state.pendingIds.push(idStr);
      })
      .addCase(fetchCommunityRating.fulfilled, (state, action) => {
        if (!action.payload) return;
        const { restaurantId, communityRating } = action.payload;
        state.communityRatings[restaurantId] = communityRating;
        state.pendingIds = state.pendingIds.filter((id) => id !== restaurantId);
      })
      .addCase(fetchCommunityRating.rejected, (state, action) => {
        const idStr = String(action.meta.arg);
        state.pendingIds = state.pendingIds.filter((id) => id !== idStr);
      });
  },
});

export default ratingSlice.reducer;
