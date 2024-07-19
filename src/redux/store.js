import { configureStore } from "@reduxjs/toolkit";
import userInfoReducer from "./slices/userInfoSlice";
import chooseModalReducer from "./slices/chooseModalSlice";
import { pokemonApi } from "./Apis/pokemonApi";


export default configureStore({
  reducer: {
    userInfo: userInfoReducer,
    chooseModal: chooseModalReducer,
    [pokemonApi.reducerPath]: pokemonApi.reducer,
  },
  middleware: (getDefaultMiddleware) => 
    getDefaultMiddleware().concat(pokemonApi.middleware)
})
