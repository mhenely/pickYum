-- Structured Google Places opening hours, captured at materialize time
-- and refreshed by the periodic refresh-places sweep. The client uses
-- `periods` to compute fresh open-now / closing-soon status and
-- `weekdayDescriptions` to render the readable hours table in the
-- restaurant detail modal. Null for custom user-typed rows.
ALTER TABLE "restaurants"
  ADD COLUMN "regular_opening_hours" JSONB;
