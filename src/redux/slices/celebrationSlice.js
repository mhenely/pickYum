import { createSlice } from "@reduxjs/toolkit";

// Tiny slice driving the post-Choose-Now celebration modal. Any
// surface that dispatches `addUserAcceptance` for a direct Choose
// Now action (Compare page Choose Now button, detail-modal Choose
// Now in the default action row, future surfaces) also dispatches
// `showChosenCelebration(restaurantId)` so the same celebration
// modal renders globally — no per-page implementation needed.
//
// Why a separate slice instead of folding into userInfoSlice:
//   - userInfoSlice already holds the user's collections + custom
//     restaurants and is loaded eagerly on app mount. The
//     celebration is transient UI state with no persistence
//     requirements; keeping it isolated avoids accidentally
//     persisting a stale "chosen" id on logout / reload.
//   - Other UI-state surfaces (chooseModalSlice) follow the same
//     "small dedicated slice per modal" pattern.

const initialState = {
  // String (matches userInfoSlice id convention) or null. When set,
  // the global <ChosenCelebration/> component renders. Cleared on
  // user dismiss (or when the next acceptance fires).
  chosenId: null,
};

export const celebrationSlice = createSlice({
  name: 'celebration',
  initialState,
  reducers: {
    // Pass the restaurant id (string OR number — coerced to string
    // to match the rest of the app's id convention).
    showChosenCelebration: (state, action) => {
      state.chosenId = action.payload != null ? String(action.payload) : null;
    },
    dismissChosenCelebration: (state) => {
      state.chosenId = null;
    },
  },
});

export const { showChosenCelebration, dismissChosenCelebration } = celebrationSlice.actions;

export default celebrationSlice.reducer;
