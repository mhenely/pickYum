import { configureStore } from "@reduxjs/toolkit";
// import counterSlice from "./slices/counterSlice";
import counterReducer from "./slices/practiceSlice";
import { pokemonApi } from "./Apis/pokemonApi";

export default configureStore({
  reducer: {
    counter: counterReducer,
    [pokemonApi.reducerPath]: pokemonApi.reducer,
  },
  middleware: (getDefaultMiddleware) => 
    getDefaultMiddleware().concat(pokemonApi.middleware)
})
