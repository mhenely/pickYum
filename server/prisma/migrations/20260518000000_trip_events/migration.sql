-- Extend GroupEvent for trip meal events (phase 2 of trips).
-- Polymorphism: a GroupEvent now belongs to either a Group OR a Trip — never
-- both, never neither. A CHECK constraint at the bottom enforces that.

-- ── Enum for the optional meal slot ──────────────────────────────
-- Only meaningful on trip events (group events use the GroupVoteMethod /
-- name combo for context). Snack is the catch-all for coffee, drinks, etc.
CREATE TYPE "MealSlot" AS ENUM ('BREAKFAST', 'LUNCH', 'DINNER', 'SNACK');

-- ── New columns on group_events ──────────────────────────────────
-- All nullable so existing rows (all group-scoped) remain valid. The empty
-- array default on participant_user_ids matches Prisma's behavior for a
-- non-nullable Int[]; for our polymorphism, the application uses NULL/[]
-- on group events and a populated array (or [] = "all members") on trip
-- events.
ALTER TABLE "group_events"
  ALTER COLUMN "group_id" DROP NOT NULL;

ALTER TABLE "group_events"
  ADD COLUMN "trip_id" INTEGER,
  ADD COLUMN "meal_slot" "MealSlot",
  ADD COLUMN "participant_user_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];

-- ── FK + index for the trip side ─────────────────────────────────
-- Cascade matches the groupId FK so deleting a trip cleans up its events.
ALTER TABLE "group_events"
  ADD CONSTRAINT "group_events_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trips"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "group_events_trip_id_idx" ON "group_events"("trip_id");

-- ── Polymorphism guard ───────────────────────────────────────────
-- Exactly one of (group_id, trip_id) must be set. The XOR pattern via
-- num_nonnulls() reads more naturally than the OR/AND combination.
ALTER TABLE "group_events"
  ADD CONSTRAINT "group_events_parent_xor"
  CHECK (num_nonnulls("group_id", "trip_id") = 1);
