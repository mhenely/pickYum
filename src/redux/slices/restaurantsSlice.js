import { createSlice } from '@reduxjs/toolkit'

import { restaurants } from '../../tempData/restaurants'

const initialState = {
  restaurants
}

export const restaurantsSlice = createSlice({
  name: 'restaurants',
  initialState,
  reducers: {},
})

export default restaurantsSlice.reducer
