-- ── Multi-list favorites: backfill ─────────────────────────────
-- For every user who has at least one row in the legacy
-- `user_favorites` table, create a default "My Favorites" list and
-- copy each favorite into it as a FavoriteListEntry.
--
-- Idempotent — re-running is safe:
--   * The default-list insert uses ON CONFLICT on the per-user name
--     unique index, so already-backfilled users are left alone.
--   * The entry insert uses ON CONFLICT on the composite PK, so
--     re-runs don't duplicate rows.
--
-- The legacy `user_favorites` table is NOT dropped here. It sits as
-- a shadow / safety net during v1 rollout; a later migration drops
-- it once we've confirmed no incident reports.

-- 1. One default list per user with existing favorites.
INSERT INTO "favorite_lists" ("user_id", "name", "is_default", "position", "created_at")
SELECT DISTINCT uf."user_id", 'My Favorites', true, 0, NOW()
FROM "user_favorites" uf
ON CONFLICT ("user_id", "name") DO NOTHING;

-- 2. Copy every existing favorite row into the new default list,
--    preserving the original `created_at` as the entry's `added_at`
--    so timestamps reflect the user's actual favoriting history.
INSERT INTO "favorite_list_entries" ("list_id", "restaurant_id", "added_at")
SELECT fl."id", uf."restaurant_id", uf."created_at"
FROM "user_favorites" uf
JOIN "favorite_lists" fl
  ON fl."user_id" = uf."user_id"
 AND fl."is_default" = true
ON CONFLICT ("list_id", "restaurant_id") DO NOTHING;
