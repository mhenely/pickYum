# PickYum — Claude Code Guide

## What This App Does

PickYum helps users decide where to eat. Users save restaurants to a "selections" list, then use a coin flip or roulette wheel to pick one. The app also supports group voting sessions where multiple people vote on candidates.

## Tech Stack

### Frontend (`src/`)
- **React 18** with JSX (most files) and TSX (`App.tsx`, `main.tsx`)
- **Vite 5** for builds and dev server
- **Redux Toolkit** for state management
- **React Router DOM v6** for routing
- **Tailwind CSS** for styling
- **Headless UI** for accessible modal/dropdown primitives
- Route-based code splitting via `React.lazy` + `Suspense`

### Backend (`server/`)
- **Express** (TypeScript) with `ts-jest` tests; `express-async-errors` for promise propagation
- **Prisma** ORM targeting **Supabase PostgreSQL**
- **JWT** authentication via httpOnly `token` cookie (`sameSite: strict`)
- **Redis** (ioredis) for group session storage AND SSE pub/sub fan-out across instances. With no Redis, runs single-instance with in-memory fallbacks
- **Google Places API (New)** for restaurant search/nearby (`GOOGLE_PLACES_API_KEY`)
- **Resend** for transactional email — verify-email and password-reset. Fail-open: no `RESEND_API_KEY` ⇒ sends are logged and skipped, never throw
- **Pino** structured logging via `pino-http`; **Sentry** for error reporting (no-op when DSN unset)
- Tests live in `server/src/__tests__/routes/` — run with `cd server && npm test`

## File Conventions

- Route/page components: `src/routes/`
- Shared UI components: `src/components/`
- Redux slices: `src/redux/slices/`
- API client (typed fetch wrapper): `src/lib/api.ts`
- Utility functions: `src/utils/`
- Hooks: `src/hooks/`
- Server routes: `server/src/routes/`
- Prisma schema: `server/prisma/schema.prisma`

## Redux Slices

| Slice | Status | Purpose |
|---|---|---|
| `userInfoSlice` | **Active** | All user data loaded from API: favorites, selections, accepted, archived, reviews, profile |
| `chooseModalSlice` | **Active** | Single boolean: is the selection modal open |
| `authSlice` | **Active** | Auth status (`idle` / `loading` / `authenticated` / `unauthenticated`) and user identity |
| `ratingSlice` | **Active** | Community ratings map keyed by restaurant ID |
| `searchSlice` | **Active** | Persisted search/filter/sort state for SearchPage |

## Authentication Flow

- `checkAuth` thunk fires on app mount to restore session from cookie
- `loginUser` / `registerUser` thunks set auth state and trigger `loadUserData`
- `loadUserData` fetches all user collections in one batch call (`GET /api/users/me/all`)
- `isDataLoaded` flag in `userInfoSlice` prevents duplicate fetches
- `clearUserData` is dispatched on logout to reset the flag and wipe user state
- Guest users (unauthenticated) have their state persisted to `localStorage` under `pickyum_guest`

### Password reset & email verification

- New users: registration sends a verification email (Resend) on success. The `User.emailVerified` boolean stays `false` until the user clicks the link, then `POST /api/auth/verify-email` flips it.
- Forgot password: `POST /api/auth/forgot-password` always returns 200 (no enumeration). If the email matches a real account *with a password*, an email goes out with a 1-hour reset link.
- `POST /api/auth/reset-password` consumes the token, hashes the new password, and signs the user in.
- Tokens live in the `EmailToken` model. We store the bcrypt hash, never the raw — DB leak yields no usable tokens.
- Frontend pages: `/forgot-password`, `/reset-password?token=…`, `/verify-email?token=…`, `/privacy`, `/terms`.

## Current Data Model

`userInfoSlice` stores one user object (multi-user not implemented):

```js
{
  id: Number,
  email: String,
  username: String,
  flipCount: Number,
  favorites: [restaurantId, ...],           // array of string IDs
  selections: [restaurantId, ...],          // IDs queued for coin flip
  accepted: [{ restaurantId, date }, ...],  // coin flip acceptances
  archived: [restaurantId, ...],
  reviews: {
    [restaurantId]: [{ content, rating, date }, ...]
  },
  notes: { [restaurantId]: String },
}
```

Restaurant data (from API or Google Places) lives in `userInfoSlice.customRestaurants` keyed by string ID. There is no separate `restaurants` object or `tempData/` import.

## API Client

`src/lib/api.ts` is the single typed fetch wrapper. All server calls go through it.

- `api.auth.*` — login, register, logout, me
- `api.users.*` — profile, favorites, selections, accepted, archived, reviews, refreshPlaces
- `api.restaurants.*` — create restaurant, get community reviews
- `api.places.*` — nearby search, text search (Google Places proxy)

The client has a 5-second GET cache. Mutations invalidate cache entries by path prefix (first 3 segments).

## Common Patterns

**Reading the current user:**
```js
import useCurrentUser from '../hooks/useCurrentUser';
const userInfo = useCurrentUser();
```

**Dispatching an action:**
```js
const dispatch = useDispatch();
dispatch(addUserSelection(restaurantId));
```

**Calling the API:**
```js
import { api } from '../lib/api';
const { restaurant } = await api.restaurants.create({ name: 'Tasty Slice' });
```

**Looking up a restaurant by ID:**
```js
const customRestaurants = useSelector(s => s.userInfo.customRestaurants);
const r = customRestaurants[String(id)];
```

## Server Routes

| Route file | Prefix | Auth |
|---|---|---|
| `auth.ts` | `/api/auth` | Public (login/register/forgot/reset/verify); `resend-verification` requires auth |
| `users.ts` | `/api/users` | All require auth |
| `restaurants.ts` | `/api/restaurants` | Mixed |
| `places.ts` | `/api/places` | All require auth + rate-limited |
| `sessions.ts` | `/api/sessions` | Mixed (guests join/vote without auth) |
| `groups.ts` | `/api/groups` | All require auth |
| `social.ts` | `/api/social` | All require auth |
| `health.ts` | `/api/health` | Public — `/api/health` (liveness) and `/api/health/ready` (DB + Redis check, returns 503 if degraded) |
| `admin/` | `/api/admin` | All require auth + `role='admin'` on the user row. Sub-routers: `usage` (Places spend rollups: `/usage`, `/usage/top`, `/usage/daily`, `/usage/user/:id`) |

## Operations

- **Health checks**: `GET /api/health` (liveness, always 200 if process is up) and `GET /api/health/ready` (readiness — verifies DB and Redis; returns 503 if degraded).
- **Logs**: pino JSON in production (`LOG_LEVEL=info`), pino-pretty in dev. Per-request logs are correlated by request ID. Cookie/auth headers, password fields, and tokens are redacted before stdout.
- **Errors**: any unhandled error in a route → `Sentry.captureException` (no-op without DSN) and structured logger.error. Add new captures with `Sentry.captureException(err)` from `server/src/lib/sentry`.
- **Fire-and-forget background work**: for promises whose result you don't await (notification sends, cache warming, denormalization), wrap with `logTaskFailure(promise, taskName, ctx?)` from `server/src/lib/asyncSafety.ts`. This logs failures via the structured logger and prevents unhandledRejection (which crashes the process on Node 15+). Don't use it for promises whose result matters — only genuinely side-effecting work.
- **Env validation**: `server/src/index.ts` exits at startup if `JWT_SECRET` / `DATABASE_URL` are missing, or `CLIENT_URL` is missing in production. Optional providers (Resend, Sentry, Redis, Google Places, Supabase) log warnings if absent.
- **Web Push** (`server/src/lib/webPush.ts`): browser-level notifications via RFC 8030 + VAPID. Three env vars to enable: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (mailto:). Generate keypair once with `npx web-push generate-vapid-keys`. Without these, `sendPushToUser` becomes a no-op — feature degrades cleanly, in-app SSE notifications keep working. Subscription endpoints live under `/api/notifications/subscriptions`. Server auto-cleans `410 GONE` subscriptions on dispatch failure. `VAPID_PUBLIC_KEY` is also exposed to the client via `GET /api/notifications/vapid-key` for subscription registration. Wired into `notifyUser()` in `lib/userNotifications.ts` so every SSE refresh also fires a parallel push — both delivery channels share the same trigger. Service worker lives at `/sw.js` (public folder), registered on app boot from `App.tsx`. Per-device opt-in toggle on the Your Info page.
- **Sessions**: Redis-backed (when configured) with a 24h inactivity TTL — every read pipelines a `PEXPIRE` so an active vote never expires while anyone is watching. Override via `SESSION_TTL_HOURS` for shorter dev / load-test sessions.
- **Read cache** (`server/src/lib/serverCache.ts`): Redis-backed `cacheRead(key, ttlSec, compute)` wrapper used on heavy GET endpoints (insights, groups list, trips list). 60s TTL by default; reads bypass + recompute when Redis isn't configured. Use `cacheKeyForUser('thing', userId, suffix?)` for the standard per-user key shape. Writes that produce visible list shape changes (create-group, accept-invite, create-trip) explicitly `cacheClear` the relevant key — everything else relies on TTL expiry.
- **Frontend env vars** (Vite — set on the build host, baked into the bundle):
  - `VITE_API_BASE_URL` — backend origin (default: `http://localhost:3000`)
  - `VITE_OPENTABLE_PARTNER_ID` — appended as `rid` to OpenTable links for affiliate attribution. Unset = plain search links, no revenue tracking. Apply for OpenTable Affiliate Program to populate.
  - `VITE_DOORDASH_AFFILIATE` / `VITE_UBEREATS_AFFILIATE` — `utm_source` hooks for delivery deep-links. No public affiliate program for either today; env hooks pre-staged so a partnership can be wired in without code changes.
- **Multi-instance**: SSE updates fan out across instances via Redis pub/sub on the `pickyum:sse` channel. Without Redis, falls back to single-instance in-memory broadcast. Sessions themselves persist in Redis when configured.
- **Deployment**: Frontend → **AWS Amplify Hosting** (watches repo directly via `amplify.yml`, no GitHub Actions involvement). Backend → Docker image (`server/Dockerfile`) pushed to **Amazon ECR**, deployed to **AWS App Runner** via `.github/workflows/deploy.yml`. CD auto-deploys backend to staging after CI passes; production deploys require manual `workflow_dispatch` + GitHub Environments approval. GitHub Actions uses OIDC to assume an AWS IAM role (no long-lived AWS keys in repo secrets). Full operational guide in `DEPLOYMENT.md`.
