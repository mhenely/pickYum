import { createSlice } from "@reduxjs/toolkit";

import { users } from "../../tempData/users";

const initialState = {
  users,
}

export const userInfoSlice = createSlice({
  name: 'userInfo',
  initialState,
  reducers: {
    updateUserInfo: (state, action) => {
      // loop over action.payload keys
      // if value, update user at that key
      Object.keys(action.payload).forEach((key) => {
        if (action.payload[key]) {
          state.users[0][key] = action.payload[key];
        }
      })
    },

    addUserReview: (state, action) => {
      const { restaurantId, userId, content, rating, date } = action.payload
      const newReview = {
        content, 
        rating, 
        date
      }
 
      state.users = state.users.map((user) => {
        if (user.id === userId) {
          if (user.reviews[restaurantId]) {
            user.reviews[restaurantId] = [...user.reviews[restaurantId], newReview];
          } else {
            user.reviews[restaurantId] = [newReview];
          } 
          return user;
        } else {
          return user;
        }
      })

    },

    removeUserReview: (state, action) => {
      const { restaurantId, userId, content } = action.payload;
      
      state.users[0].reviews[restaurantId] = state.users[0].reviews[restaurantId].filter((review) => review.content !== content);
    },

    updateUserFavorites: (state, action) => {
      const { restaurantId, userId } = action.payload;
      if (state.users[0].favorites.find((favorite) => favorite == restaurantId)) {
        state.users[0].favorites = state.users[0].favorites.filter((favorite) => favorite != restaurantId);
      } else {
        state.users[0].favorites = [state.users[0].favorites, restaurantId];
      }
    },

    addUserAcceptance: (state, action) => {
      const restaurantId = action.payload.name;
      state.users[0].accepted = [...state.users[0].accepted, {restaurantId, date: String(new Date())}]
    },

    removeUserSelection: (state, action) => {
      state.users[0].selections = state.users[0].selections.filter((selection) => selection != action.payload)
    },

    addUserSelection: (state, action) => {
      if (!state.users[0].selections.find((id) => id == action.payload)) {
        state.users[0].selections = [...state.users[0].selections, action.payload];
      }   
    },
  }
})

export const { updateUserInfo, addUserReview, 
  removeUserReview, updateUserFavorites, addUserAcceptance,
  removeUserSelection, addUserSelection
 } = userInfoSlice.actions;

export default userInfoSlice.reducer;