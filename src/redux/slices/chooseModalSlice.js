import { createSlice } from "@reduxjs/toolkit";

const initialState = {
  isOpen: false,
  // selections: [
  //   {name: 'PF Changs'},
  //   {name: 'Burger King'},
  //   {name: 'Steak n Shake'},
  //   {name: 'Guthries'}
  // ],
}

export const chooseModalSlice = createSlice({
  name: 'chooseModal',
  initialState,
  reducers: {
    setIsOpen: (state) => {
      state.isOpen = !state.isOpen
    },
    removeSelection: (state, action) => {
      state.selections = state.selections.filter((selection) => selection.name !== action.payload)
    },
    addSelection: (state, action) => {
      const newSelection = {name: action.payload};
      state.selections = [...state.selections, newSelection];
    },
    changeZeroIndex: (state) => {
      state.selections[0].name = 'test';
    }
  }
})


export const { setIsOpen, removeSelection, addSelection, changeZeroIndex } = chooseModalSlice.actions;

export default chooseModalSlice.reducer;