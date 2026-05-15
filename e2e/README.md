# E2E test suite

End-to-end Playwright specs that exercise the real stack: a running
backend, real Postgres, the actual frontend. Tests live in [e2e/](./).

## Setup

These are NOT run by `npm test` (which is Vitest unit + Jest server
units). They need an actual environment running.

### 1. Backend with test hooks enabled

```bash
cd server
E2E_TEST_HOOKS=true npm run dev
```

The `E2E_TEST_HOOKS=true` env var enables the `/api/__test/*` endpoints
(see [server/src/routes/__testHooks.ts](../server/src/routes/__testHooks.ts)).
Without these, the specs can't seed or reset state. **NEVER set this in
production** — the route file double-gates on `*@pickyum.test` emails as
defense in depth, but the mount gate is what stops the destructive
endpoints from existing in prod at all.

### 2. Seed the restaurant fixtures

```bash
cd server && npx prisma db seed
```

The insights-opt-out spec assumes restaurants with ids 1, 2, 3 exist
(seeded by [server/prisma/seed.ts](../server/prisma/seed.ts)).

### 3. Frontend dev server

`playwright.config.ts` starts this automatically. You don't have to.

### 4. Run

```bash
# Run all specs
npm run test:e2e

# Run one spec
npm run test:e2e -- e2e/auth-lockout.spec.ts

# Headed (watch the browser drive)
npm run test:e2e -- --headed

# Debug a single test in inspector
npm run test:e2e -- --debug e2e/insights-opt-out.spec.ts
```

## What each spec covers

| File | What it proves |
|---|---|
| [auth.spec.ts](./auth.spec.ts) | Authentication page renders, public routes accessible to guests |
| [navigation.spec.ts](./navigation.spec.ts) | Nav links / page transitions |
| [auth-lockout.spec.ts](./auth-lockout.spec.ts) | Per-account lockout after 8 failed attempts (Tier 1 #5); successful login resets counter; anti-enumeration error shape |
| [insights-opt-out.spec.ts](./insights-opt-out.spec.ts) | PATCH `/me/accepted/:id` drops the row from `/me/insights` aggregates; round-trip back; ownership 404 |
| [favorites-and-identity.spec.ts](./favorites-and-identity.spec.ts) | `/me/identity` + `/me/data` consistency (Tier 1 #3); heart-fill state survives reload |
| [sync-feedback.spec.ts](./sync-feedback.spec.ts) | Failed background mutations surface a toast (Tier 1 #1); a 500 on identity doesn't whitescreen the app |

## Test users

Specs use dedicated emails ending in `@pickyum.test` (RFC-2606 reserved
domain — never resolves on the real internet). Each spec owns one user
to allow future parallelization:

| User | Used by |
|---|---|
| `e2e-primary@pickyum.test` | identity / favorites |
| `e2e-lockout@pickyum.test` | auth-lockout |
| `e2e-insights@pickyum.test` | insights-opt-out |
| `e2e-sync@pickyum.test` | sync-feedback |

The `helpers.ts` `ensureCleanTestUser` call in each `beforeEach`
creates the user if it doesn't exist and wipes its collections — specs
start from a known empty state every time.

## Adding a new spec

1. Pick or add a test user in [helpers.ts](./helpers.ts) `TEST_USERS`.
2. `beforeEach`: call `ensureCleanTestUser(request, user)`.
3. Drive the flow via either the API (faster, focused on contract) or
   the UI (slower, focused on user-visible behavior). Mix as needed.
4. Add a row to the table above so the next person knows what it covers.

## Known limitations

- **Specs run serially** (`fullyParallel: false`). Some hit shared state
  (Restaurant fixtures) and parallelism would risk flakiness.
- **`window.__PICKYUM_STORE__` not exposed yet** — one assertion in
  `sync-feedback.spec.ts` is conditionally skipped pending a small dev/
  test-mode hook to dispatch Redux actions directly from page.evaluate.
  Tracked in TIER_2_3_PLAN.md.
- **No CI integration yet** — these run locally. Wiring into a GitHub
  Actions job needs a Postgres service container + seed step + a
  backend service. A reasonable next step but out of scope for the
  first batch.
