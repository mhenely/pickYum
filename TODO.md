# TODO

Source of truth for outstanding work. Anything checked in here is paused
intentionally — pick from the relevant section when scheduling the next
batch of work.

Last reviewed: 2026-05-15

---

## Active

_Nothing actively in progress — the per-entry insights opt-out just
shipped (see Completed below). Pick the next item from one of the
deferred sections below._

---

## Deferred — Cost optimization & admin

Items spun off from the Tier 1–4 Google Places cost-optimization work.
4A + 4B (structured logging + `api_usage` table + Role-column admin
auth) shipped. Remaining:

- **Per-user rate limits** — limit users hitting Google Places too hard
  over a window. The `api_usage` table now exists as a counter source,
  so this is a thin policy layer on top:
  middleware reads the user's daily/hourly call count, returns 429 (or
  serves stale cache) past a threshold. Choose thresholds based on the
  first month of real `api_usage` data so they reflect normal use.
- **4C — admin cost dashboard** — surface the `api_usage` rollup in a
  protected admin page: per-user / per-endpoint / per-day cost +
  cache-hit ratio. Defer until the data justifies it (or to bundle
  with other admin features like user moderation).
- **Tier 2B — drop neighbor preload on photo carousels** — moot for
  cards now that 3B made cards single-photo, but the detail-modal
  gallery still preloads neighbors. Quick win if photo costs trend up.

---

## Deferred — Multi-list favorites follow-ups

Items deliberately out of v1 of the multi-list favorites sprint
(non-goals from the design doc). All schema decisions in v1 preserve
the option to ship these without another migration.

- **Migration 3 — drop legacy `user_favorites` table** — ship in a
  release **after** the multi-list sprint is in prod for ~1 week with
  no incident reports. The table sits unused as a shadow / safety net
  during the rollout; drop it deliberately, not as part of the same
  ship.
- **Group-owned favorite lists** — schema's polymorphic `(userId,
  groupId)` ownership column already supports it. Adds endpoint set
  under `/api/groups/:groupId/favorite-lists`, group-page UI surface.
  Est. ~1 day.
- **Shareable lists** — add `shareToken VARCHAR(32) UNIQUE NULL` on
  `FavoriteList`, read-only public view at `/lists/:shareToken`,
  rotation/revocation UI. ~1 day.
- **Smart lists** — `SmartListFilter` table, serialized filter
  criteria, server-side query on each read. Real cost is the filter-
  authoring UI; defer until users ask.
- **Bulk operations** — multi-select entry rows + "Move N entries to
  [list]" toolbar action. ~1 day after the entry-picker exists.
- **Drag-and-drop reordering** — lists ship with ↑ / ↓ buttons in v1;
  swap to DnD when there's a library choice we like or a strong UX
  request.
- **Trip integration of multi-list** — deliberately not extending
  `FavoriteList` into trip space; trips use the existing `TripAnchor`
  structure. Revisit only if trip sub-organization hits real friction.

---

## Deferred — Insights opt-out follow-ups

Spun off from the per-entry `excludeFromInsights` rollout (2026-05-15).
Schema already has the boolean column; route already filters on it;
client UI is a per-row kebab + a modal toggle. These would extend the
feature without re-touching the schema.

- **Bulk "exclude all my group picks"** — a one-shot action in
  Settings or HistoryPage header that flips every `chooseMethod='vote'`
  row to `excludeFromInsights=true` (and a paired "include all"
  unflip). Useful for power users who decide late that group history
  shouldn't count; cheap to add (single PATCH endpoint that filters
  by chooseMethod). Defer until users ask.
- **Smart auto-include "this was my pick"** — when a user themselves
  cast the winning vote in a group ballot, the accepted row could
  default `excludeFromInsights=false` even if a future "default-by-
  method" toggle is on. Needs care around what "winning vote" means
  in ranked-choice (own-rank vs. final-tally agreement) — defer until
  a real signal complaint surfaces.
- **Server-side default-by-method** — auto-set
  `excludeFromInsights=true` on creation for `chooseMethod='vote'`
  rows (group/trip ballots). Considered for v1 but defaulted to false
  to preserve "include by default, user opts out" semantics. Revisit
  if real usage shows most users immediately flip group picks off.
- **Per-visit (not per-restaurant) exclusion** — the kebab today
  flips every accepted row for a restaurant in one shot (semantic
  match: "should this place count?"). A per-row override could live
  inside the detail modal's reviews list if users ever want
  "exclude my Tuesday visit but keep my Friday one."

---

## Deferred — Other

- **`AuthenticationPage.jsx`** — file still exists as an empty stub.
  All real auth is via `/login`, `/register`, `/forgot-password`,
  `/reset-password`, `/verify-email`. Either delete the stub or
  repurpose it as an account-settings landing page.
- **Star-rating partial display** — the `partial` CSS class in
  `star-rating.styles.css` is never triggered (ratings are always
  integers). Implement fractional rendering if/when half-stars become
  a thing.
- **Error boundaries on individual routes** — top-level Sentry catches
  crashes, but route-level boundaries would give per-page fallback UI
  instead of whitescreen on a single page's bug. Low priority.

---

## Completed (recent — abridged)

A running log of larger pieces of work, most-recent first. Older
single-file fixes aren't tracked here — git history is the source.

- [x] **Per-entry insights opt-out (2026-05-15)** —
      `UserAccepted.excludeFromInsights` boolean column +
      idempotent migration; `PATCH /me/accepted/:id` with ownership-
      via-updateMany 404 semantics; all four UserAccepted reads in
      `/me/insights` (main rollup + neglectedFavorites' lastChosen +
      sparkline + previousPeriodCount) filter on the flag so excluded
      rows never reach any panel; `/me/all` + `/me/accepted` extended
      with `id` + `excludeFromInsights` projections so the client can
      target rows for PATCH without a separate fetch. Redux accepted
      shape extended `{ id, excludeFromInsights }`; new optimistic
      `toggleAcceptedExcludeFromInsights` thunk with rollback; listener
      middleware backfills the server row id onto optimistic appends
      via `reconcileAcceptedRowId`. UI: new `<HistoryRowKebab>` (single-
      action menu + "off-record" badge) sits beside `<HeartWithKebab>`
      on each history row; labeled checkbox + explainer in
      `RestaurantDetailModal` when opened from History. Targeted
      `invalidateInsightsCache()` in api.ts overrides the standard
      INVALIDATION_SAFE_PATHS shortcut for this specific mutation.
      8 new server tests + 5 new slice tests (334 server / 128
      frontend total passing).
- [x] **Multi-list favorites (full sprint, 2026-05-15)** —
      FavoriteList + FavoriteListEntry tables with polymorphic
      owner XOR + backfill from legacy `user_favorites`; full CRUD
      API surface incl. promote-default and reorder; auto-create
      "My Favorites" on registration; /me/all bumped to
      apiVersion 2 with `favoriteLists` inline; Redux slice +
      selectors in `src/utils/favoriteLists.js`; legacy
      `updateUserFavorites` routed through the new
      favorite-list-entry endpoint via the listener middleware;
      new components: `HeartWithKebab`, `ListPicker`,
      `ListSelector`, `ListManagementModal`; integrated on Search
      ("Your Lists" rework), Compare + Choose favorites sidebars,
      and every card via `cornerSlot`. 19 new server tests + 18
      new frontend tests. Design doc:
      [FAVORITES_LISTS_DESIGN.md](FAVORITES_LISTS_DESIGN.md).
- [x] **Cost-tracking instrumentation (Tier 4A + 4B)** — structured
      pino logs on every Google call + `api_usage` table + composite
      PK rollup; Role-column admin auth ready for 4C dashboard work
- [x] **On-demand refresh + photo tightening (Tier 2A + 3B + 3C)** —
      per-restaurant `POST /me/refresh-restaurant/:id`, single-photo
      hero on cards, "Updated X ago" indicator
- [x] **Photo URL cache (Tier 1)** — Redis + in-memory cache keyed by
      `(photoName, maxWidthPx)`; bumped nearby/geocode/photo-URL TTLs;
      `STALE_DAYS=90`
- [x] **Universal Choose-Now celebration** — global `<ChosenCelebration>`
      modal mounted in `App.tsx`; dispatched from coin flip, roulette,
      surprise me, Compare-page Choose-Now, group votes
- [x] **Custom-to-Places matching** — `/restaurants/:customId/link-to-place`
      merge with collision handling; per-restaurant
      `excludeFromPlaceMatching` opt-out
- [x] **`/me/all` Option-B refactor** — deduped `restaurants[]` +
      ID-only collection arrays + `apiVersion: 1` for future migrations
- [x] **Detail-modal unification** — `RestaurantDetailModal` used
      everywhere (Compare, Choose, History, group voting); deleted
      `AcceptModal`, swapped out `PublicRestaurantInfoModal`
- [x] **Compare/Choose card upgrade** — full md-size cards with
      scroll containers, left-side scrollbars, live "n / total"
      scroll-position counters
- [x] **Cuisine-type filter** — filtered at the Google Places API
      call level via the searchNearby `includedTypes`
- [x] **Hours / ratings / photos UX polish** — collapsible hours
      table, compact tri-card rating chip, photo gallery arrow nav,
      open-status badge
- [x] **Photo proxy CORP** — `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`
      fixed by route-level CORP header middleware applied before the
      rate limiter; `/photo` moved above the auth gate
- [x] **Auth + backend integration** — JWT cookie auth,
      Prisma+Supabase, Resend email, Redis fan-out, Sentry, full
      route-test suite (currently 307 passing on the server)
- [x] **Initial app scaffolding** — Vite + React + Redux Toolkit;
      route-based code splitting; `useCurrentUser` hook; `.env.example`
