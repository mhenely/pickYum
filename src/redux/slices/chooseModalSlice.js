import { createSlice } from "@reduxjs/toolkit";

// Single boolean: whether the "Help me choose" modal is open. The slice used to
// also export addSelection / removeSelection / changeZeroIndex actions that
// mutated a non-existent `selections` array — those would crash if dispatched
// and have been removed.

const initialState = {
  isOpen: false,
};

export const chooseModalSlice = createSlice({
  name: 'chooseModal',
  initialState,
  reducers: {
    setIsOpen: (state) => {
      state.isOpen = !state.isOpen;
    },
  },
});

export const { setIsOpen } = chooseModalSlice.actions;

export default chooseModalSlice.reducer;
