import { configureStore } from "@reduxjs/toolkit";
import userInfoReducer from "./slices/userInfoSlice";
import chooseModalReducer from "./slices/chooseModalSlice";
import restaurantsReducer from "./slices/restaurantsSlice";
import authReducer from "./slices/authSlice";
import ratingReducer from "./slices/ratingSlice";
import searchReducer from "./slices/searchSlice";
import { listenerMiddleware } from "./listenerMiddleware";

const store = configureStore({
  reducer: {
    auth: authReducer,
    userInfo: userInfoReducer,
    chooseModal: chooseModalReducer,
    restaurants: restaurantsReducer,
    rating: ratingReducer,
    search: searchReducer,
  },
  middleware: (getDefault) =>
    getDefault().prepend(listenerMiddleware.middleware),
});

export default store;
