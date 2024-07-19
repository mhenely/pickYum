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

    state.users = state.users.map((user) => {
      if (user.id === action.payload.id) return action.payload
      return user;
      })
    },
    addUserReview: (state, action) => {
      // locate user, add new review to their reviews property
      const { restaurantId, userId, content, rating, date } = action.payload
      const newReview = {
        content, 
        rating, 
        date
      }
        // check if already a matching restaurant id
          // if so, add new review to restaurant's array
          // if not, create new entry in the reviews with restaurantId 
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
  //   updateUserReview: (state, action) => {
  //    const { restaurantId, userId, content, rating, date } = action.payload;

  //    state.users = state.users.map((user) => {
  //     if (user.id === userId) {
  //       user.reviews[restaurantId] = user.reviews[restaurantId].map((review) => {
  //         if 
  //       })
  //     }
  //    })
  //   },
  }
})

export const { updateUserInfo, addUserReview, removeUserReview } = userInfoSlice.actions;

export default userInfoSlice.reducer;