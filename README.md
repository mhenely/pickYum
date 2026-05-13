# PickYum

A restaurant decision-making app that helps you choose where to eat. Add restaurants to your selections list and use a coin flip to decide between two options.

## Features

- **Coin Flip**: Add up to 2 restaurants to your selection and flip a coin to pick one
- **Favorites**: Mark restaurants as favorites for quick access
- **Reviews**: Write and manage star-rated reviews per restaurant
- **Acceptance History**: Track every restaurant you've accepted via the coin flip
- **User Profile**: Update your email, address, and password

## Tech Stack

| Layer | Technology |
|---|---|
| UI | React 18, Tailwind CSS, Headless UI |
| Routing | React Router DOM v6 |
| State | Redux Toolkit |
| Build | Vite 5 |

## Getting Started

```bash
npm install
npm run dev
```

The app runs at `http://localhost:5173` by default.

## Project Structure

```
src/
├── routes/           # Page-level components (one file per route)
├── components/       # Shared UI components (Navigation, modals, star rating)
├── redux/
│   ├── store.js
│   └── slices/       # userInfoSlice is the primary slice
├── tempData/         # Mock data (restaurants.js, users.js) — no backend yet
├── data/             # Empty — reserved for future API response types
└── utils/            # Empty — reserved for future helper functions
```

## State Management

All user state lives in `userInfoSlice`. It manages:

- `selections` — array of restaurant IDs queued for the coin flip (max 2 are used)
- `favorites` — array of restaurant IDs the user has favorited
- `reviews` — object keyed by restaurant ID, each value is an array of review objects
- `accepted` — array of `{ restaurantId, date }` objects from accepted coin flips
- `email`, `address`, `password` — user profile fields

The only other active slice is `chooseModalSlice`, which tracks whether the selection modal is open.

## Data Flow

```
User action in component
  → dispatch(action) from userInfoSlice
  → Redux updates state (Immer handles immutability)
  → useSelector hooks re-read state
  → Component re-renders
```

No API calls are made. All data is loaded from `src/tempData/` and lives in Redux for the session. **Data resets on page refresh.**

## Routes

| Path | Page | Status |
|---|---|---|
| `/` | Search | Placeholder — not implemented |
| `/choose/:userId` | Help Me Choose (coin flip) | Working |
| `/restaurant/:restaurantId` | Restaurant Detail | Partially implemented |
| `/userHistory/:userId` | Reviews & History | Working |
| `/userInfo/:userId` | User Profile | Working |
| `/authentication` | Login/Sign Up | Placeholder — not implemented |

## Documentation

| Doc | Purpose |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Codebase guide — file conventions, Redux slices, server routes, auth flow. Start here when working in the code. |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Step-by-step for hosting on AWS Amplify (frontend) and ECR + App Runner (backend). |
| [MONETIZATION.md](MONETIZATION.md) | Forward-looking revenue strategy: premium subscription, affiliate links, restaurant claim & promote, sponsored placements. Technical requirements and recommended sequencing per path. |
| [TODO.md](TODO.md) | Open feature/cleanup items. |

## Known Limitations

> Note: this section is significantly out of date. The codebase now has a full
> Express/Prisma backend, tests on both ends, and authentication. See CLAUDE.md
> for current state.

- No backend — all data is mock/hardcoded and resets on refresh
- Only supports a single hardcoded user (`users[0]`)
- Search and Authentication pages are empty stubs
- `restaurantsSlice` and `pokemonApi` exist in Redux but are not wired up
- No tests
