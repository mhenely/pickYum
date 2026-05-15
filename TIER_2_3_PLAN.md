# Tier 2 & Tier 3 implementation plan

Companion to the senior tech-lead review. Tier 1 items shipped in
this session (see CHANGELOG / commit history). This document plans the
remaining 12 items.

Each item lists:
- **Why** — the problem it solves
- **Approach** — the chosen implementation strategy
- **Scope** — files / surfaces affected
- **Effort** — rough estimate
- **Risk** — what could go wrong; rollback strategy
- **Sequencing** — what it depends on (if anything)

Last reviewed: 2026-05-15

---

## Sequencing recommendation

These cluster into three natural batches that share files / concepts:

**Batch A — slice consolidation (Tier 2 #6, #7, #8)**
The userInfoSlice refactor. `users[0]` flatten + TS port + optimistic
abstraction all touch the same file. Doing them together avoids three
separate disruptive PRs on the same surface. ~5–8 days of focused work.

**Batch B — boundary hardening (Tier 2 #9, #10)**
Schema validation at the API client boundary + decomposing
RestaurantDetailModal. Both are about making the boundaries between
layers stricter and smaller. ~4–6 days.

**Batch C — long-tail cleanup (Tier 2 #11, #12, all of Tier 3)**
Smaller, mostly independent items. Pick off as time allows or pair
with related feature work. ~5–8 days total spread out.

---

## Tier 2 — should fix soon

### #6 — `users[0]` singleton fiction

**Why**
103 read sites and 28 reducer writes all type `state.users[0]` because
the slice models a singleton as an array. The shape lie has been there
since v1; CLAUDE.md openly acknowledges "multi-user not implemented."
Every new reducer cargo-cults the pattern, locking it in further.

**Approach**
Mechanical flatten in a single PR:
1. `initialState.users: [{...}]` → `initialState.user: {...}`.
2. Find/replace `state.users[0]` → `state.user` inside [userInfoSlice.js](src/redux/slices/userInfoSlice.js).
3. Find/replace `state.userInfo.users[0]` → `state.userInfo.user`
   across consumers (~100 sites).
4. Update [useCurrentUser.js](src/hooks/useCurrentUser.js) to return `state.userInfo.user`.
   This is the safety net — even if a consumer slips through the
   find/replace, the hook still serves them.
5. Update `pickyum_guest` localStorage migration: detect legacy shape
   on read (`Array.isArray(blob.users)`), unwrap, re-persist. Idempotent.
6. Update tests: `baseState.users[0]` → `baseState.user`.

**Scope**
- [src/redux/slices/userInfoSlice.js](src/redux/slices/userInfoSlice.js) (heavy)
- [src/redux/store.ts](src/redux/store.ts) (persistence helper)
- [src/hooks/useCurrentUser.js](src/hooks/useCurrentUser.js)
- ~100 consumer files
- [src/__tests__/redux/userInfoSlice.test.js](src/__tests__/redux/userInfoSlice.test.js)
- [src/__tests__/redux/userInfoThunks.test.ts](src/__tests__/redux/userInfoThunks.test.ts)
- [src/__tests__/redux/listenerMiddleware.test.ts](src/__tests__/redux/listenerMiddleware.test.ts)

**Effort**
~1 day. Mechanical refactor; the localStorage migration is the only
non-trivial part.

**Risk**
- Returning guests lose state if step 5 is missed. Mitigation: the
  detection-on-read approach is idempotent; tested with both shapes.
- Find/replace miss in a consumer file would crash at runtime
  (reading `.users[0]` on `{ user: {...} }` returns undefined → null
  pointer). Mitigation: TS port (#7) immediately after catches every
  remaining miss as a compile error. Sequence #6 → #7 to compound the
  safety net.

**Sequencing**
Pairs with #7 (TS port of the slice). Do in same PR if possible.

---

### #7 — Mixed TS/JS in slices

**Why**
Frontend is 20 TS files vs 76 JS files. The newest slices (`authSlice`,
`ratingSlice`) are TS; the 834-line `userInfoSlice` is JS. Every consumer
reading `state.userInfo.*` contributes `any` to the store shape. One
typo away from a runtime bug.

**Approach**
Port [userInfoSlice.js](src/redux/slices/userInfoSlice.js) to TS in the same PR as #6 (above). The
flatten is mechanical; adding types on top while the shape is fresh
is cheap. Other slices (`searchSlice`, `chooseModalSlice`, `celebrationSlice`)
get ported when they're next touched in anger — don't bulk-convert.

Define one `UserInfoState` interface that includes the new
`favoriteLists` shape, the recently-extended `accepted: { id, restaurantId,
date, excludeFromInsights }[]` shape, etc. Export from the slice for
selectors to import.

**Scope**
- [src/redux/slices/userInfoSlice.js](src/redux/slices/userInfoSlice.js) → `.ts`
- All selectors that use `useSelector(s => s.userInfo.*)` benefit
  automatically (no manual annotation needed).

**Effort**
+0.5–1 day on top of #6. Slot reducer payload types, fix the
inevitable handful of `any` leaks at consumer boundaries.

**Risk**
Low — TS port surfaces type bugs at compile time, doesn't change runtime
behavior. The risk is "the port reveals existing bugs you have to fix
before the PR can ship" — budget for one or two of those.

**Sequencing**
Bundle with #6.

---

### #8 — Ad-hoc optimistic/reconcile pattern per mutation

**Why**
This session added `reconcileAcceptedRowId` because optimistic accepted-
entries need their real id later. `addReview` has the same problem
(`local-${Date.now()}` → server id). Several other mutations have
related but slightly different shapes. The pattern is reinvented per
mutation; corrections in one don't propagate.

**Approach**
Build an `optimisticThunk` helper that takes:
```ts
optimisticThunk({
  optimistic: (payload) => Action,           // immediate state change
  call: (payload) => Promise<ServerResult>,  // network
  reconcile: (result, payload) => Action,    // backfill on success
  rollback: (payload) => Action,             // undo on failure
  feedback: { label, silent? },              // hook into syncWithFeedback
});
```

Returns a thunk that dispatches `optimistic`, fires `call` via
`syncWithFeedback`, then reconciles or rolls back.

Migrate three call sites to it: `addUserAcceptance` (reconcile id),
`persistAddReview` (reconcile id), one more TBD. Each migration is
~30 LOC removed, ~5 LOC added, plus tests.

**Scope**
- New: `src/redux/optimisticThunk.ts`
- Modified: [src/redux/slices/userInfoSlice.js](src/redux/slices/userInfoSlice.js) (migrate `persistAddReview`)
- Modified: [src/redux/listenerMiddleware.ts](src/redux/listenerMiddleware.ts) (migrate `addUserAcceptance` listener)
- New: `src/__tests__/redux/optimisticThunk.test.ts`

**Effort**
~1.5 days. Helper itself is small; care goes into the migration of
existing sites to confirm behavior parity.

**Risk**
Migration introduces subtle behavior change — e.g. the reconcile fires
synchronously today; the abstraction may queue it. Mitigation: keep
the existing tests passing; add new ones covering the helper directly.

**Sequencing**
After #6 + #7 (so the migrated reducers are TS and reasonable to read).
Pairs with the Tier 1 #1 sync abstraction (already shipped) — same
direction of "lift cross-cutting concerns into one helper."

---

### #9 — No API response validation

**Why**
The client trusts whatever the server sends. Defensive coercion (`Boolean(a.excludeFromInsights)`,
`a.id ?? null`, `Array.isArray(r.photos) ? r.photos : []`) is scattered
throughout the slice because the contract isn't enforced. A server
change that adds/renames a field becomes a downstream `Cannot read
property of undefined` instead of a localized parse error.

**Approach**
Add `zod` and parse every API response through a schema next to the
types in [src/lib/api.ts](src/lib/api.ts).

```ts
const ApiAcceptedSchema = z.object({
  id: z.number(),
  restaurantId: z.number(),
  acceptedAt: z.string(),
  excludeFromInsights: z.boolean(),
  restaurant: ApiRestaurantSchema,
});
// In the request wrapper:
//   const raw = await res.json();
//   return ApiAcceptedSchema.parse(raw);
```

The `parse` throws a `ZodError` on shape drift, which the global error
handler can surface as a Sentry capture with the exact field path.

Roll out per-endpoint:
1. Add schema next to existing interface (keep both — interface is
   `z.infer<typeof Schema>` so they can't drift).
2. Replace `request<T>` calls with a `requestParsed<T>(schema)` variant.
3. Start with `/me/identity` + `/me/data` (already small + critical).
   Expand outward.

**Scope**
- New: `src/lib/api.schemas.ts` (zod schemas; mirrors types)
- Modified: [src/lib/api.ts](src/lib/api.ts) (add `requestParsed`)
- Migrate ~30 endpoint calls (incrementally — not all at once)

**Effort**
~2 days for the framework + first 5 endpoints. The rest happen
opportunistically as endpoints are touched.

**Risk**
Strict parsing breaks legacy compat — if a field changes type and a
deployed client hits the new server, the parse throws. Mitigation:
use `.passthrough()` and `.optional()` for non-critical fields during
the rollout; tighten after the old client versions age out.

**Sequencing**
After Tier 2 #6+#7. Schemas are easier to author against TS-typed
state than against `any`.

---

### #10 — `RestaurantDetailModal` is 1,368 LOC, 8 contexts

**Why**
Single component handles: read view, write-review form, archive /
unarchive / delete, place-match toggle, recommend, custom-restaurant
editing, photo gallery, hours, ratings, the new insights opt-out.
The recently-fixed "hooks rules violation" (useState after early
return) is the kind of bug a smaller component literally cannot have.

**Approach**
Decompose by mode, not by section:

```
RestaurantDetailModal       (thin wrapper: routing + dialog chrome)
├── RestaurantDetailRead    (read-only — used for guest + history)
├── RestaurantDetailWrite   (authed; review/recommend forms)
├── RestaurantDetailHistory (history-context: archive/delete/insights toggle)
├── RestaurantDetailCustom  (custom-restaurant editing)
└── RestaurantPhotoGallery  (shared, used by all)
```

Each sub-component is `<400 LOC`. The wrapper inspects props to pick the
right sub-tree.

Sequencing inside the refactor:
1. Extract `RestaurantPhotoGallery` first — least entangled.
2. Extract the History-context section (the new insights opt-out lives
   here; smallest concrete surface).
3. Extract Read vs. Write split — biggest payoff.
4. Custom-editing path last.

**Scope**
- [src/components/RestaurantDetailModal.jsx](src/components/RestaurantDetailModal.jsx) → 5 files
- Probably ~5 consumer pages need to import-pivot (likely just
  `RestaurantDetailModal` as before, since the wrapper API stays).

**Effort**
~3 days. Refactor risk lives in coupling — hooks shared across modes,
state synchronization across forms. Budget for one or two "I missed
that prop" bugs caught by E2E.

**Risk**
High visibility — this modal is opened on every page. Mitigation:
ship behind a flag (Tier 3 #15) and dogfood internally for 24h before
flipping for users. E2E specs for each opening context as a regression
gate.

**Sequencing**
Independent of slice refactor. Could go in parallel.

---

### #11 — `local-…` ID namespace pollution

**Why**
"Is this a real DB id or a client-side guest stub?" is asked at 23+
call sites. Guest mode keeps state in `localStorage` under
`pickyum_guest`; the type signatures are `number | string` because of
this hybrid. The `isDbId` check is everywhere.

**Approach**
Two options, both viable:

**A. Server-side anonymous sessions** (more invasive, cleaner):
Issue a real DB user row on first visit even for unauthenticated
users — a row with `email: null, anonymous: true`. Account creation
migrates the anonymous row by setting email/password. The `local-…`
namespace disappears entirely.

**B. Centralize the dichotomy** (less invasive, partial):
Replace 23 inline `isDbId` checks with one `useResourceId(id)` hook
that returns `{ kind: 'db' | 'local', value: string }`. Removes the
ad-hoc string parsing but keeps the dual model.

Recommend A. Anonymous-session pattern is well-trodden (Stripe,
Pinterest, every "you can use the app before signing up" product
does this). Migration is a one-time per device.

**Scope (option A)**
- Server: new `User.anonymous` boolean column; auth middleware accepts
  anonymous-session cookies in addition to JWT.
- Server: registration is an UPDATE on the existing anonymous row, not
  an INSERT.
- Client: drop the `pickyum_guest` localStorage path entirely; everything
  goes through the API even pre-signup.
- Cleanup: anonymous rows older than 90 days with no activity get
  reaped by a nightly job.

**Effort**
~5 days. Real refactor; touches auth + every guest read path.

**Risk**
High — auth-adjacent, lots of edge cases (anonymous user adds a
favorite → registers → favorite moves to real account; what if
they register on a different device?). Mitigation: dual-write
both paths during the rollout (option B as a stepping stone).

**Sequencing**
This is genuinely a multi-PR change. Consider deferring to a
dedicated sprint when there's no other Tier 1/2 in flight.

---

### #12 — Insights computation is unbounded

**Why**
[server/src/routes/users.ts](server/src/routes/users.ts) — `/me/insights` runs `findMany` then a full
in-memory rollup. Fine for sparse history (< 1k entries). Power users
on `since=all` could push 10k. No streaming, no pagination, no bound.

**Approach**
Two compatible directions:

**A. Bound the `since=all` window.** Cheapest fix. Default `since=all`
to "all-time, but capped at 5 years." Users with longer history don't
notice (they don't aggregate 5+ years of restaurant picks); the query
plan stays predictable.

**B. Materialized view / scheduled rollup.** Compute the aggregates
nightly into a `insights_rollup` table; serve from there with a "as
of $TIMESTAMP" caveat. Heavier engineering; only worth it if power
users complain.

Ship A now. Plan for B if needed.

**Scope (option A)**
- [server/src/routes/users.ts](server/src/routes/users.ts): the `/me/insights` handler. Add a
  `MAX_INSIGHTS_WINDOW_DAYS = 5 * 365` constant. When `since='all'`,
  set `sinceDate` to `new Date(Date.now() - MAX...)`.
- Document in the response that `since=all` is capped (or surface as
  metadata field).

**Effort**
~0.5 days for option A. Option B is ~3 days.

**Risk**
Existing users with 5+ years of history (impossible today — the app
isn't that old) would see different numbers. Non-issue in practice.

**Sequencing**
Independent. Drop in whenever convenient.

---

## Tier 3 — nice to have

### #13 — Popover positioning duplicated

**Why**
[src/components/HeartWithKebab.jsx](src/components/HeartWithKebab.jsx) and the new
[src/components/HistoryRowKebab.jsx](src/components/HistoryRowKebab.jsx) (shipped this session) both
implement the same viewport-anchored portaled popover positioning
logic. Future kebabs will copy the pattern again.

**Approach**
Extract `useViewportAnchoredPopover(ref, isOpen)` hook returning
`{ position, isMeasured }`. Both components consume it.

**Effort**
~2 hours.

**Risk**
None — pure refactor.

---

### #14 — Magic numbers scattered across server

**Why**
`SPARKLINE_WEEKS=12`, `NEGLECT_THRESHOLD_DAYS=60`, `MAX_LISTS_PER_USER=50`,
`FAILED_LOGIN_LIMIT=8` (added this session), `LOCKOUT_DURATION_MS=30m`
all live as inline constants in their respective route files.

**Approach**
Move to `server/src/config/insights.ts`, `server/src/config/auth.ts`,
`server/src/config/limits.ts`. Document each with rationale.

**Effort**
~2 hours.

**Risk**
None.

---

### #15 — No feature flags

**Why**
Every change ships to 100%. The insights opt-out went out cold to all
users. A flag layer would let us canary the next risky change (e.g.
the `RestaurantDetailModal` decomposition above).

**Approach**
Cheapest: env-var-driven flags read at boot, exposed to client via
`/api/health` or a dedicated `/api/flags` endpoint. No external
service (LaunchDarkly, etc.) until the cost of one becomes obvious.

Schema sketch:
```ts
// server: src/lib/flags.ts
export const FLAGS = {
  newDetailModal: process.env.FLAG_NEW_DETAIL_MODAL === 'true',
  insightsOptOutVisible: process.env.FLAG_INSIGHTS_OPT_OUT !== 'false', // default on
};
// client: gated via /api/flags response on app boot
```

**Effort**
~1 day for the framework. Per-feature flag use is then ~10 LOC each.

**Risk**
Adding flags is easy; cleaning them up is the maintenance burden.
Discipline: every flag must have a removal-date comment when added.

---

### #16 — Refresh is pull-based; stale data accumulates

**Why**
Google Places data refreshes only when a user opens a restaurant card.
A row that nobody touches in 90 days stays stale. Affects opening
hours / phone / website that the user expects to be current.

**Approach**
Nightly background job: pick N oldest-stale rows where
`googleDataUpdatedAt < now() - 7 days`, refresh in parallel (with the
existing rate limit), update timestamps. ~50 LOC.

**Effort**
~0.5 days. Hardest part is deciding where to run it (App Runner
cron, AWS EventBridge, in-process node-cron).

**Risk**
Cost — every refresh hits Google Places (paid). Mitigation: cap N at
~200/day, monitor `api_usage` for spend, throttle if a budget cap
trips.

---

### #17 — Custom-restaurant linking complexity

**Why**
`mergeCustomIntoPlace` in [src/redux/slices/userInfoSlice.js](src/redux/slices/userInfoSlice.js) re-points
entries across favorites, options, accepted, lists, reviews, and notes
when a user-created restaurant is merged into a real Google Place.
Lots of surface to keep in sync; the kind of code where one missed
collection produces "I lost my reviews when I linked it."

**Approach**
Add a holistic E2E test (now that #2 is shipped):
1. Create a custom restaurant.
2. Add to favorites, options, accept it, write a review, add a note.
3. Link to a real place via `POST /restaurants/:id/link-to-place`.
4. Assert every collection points to the new id.

Then refactor the slice's `mergeCustomIntoPlace` so it iterates a
single `COLLECTIONS_TO_REMAP` list rather than 6 inline blocks. Removes
the "missed one" failure mode.

**Effort**
~1 day. Half is the E2E, half is the refactor.

**Risk**
Low — pure refactor with a regression-gate E2E.

---

## Effort summary

| Batch | Days |
|---|---|
| A (#6 + #7 + #8 — slice consolidation) | 5–8 |
| B (#9 + #10 — boundary hardening) | 4–6 |
| C (#11 + #12 + Tier 3) | 5–8 |
| **Total** | **14–22 days** |

That's roughly a 3-week sprint dedicated to debt, or 6 weeks if
interleaved with feature work. The senior tech-lead review recommended
6 weeks; this plan is consistent with that.

## What we won't do (yet)

- **#11 anonymous sessions** could grow into a larger refactor than
  estimated. If it does, fall back to option B (centralize the
  dichotomy) and revisit option A in a dedicated sprint.
- **#15 feature flags + external service** — we're not ready for
  LaunchDarkly-tier complexity. Env-var-only first.
- **#12 materialized view for insights** — only if option A (window
  cap) proves insufficient.
