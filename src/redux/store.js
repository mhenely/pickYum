import { configureStore } from "@reduxjs/toolkit";
import counterReducer from './slices/counterSlice'
import chooseModalReducer from "./slices/chooseModalSlice";
import { pokemonApi } from "./Apis/pokemonApi";


export default configureStore({
  reducer: {
    counter: counterReducer,
    chooseModal: chooseModalReducer,
    [pokemonApi.reducerPath]: pokemonApi.reducer,
  },
  middleware: (getDefaultMiddleware) => 
    getDefaultMiddleware().concat(pokemonApi.middleware)
})
