# TODO

This file tracks known incomplete areas and planned work.

---

## Completed

- [x] **Bug: `removeUserSelection` dispatch** — was passing `{id}` object; reducer now receives the ID directly
- [x] **Bug: `addUserAcceptance` naming** — `payload.name` renamed to `payload.restaurantId` in both dispatch and reducer
- [x] **Abandoned code deleted** — `practiceSlice.js`, `practiceStore.js`, `pokemonApi.js` removed
- [x] **`restaurantsSlice` wired up** — added to store; boilerplate cleaned up
- [x] **`useCurrentUser` hook** — created at `src/hooks/useCurrentUser.js`; used in all 5 components that previously had the repeated selector
- [x] **Navigation user ID** — links now derive user ID from Redux instead of hardcoding `1`
- [x] **Selections dropdown removal** — nav dropdown now shows a ✕ button per selection; empty state message added
- [x] **SearchPage implemented** — name/cuisine text search with cuisine dropdown filter, favorite toggle, and add-to-selections button
- [x] **`.env.example` created** — template for when a real API is added

---

## Pending — Requires Backend Decisions

### Authentication Page

`src/routes/AuthenticationPage.jsx` is an empty stub. Needs a real auth system (sessions, JWT, OAuth) before UI can be built. Decisions needed:
- Auth provider (custom, Firebase, Auth0, etc.)
- Session storage strategy (cookie vs. localStorage vs. Redux)

### Backend Integration

- Replace `src/tempData/restaurants.js` imports with RTK Query endpoints
- Add user authentication; replace hardcoded `users[0]` with authenticated user lookup
- Add data persistence (all state currently resets on refresh)

### Multi-User Support

All reducers target `users[0]`. Once auth exists:
- Add a `currentUserId` selector derived from the auth session
- Replace all `users[0]` references with a lookup by `currentUserId`

---

## Missing Infrastructure

- **Tests** — no test files exist. Vitest is available (Vite project) but no tests have been written
- **Error handling** — forms have no validation beyond `required`; no error boundaries on individual pages
- **Star rating partial display** — the `partial` CSS class exists in `star-rating.styles.css` but ratings are always integers, so it's never triggered. Implement if fractional ratings are needed.
