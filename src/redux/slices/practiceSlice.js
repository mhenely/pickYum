import { createSlice } from "@reduxjs/toolkit";
// import { decrementByAmount, incrementByAmount } from "./counterSlice";

const initialState = {
  value: 0, 
  test: 100
}

export const counterSlice = createSlice({
  name: 'counter',
  initialState,
  reducers: {
    increment: (state) => {
      state.value += 1
    },
    decrement: (state) => {
      state.value -= 1
    },
    incrementByAmount: (state, action) => {
      state.value += action.payload
    },
    decrementByAmount: (state, action) => {
      state.value -= action.payload
    }
  }
})

export const { increment, decrement, decrementByAmount, incrementByAmount} = counterSlice.actions;

export default counterSlice.reducer;