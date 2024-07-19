import { createSlice } from '@reduxjs/toolkit'

import { restaurants } from '../../tempData/restaurants'

const initialState = {
  restaurants
}

export const restaurantsSlice = createSlice({
  name: 'restaurants',
  initialState,
  reducers: {
    // increment: (state) => {
    //   // Redux Toolkit allows us to write "mutating" logic in reducers. It
    //   // doesn't actually mutate the state because it uses the Immer library,
    //   // which detects changes to a "draft state" and produces a brand new
    //   // immutable state based off those changes
    //   state.value += 1
    // },
    // decrement: (state) => {
    //   state.value -= 1
    // },
    // incrementByAmount: (state, action) => {
    //   state.value += action.payload
    // },
    // decrementByAmount: (state, action) => {
    //   state.value -= action.payload
    // }
  },
})

// Action creators are generated for each case reducer function
export const { increment, decrement, incrementByAmount, decrementByAmount } = restaurantsSlice.actions

export default restaurantsSlice.reducer