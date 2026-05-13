-- Rename selections → options across the schema. Pure rename, no data loss:
-- tables, columns, indexes, constraints, and foreign keys all get new names.
-- Done as ALTER TABLE … RENAME so existing rows survive untouched.

-- ── user_selections → user_options ─────────────────────────────────────────
ALTER TABLE "user_selections" RENAME TO "user_options";
ALTER TABLE "user_options" RENAME CONSTRAINT "user_selections_pkey" TO "user_options_pkey";
ALTER TABLE "user_options" RENAME CONSTRAINT "user_selections_user_id_fkey" TO "user_options_user_id_fkey";
ALTER TABLE "user_options" RENAME CONSTRAINT "user_selections_restaurant_id_fkey" TO "user_options_restaurant_id_fkey";
ALTER INDEX "user_selections_restaurant_id_idx" RENAME TO "user_options_restaurant_id_idx";

-- ── group_event_selections → group_event_options ──────────────────────────
ALTER TABLE "group_event_selections" RENAME TO "group_event_options";
ALTER TABLE "group_event_options" RENAME CONSTRAINT "group_event_selections_pkey" TO "group_event_options_pkey";
ALTER TABLE "group_event_options" RENAME CONSTRAINT "group_event_selections_event_id_fkey" TO "group_event_options_event_id_fkey";
ALTER TABLE "group_event_options" RENAME CONSTRAINT "group_event_selections_restaurant_id_fkey" TO "group_event_options_restaurant_id_fkey";
ALTER TABLE "group_event_options" RENAME CONSTRAINT "group_event_selections_added_by_id_fkey" TO "group_event_options_added_by_id_fkey";
ALTER INDEX "group_event_selections_event_id_idx" RENAME TO "group_event_options_event_id_idx";
ALTER INDEX "group_event_selections_restaurant_id_idx" RENAME TO "group_event_options_restaurant_id_idx";
ALTER INDEX "group_event_selections_event_id_restaurant_id_key" RENAME TO "group_event_options_event_id_restaurant_id_key";

-- ── user_accepted.selections_snapshot → options_snapshot ──────────────────
ALTER TABLE "user_accepted" RENAME COLUMN "selections_snapshot" TO "options_snapshot";
