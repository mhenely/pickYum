# Multi-List Favorites — Sprint Design Doc

> **Status**: shipped 2026-05-15. Kept for reference + as the source
> for follow-up work (group lists, shareable lists, smart lists,
> Migration 3 — see [TODO.md](TODO.md) for the remaining queue).
> **Estimate (original)**: 3-4 days of focused work for v1 ship.
> **Context**: replaces single-bucket `UserFavorite` with named, user-organized
> lists. Solves the "favorites devolve into a junk drawer" problem and gives
> the Search-page Saved section a genuine purpose.

This doc is the source of truth for the sprint. If the working session gets
interrupted, pick up from the "Sprint scope checklist" near the bottom.

---

## Goals

1. Users can create multiple named favorite lists (e.g. "Date Night",
   "Tokyo 2026", "Weekday Lunch").
2. The Search-page "Saved Restaurants" section is repurposed as the
   user-facing favorites surface (the "Your Lists" surface). The current
   grab-bag of every-restaurant-Redux-has-seen goes away.
3. List selection is a viewing concern on Compare, Choose, and Search —
   the same user can switch between lists to see different sidebar /
   strip contents.
4. Existing single-list users experience zero workflow change. Heart icon
   still works exactly as today. New feature is opt-in via list creation.
5. Schema design today preserves the option to add group-owned lists
   later without a follow-up migration.

## Non-goals (for v1)

These are deliberately out of scope:

- **Drag-and-drop reordering** of lists or entries (use up/down buttons)
- **Shareable lists** — viewable / editable by other users via link
- **Smart lists** / saved queries (e.g. "Italian places I haven't visited
  in 6 months")
- **Bulk operations** (multi-select + move/copy entries between lists)
- **Group-owned lists** — schema supports them via the polymorphic owner
  column, but UI + group endpoints don't ship in v1
- **Trip-favorite multi-list** — trips have their own anchor-based
  structure; not extending lists into that surface
- **"All favorites" virtual list** showing union of all lists — optional;
  skip unless it falls out for free

## Current state (what's being replaced)

- `UserFavorite` table — flat (user_id, restaurant_id) rows
- `state.userInfo.users[0].favorites` — array of stringified restaurant IDs
- Heart icon on cards toggles membership in this single bucket
- Compare/Choose sidebars + the Search-page Saved section all read from
  the same flat list (Search section also reads broader
  `customRestaurants` and is the surface getting the most rework)

---

## Data model

Two new tables. Schema uses polymorphic ownership (`user_id` OR `group_id`,
exactly one non-null) so group lists can ship later without a second
migration.

```prisma
model FavoriteList {
  id          Int       @id @default(autoincrement())
  userId      Int?      @map("user_id")   // exactly one of
  groupId     Int?      @map("group_id")  // userId / groupId is non-null
  name        String    // "My Favorites", "Date Night", "Tokyo 2026"
  description String?   // optional, capped server-side (~280 chars)
  // 7-char hex including leading "#" (e.g. "#FF8800"). Server validates;
  // null = use default neutral chip color in the UI.
  color       String?   @db.VarChar(7)
  isDefault   Boolean   @default(false) @map("is_default")
  // User-controlled ordering of lists in selectors / management. App
  // sorts ascending. Not unique — reorder is "rewrite all rows with
  // new positions" not "swap two."
  position    Int       @default(0)
  createdAt   DateTime  @default(now()) @map("created_at")

  user        User?                @relation(fields: [userId], references: [id], onDelete: Cascade)
  group       Group?               @relation(fields: [groupId], references: [id], onDelete: Cascade)
  entries     FavoriteListEntry[]

  @@unique([userId, name])  // a user can't have two lists with the same name
  @@index([userId])
  @@index([groupId])
  @@map("favorite_lists")
}

model FavoriteListEntry {
  listId       Int      @map("list_id")
  restaurantId Int      @map("restaurant_id")
  // Free-form note scoped to THIS entry in THIS list ("go for happy
  // hour", "must-try the omakase"). Distinct from the global per-
  // restaurant note in userInfo.notes (which applies regardless of
  // which list the row belongs to). Capped server-side at ~280 chars.
  note         String?
  addedAt      DateTime @default(now()) @map("added_at")

  list       FavoriteList @relation(fields: [listId], references: [id], onDelete: Cascade)
  restaurant Restaurant   @relation(fields: [restaurantId], references: [id], onDelete: Cascade)

  @@id([listId, restaurantId])  // a restaurant can appear once per list
  @@index([restaurantId])
  @@map("favorite_list_entries")
}
```

### Schema-level constraint (raw SQL in the migration)

Prisma doesn't model XOR constraints natively. Add it as raw SQL in the
migration file:

```sql
ALTER TABLE "favorite_lists"
  ADD CONSTRAINT "favorite_lists_owner_xor"
  CHECK (("user_id" IS NULL) != ("group_id" IS NULL));
```

### Notes on design choices

- **Composite PK on entries** (listId, restaurantId): a restaurant can be in
  multiple lists; within one list it appears once. The PK enforces both.
- **`UNIQUE(userId, name)`**: prevents the user from creating two lists
  named "Date Night." Case-sensitive — citext is overkill here; UI can
  do a soft check before submitting.
- **No FK on `Restaurant.id` cascade**: actually we DO want cascade —
  if a restaurant gets deleted from the system the entry should disappear.
  Already specified above.
- **`position` is not unique**: simple integer, app rewrites all positions
  on reorder. For < 50 lists per user, perfectly fine.
- **`color` as nullable VARCHAR(7)** rather than an enum: allows arbitrary
  palette flexibility without re-migrating when the design team picks a
  different accent.

### Polymorphic-owner trade-offs

Two ways to model this:
- **Separate tables** (`UserFavoriteList` + `GroupFavoriteList`):
  simpler per-table schema, lots of code duplication.
- **Polymorphic with XOR** (chosen): one table, one set of endpoints,
  auth logic differs per ownership type.

Polymorphic chosen because the schema cost is one extra column + one
CHECK constraint, and the option to add group lists later without
migration is meaningfully valuable. If group lists never ship, the
polymorphic column sits unused at zero cost.

---

## Migration plan

Three SQL migrations, applied in order:

### Migration 1 — Create new tables

`<timestamp>_favorite_lists_schema/migration.sql`

```sql
CREATE TABLE "favorite_lists" ( /* per Prisma model above */ );
CREATE TABLE "favorite_list_entries" ( /* per Prisma model above */ );
ALTER TABLE "favorite_lists" ADD CONSTRAINT "favorite_lists_owner_xor" CHECK (...);
-- indexes per @@index
```

### Migration 2 — Backfill default list for every user with favorites

`<timestamp>_favorite_lists_backfill/migration.sql`

```sql
-- One default list per user who has at least one row in user_favorites
INSERT INTO favorite_lists (user_id, name, is_default, position, created_at)
  SELECT DISTINCT user_id, 'My Favorites', true, 0, NOW()
  FROM user_favorites
  ON CONFLICT (user_id, name) DO NOTHING;

-- Copy entries from the old flat favorites into the new default list
INSERT INTO favorite_list_entries (list_id, restaurant_id, added_at)
  SELECT fl.id, uf.restaurant_id, uf.created_at
  FROM user_favorites uf
  JOIN favorite_lists fl ON fl.user_id = uf.user_id AND fl.is_default = true
  ON CONFLICT (list_id, restaurant_id) DO NOTHING;
```

### Migration 3 (deferred — only after confirming v1 works in prod)

`<timestamp>_drop_user_favorites/migration.sql`

```sql
DROP TABLE "user_favorites";
```

**Important**: ship Migration 3 in a separate later release. During the v1
rollout, `user_favorites` continues to exist as a shadow / fallback. The
server reads from `favorite_lists` going forward; the legacy table is
purely insurance. Drop it after confirming no incident reports for
~1 week.

---

## API surface

All endpoints user-scoped via `requireAuth`. Group-owned variants are NOT
in v1 — the polymorphic column means they're trivially added later
without breaking these endpoints.

| Method | Path | Body / params | Returns |
|---|---|---|---|
| GET | `/api/users/me/favorite-lists` | — | `{ lists: FavoriteList[] }` (with embedded entries) |
| POST | `/api/users/me/favorite-lists` | `{ name, description?, color? }` | `{ list }` |
| PATCH | `/api/users/me/favorite-lists/:id` | `{ name?, description?, color? }` | `{ list }` |
| DELETE | `/api/users/me/favorite-lists/:id` | — | `{ ok: true }` (404 if default — see below) |
| POST | `/api/users/me/favorite-lists/:id/default` | — | `{ list }` (promotes to default; clears other defaults) |
| POST | `/api/users/me/favorite-lists/:id/entries` | `{ restaurantId, note? }` | `{ entry }` |
| DELETE | `/api/users/me/favorite-lists/:id/entries/:rid` | — | `{ ok: true }` |
| PATCH | `/api/users/me/favorite-lists/:id/entries/:rid` | `{ note }` | `{ entry }` |
| PATCH | `/api/users/me/favorite-lists/positions` | `{ order: [listId, listId, ...] }` | `{ ok: true }` (rewrites positions) |

### Default-list deletion rule

The user's default list cannot be deleted while it's marked default. The
DELETE endpoint returns 400 ("Cannot delete the default list — promote
another first"). UI surfaces this with a clear hint. If user wants to
delete the default, they must first promote another list, then delete.

For users who only have one list (the default): the delete endpoint
returns 400 ("Cannot delete your only list"). Users must always have at
least one list — the system creates "My Favorites" automatically on
account creation, and prevents the last one from being removed.

### `/api/users/me/all` extended

The `/me/all` response gains a `favoriteLists` field. The existing
`favoriteIds` field stays during the transition (computed as
`entries of the default list`) for backward compat with any cached
clients during deploy. Drop `favoriteIds` from the response shape in a
future minor bump after confirming no cached old clients in the wild.

```jsonc
{
  "apiVersion": 2,  // bump from 1
  "restaurants": [...],
  "favoriteIds": [...],     // DEPRECATED — entries of default list
  "favoriteLists": [
    {
      "id": 1,
      "name": "My Favorites",
      "description": null,
      "color": null,
      "isDefault": true,
      "position": 0,
      "createdAt": "...",
      "entries": [{ "restaurantId": 42, "note": null, "addedAt": "..." }, ...]
    },
    { /* more lists */ }
  ],
  // ... other unchanged fields
}
```

Bump `apiVersion` to 2 (was 1 from the earlier Option-B rework). The
slice's forward-compat warning catches any client that doesn't recognize
v2.

---

## Frontend Redux state

`userInfo` slice gains a new top-level `favoriteLists` shape:

```js
state.userInfo.favoriteLists = {
  byId: {
    [listId]: {
      id: number,
      name: string,
      description: string | null,
      color: string | null,
      isDefault: boolean,
      position: number,
      entries: [{ restaurantId: string, note: string | null, addedAt: string }],
    },
  },
  order: [listId, ...],   // sorted by position
  defaultId: listId | null,
  // UI state — which list the user is currently viewing. Persisted to
  // localStorage for guests, server-side preference for authed users (or
  // just default-list fallback). Each page can override (Compare might
  // remember a different active list than Search).
  activeId: listId | null,
};
```

### Selectors / helpers (new file: `src/utils/favoriteLists.js`)

```js
export const isInDefaultList = (state, restaurantId) => { ... };
export const listsContaining = (state, restaurantId) => [...];  // for kebab pre-checked state
export const activeListEntries = (state) => [...];               // for page surfaces
export const defaultList = (state) => state.userInfo.favoriteLists.byId[state.userInfo.favoriteLists.defaultId];
```

### Backward-compat selector

Code that reads `userInfo.favorites` (the legacy array) continues to work
because we expose a derived selector:

```js
export const legacyFavoritesArray = (state) => {
  const defaultListId = state.userInfo.favoriteLists.defaultId;
  if (!defaultListId) return [];
  return state.userInfo.favoriteLists.byId[defaultListId].entries.map(e => String(e.restaurantId));
};
```

Existing code reading `userInfo.favorites` is migrated to use this
selector. Once nothing reads the raw `favorites` array, drop it from the
slice in a cleanup pass.

---

## UX patterns

### Heart icon (the key invariant)

**Heart icon always toggles membership in the user's default list.**
Never changes behavior. Never opens a chooser. This is the consistent
single-click affordance that single-list users get and multi-list users
expect.

Rationale: if heart behavior scaled with list count (the user's original
proposed option C), the moment a user creates their second list the icon
silently changes meaning. That's a surprise — bad UX. Instead, multi-list
users get explicit control via the kebab.

### Kebab next to heart

A small kebab (⋮) or "+ list" icon adjacent to the heart opens a
multi-select popover listing all the user's lists. Each list has a
checkbox indicating current membership. User toggles, hits "Save."

- **Hidden** for users with only one list (the default) — no other lists
  to pick from, no UI noise.
- **Shown** for users with 2+ lists.

### List selector (`<ListSelector>` component)

Pill-style or compact dropdown that picks which list's entries the
surrounding surface displays.

Used in:
- Search page "Your Lists" section header
- Compare page favorites sidebar header
- Choose page favorites strip header

The selector is independent across pages — Compare can be viewing
"Daily Spots" while Search shows "Date Night." Persisted in
sessionStorage so navigating between pages preserves the user's view
within the session.

Each list option in the dropdown shows: color swatch · name · entry count.

### List management surface

Modal or dedicated page (TBD — recommend modal for v1 — see "Open
questions"). Surfaces:

- List of all user's lists, each with: color swatch, name, entry count,
  reorder buttons (↑ / ↓), edit button, delete button (greyed for default)
- "New list" button — opens an inline create form (name, description,
  color picker)
- Edit form for an individual list (rename, change color, change
  description, promote to default)

Color picker is a small palette of ~8 preset colors (no hex input — keeps
the UI scoped and the brand cohesive). Server validates against the
allowed palette.

### Per-list views on pages

**Search page** — "Your Lists" section (replaces current "Saved Restaurants"):
- List selector at top
- Below: cards for the selected list's entries (filtered by current
  Filter panel state, sorted by current Sort state)
- Empty state: "Create your first list" with quick-create UI

**Compare page favorites sidebar**:
- List selector at top of sidebar
- Below: card stack of selected list's entries
- "All favorites" pseudo-option that shows union of all lists' entries
  (treated as a deduplicated set). Defaults to first list, not "All."

**Choose page favorites strip**:
- Same pattern: list selector + entries-of-selected-list

### Detail modal

The heart icon stays single-click default-list-toggle. Adjacent kebab
opens the multi-list picker (same component as on cards).

---

## Component plan

### New components

| Component | Location | Purpose |
|---|---|---|
| `<ListSelector>` | `components/ListSelector.jsx` | Compact dropdown for picking active list |
| `<ListPicker>` | `components/ListPicker.jsx` | Multi-select popover for kebab |
| `<ListManagementModal>` | `components/ListManagementModal.jsx` | Full CRUD UI |
| `<HeartWithKebab>` | `components/HeartWithKebab.jsx` | Wraps existing heart + adds kebab |

### Existing components changed

| File | Change |
|---|---|
| `RestaurantCard.jsx` | Replace heart slot with `<HeartWithKebab>` |
| `RestaurantDetailModal.jsx` | Same heart replacement |
| `SearchPage.jsx` | Saved section becomes "Your Lists" |
| `RestaurantPage.jsx` (Compare) | Favorites sidebar gets `<ListSelector>` |
| `HelpMeChoosePage.jsx` | Favorites strip gets `<ListSelector>` |

### State management

| File | Change |
|---|---|
| `userInfoSlice.js` | Add `favoriteLists` shape + reducers |
| `api.ts` | New client methods for all the list endpoints |
| `utils/favoriteLists.js` | New helpers / selectors |

---

## Sprint scope checklist

This is the explicit IN-scope list. Check items off as they ship.

### Schema + migration

- [ ] Prisma schema additions (FavoriteList, FavoriteListEntry,
      User.favoriteLists relation, Group.favoriteLists relation)
- [ ] Migration 1: create tables + XOR constraint
- [ ] Migration 2: backfill default list + entries from
      `user_favorites`
- [ ] Verify backfill on dev DB; spot-check a few users have correct
      default-list entries

### Server endpoints

- [ ] `GET /api/users/me/favorite-lists`
- [ ] `POST /api/users/me/favorite-lists`
- [ ] `PATCH /api/users/me/favorite-lists/:id`
- [ ] `DELETE /api/users/me/favorite-lists/:id` (with default-list guard)
- [ ] `POST /api/users/me/favorite-lists/:id/default`
- [ ] `POST /api/users/me/favorite-lists/:id/entries`
- [ ] `DELETE /api/users/me/favorite-lists/:id/entries/:rid`
- [ ] `PATCH /api/users/me/favorite-lists/:id/entries/:rid`
- [ ] `PATCH /api/users/me/favorite-lists/positions`
- [ ] `/api/users/me/all` includes `favoriteLists` (apiVersion=2)
- [ ] Auto-create "My Favorites" default list on user registration

### Auth + validation

- [ ] All endpoints require auth
- [ ] Ownership check: user can only see/modify lists where userId =
      req.userId
- [ ] Name uniqueness check (per user)
- [ ] Color validation (server-side palette allowlist)
- [ ] Note + description length caps (~280 chars)
- [ ] Cannot delete the default list while it's default
- [ ] Cannot delete the user's only list

### Frontend state

- [ ] Redux slice changes — `favoriteLists` shape + reducers
- [ ] API client methods for all list endpoints
- [ ] Selectors / helpers in `utils/favoriteLists.js`
- [ ] Backward-compat selector for legacy `favorites` array
- [ ] Migrate every existing `userInfo.favorites` read to use the
      selector

### Components

- [ ] `<ListSelector>` component
- [ ] `<ListPicker>` component (kebab popover)
- [ ] `<ListManagementModal>` component
- [ ] `<HeartWithKebab>` component (replaces standalone heart)

### Per-page integration

- [ ] Search page: Saved section → Your Lists rework
- [ ] Compare favorites sidebar: ListSelector wired
- [ ] Choose favorites strip: ListSelector wired
- [ ] Detail modal: HeartWithKebab swapped in
- [ ] All cards: HeartWithKebab swapped in

### Tests

- [ ] Server tests for each list CRUD endpoint (auth, ownership,
      uniqueness, default-list guards)
- [ ] Migration sanity (backfill correctness)
- [ ] Frontend tests for slice reducers
- [ ] Frontend tests for key selectors (`isInDefaultList`,
      `listsContaining`, `activeListEntries`)

### Polish + ops

- [ ] Verify all existing tests still pass after migration
- [ ] Check `/me/all` payload shape change doesn't break older clients
      (apiVersion bump should catch this in dev)
- [ ] Quick smoke test of full flow: create list → add restaurants →
      switch active → kebab multi-add → rename → reorder → delete

---

## Open questions for the user (resolve at sprint start)

1. **List management surface: modal vs page?** Modal is faster to build
   (~half the code) and keeps users on whatever page they were on.
   Dedicated page (`/lists` or `/account/lists`) feels more discoverable
   and gives room for future polish. **Recommend modal for v1.**

2. **Color palette: hex input vs preset palette?** Recommend preset
   palette of 8 colors (orange, red, blue, green, purple, pink, gray,
   amber). Keeps the visual style cohesive and limits future regret.

3. **"All favorites" virtual list option in selectors**: cheap to add as
   a "Combine all lists" option in `<ListSelector>` that unions entries
   across the user's lists. Useful for Compare/Choose where the user
   might want broad access. **Recommend including.**

4. **Default-list name on new accounts**: "My Favorites" is reasonable;
   could also be "Favorites" or have user choose during onboarding.
   **Recommend "My Favorites" with the user free to rename.**

5. **Should the heart-icon kebab's multi-list picker include an option
   to ADD a new list inline?** Probably yes for power users — saves a
   navigation. Phase-1 or phase-1.5 decision.

---

## Future work (designed for, not built in v1)

### Group-owned lists

The polymorphic `(userId, groupId)` ownership column means this is
purely an endpoint addition:

- `GET/POST/PATCH/DELETE /api/groups/:groupId/favorite-lists` — same
  shape as the user-owned variants
- Group lists viewable by group members; mutable by group hosts (or
  optionally any member — policy TBD)
- Group page UI gets its own list management surface

Estimated effort once v1 ships: ~1 day. Schema is already there.

### Shareable lists

Add a `shareToken VARCHAR(32) UNIQUE NULL` column on `FavoriteList`.
Read-only public view via `/lists/:shareToken`. Token rotation /
revocation via UI. ~1 day.

### Smart lists

A `SmartListFilter` table with one row per smart list, storing serialized
filter criteria. Server computes entries on-the-fly. Real complexity in
the UI for filter authoring; defer until users ask.

### Bulk operations

Multi-select on the list view + "Move N entries to [list]" toolbar
action. ~1 day once you have the UI for entry-picker selection.

### Trip integration

Trips intentionally don't get multi-list. If sub-organization within a
trip is needed, use the existing `TripAnchor` structure (Rome lunches,
Florence dinners, etc.). Don't extend `FavoriteList` into trip space.

---

## Effort estimate

| Block | Hours |
|---|---|
| Schema + migration | 4 |
| Server endpoints (CRUD + entries + reorder + /me/all update) | 8 |
| Redux slice + helpers + API client | 4 |
| `<ListManagementModal>` | 4 |
| `<ListSelector>` + `<ListPicker>` | 3 |
| `<HeartWithKebab>` integration | 3 |
| Per-page integration (Search / Compare / Choose / detail modal) | 6 |
| Tests | 4 |
| Polish + bug fixes | 4 |
| **Total** | **~40 hours** |

That's roughly 3-4 working days of focused work. Realistic given the
codebase's existing patterns (mature schema/migration tooling, mature
React+Redux patterns, comprehensive existing tests).

---

## Risk areas + mitigations

1. **Migration data integrity** — existing favorites lost if backfill has
   a bug. Mitigation: keep `user_favorites` table during v1 rollout as
   read-only shadow; verify no incident reports before dropping in a
   later release.

2. **`apiVersion` bump breaks cached clients** — old client + new server
   sees `favoriteLists` in /me/all and might choke. Mitigation: the
   existing slice already logs a warn on `apiVersion > 1`; clients
   forward-compat for unknown fields (additive change). Verify before
   ship.

3. **Heart icon semantic drift** — if implementation accidentally has
   heart-icon behavior change when user creates 2nd list, that's exactly
   the surprise we're trying to avoid. Mitigation: have a clear test
   case asserting heart toggles default-list membership regardless of
   list count.

4. **Tests that assume single-list favorites** — many existing tests use
   `userInfo.favorites` as a flat array. Audit + update via the
   backward-compat selector.

5. **Per-page active list state leaking** — if Search remembers "Date
   Night" as active and Compare also defaults to "Date Night" even
   though the user wanted "Daily Spots" there, that's annoying.
   Mitigation: per-page sessionStorage key, not a single global
   "activeListId."

---

## Pickup notes (in case context is lost mid-sprint)

If a future session resumes mid-sprint, the order to verify what's done:

1. Run `git diff --stat main` (or current branch's base) to see which
   files have been touched.
2. Check the schema file — has `FavoriteList` model been added? If yes,
   schema work is at least started.
3. Check `server/prisma/migrations/` for any `favorite_lists*` directories.
   Run `npx prisma migrate status` to verify they've been applied.
4. Grep `src/utils/favoriteLists` — if the helpers file exists, the
   frontend work has begun.
5. Use the **Sprint scope checklist** above to identify what's still
   pending.

Common pitfalls to watch for:
- Migration 1 must run before Migration 2 (the backfill SELECTs from the
  new tables).
- The `XOR` CHECK constraint goes in Migration 1's raw SQL, not the
  Prisma model.
- After schema changes, run `npx prisma generate` before TypeScript will
  see the new model types.
- `/me/all` payload shape is consumed by `userInfoSlice.loadUserData` —
  update both server response shape AND client consumer in sync.

End of doc.
