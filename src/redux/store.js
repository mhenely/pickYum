import { configureStore } from "@reduxjs/toolkit";
import userInfoReducer from "./slices/userInfoSlice";
import chooseModalReducer from "./slices/chooseModalSlice";
import restaurantsReducer from "./slices/restaurantsSlice";

export default configureStore({
  reducer: {
    userInfo: userInfoReducer,
    chooseModal: chooseModalReducer,
    restaurants: restaurantsReducer,
  },
});
