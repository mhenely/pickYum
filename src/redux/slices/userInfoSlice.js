import { createSlice } from "@reduxjs/toolkit";

import { users } from "../../tempData/users";

// Seeded from mock data — no persistence, resets on page refresh
const initialState = {
  users,
  customRestaurants: {},
}

// Primary slice. All user data (favorites, selections, reviews, accepted history, profile) lives here.
// Multi-user support is incomplete — all reducers target users[0] or match by userId but only user 0 exists.
export const userInfoSlice = createSlice({
  name: 'userInfo',
  initialState,
  reducers: {
    // Updates profile fields (email, address, password). Skips falsy values so partial updates are safe.
    updateUserInfo: (state, action) => {
      Object.keys(action.payload).forEach((key) => {
        if (action.payload[key]) {
          state.users[0][key] = action.payload[key];
          console.log({
            [key]: action.payload[key]
          })
        }
      })
      console.log({user: state.users[0]})
    },

    // Appends a review to reviews[restaurantId]. Creates the array if this is the first review for that restaurant.
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

    // Removes a review matched by content string (not by index — assumes content is unique per restaurant).
    removeUserReview: (state, action) => {
      const { restaurantId, userId, content } = action.payload;

      state.users[0].reviews[restaurantId] = state.users[0].reviews[restaurantId].filter((review) => review.content !== content);
    },

    // Toggles a restaurant in/out of favorites. Dispatched from both HelpMeChoosePage and RestaurantPage.
    updateUserFavorites: (state, action) => {
      const { restaurantId, userId } = action.payload;
      console.log({restaurantId})
      if (state.users[0].favorites.find((favorite) => favorite == restaurantId)) {
        state.users[0].favorites = state.users[0].favorites.filter((favorite) => favorite != restaurantId);
      } else {
        state.users[0].favorites = [...state.users[0].favorites, restaurantId];
      }
    },

    addUserAcceptance: (state, action) => {
      const restaurantId = action.payload.restaurantId;
      state.users[0].accepted = [...state.users[0].accepted, {restaurantId, date: String(new Date())}]
    },

    // Removes a restaurant ID from the coin flip queue. Dispatched after accepting or manually removing.
    removeUserSelection: (state, action) => {
      state.users[0].selections = state.users[0].selections.filter((selection) => selection != action.payload)
    },

    // Adds a restaurant ID to the coin flip queue. Silently ignores duplicates.
    addUserSelection: (state, action) => {
      if (!state.users[0].selections.find((id) => id == action.payload)) {
        state.users[0].selections = [...state.users[0].selections, action.payload];
      }
    },

    // Registers a user-entered restaurant that doesn't exist in the static data set.
    addCustomRestaurant: (state, action) => {
      const { id, data } = action.payload;
      state.customRestaurants[id] = data;
    },
  }
})

export const { updateUserInfo, addUserReview,
  removeUserReview, updateUserFavorites, addUserAcceptance,
  removeUserSelection, addUserSelection, addCustomRestaurant,
} = userInfoSlice.actions;

export default userInfoSlice.reducer;