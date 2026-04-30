# PickYum — Claude Code Guide

## What This App Does

PickYum helps users decide where to eat. The core feature is a coin flip between two restaurants from the user's saved selections.

## Tech Stack

- **React 18** with JSX (most files) and TSX (App.tsx, main.tsx)
- **Vite 5** for builds and dev server
- **Redux Toolkit** for state management
- **React Router DOM v6** for routing
- **Tailwind CSS** for styling
- **Headless UI** for accessible modal/dropdown primitives

## File Conventions

- Route/page components go in `src/routes/`
- Shared UI components go in `src/components/`
- Redux slices go in `src/redux/slices/`
- Mock data lives in `src/tempData/` — `restaurants.js` and `users.js`
- `src/data/` and `src/utils/` are empty directories reserved for future use

## Redux Slices — What's Active vs. Abandoned

| Slice | Status | Purpose |
|---|---|---|
| `userInfoSlice` | **Active** | All user data: selections, favorites, reviews, accepted, profile |
| `chooseModalSlice` | **Active** | Single boolean: is the selection modal open |
| `restaurantsSlice` | Abandoned | Created but never integrated — ignore |
| `practiceSlice` | Abandoned | Counter example from initial scaffolding — ignore |
| `pokemonApi` (RTK Query) | Abandoned | Placeholder for future restaurant API — ignore |

## Current Data Model

All state targets `users[0]` — multi-user support is not implemented. The user object shape:

```js
{
  id: Number,
  email: String,
  address: String,
  password: String,
  favorites: [restaurantId, ...],          // array of IDs
  selections: [restaurantId, ...],         // IDs queued for coin flip
  accepted: [{ restaurantId, date }, ...], // coin flip acceptances
  reviews: {
    [restaurantId]: [{ content, rating, date }, ...]
  }
}
```

Restaurant IDs are string keys on the `restaurants` object (e.g., `"1"`, `"42"`).

## No Backend

There is no API integration. All data comes from `src/tempData/` and lives only in Redux for the session. When adding backend support, the natural entry point is replacing `tempData` imports with RTK Query endpoints and wiring up `restaurantsSlice`.

## Incomplete Pages

- `SearchPage.jsx` — empty stub, no search logic
- `AuthenticationPage.jsx` — empty stub, no auth logic

Do not assume these pages work. They exist only as route placeholders.

## Common Patterns

**Reading state in a component:**
```js
const userInfo = useSelector(state => state.userInfo.users[0]);
```

**Dispatching an action:**
```js
const dispatch = useDispatch();
dispatch(addUserSelection(restaurantId));
```

**Looking up a restaurant by ID:**
```js
import { restaurants } from '../tempData/restaurants';
const restaurant = restaurants[id]; // id is a string key
```
