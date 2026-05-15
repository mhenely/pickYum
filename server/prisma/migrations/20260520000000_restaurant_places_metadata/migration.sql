-- Restaurant: cache Google Places "Pro / Enterprise tier" fields so the
-- UI doesn't have to re-hit the API for already-materialized rows.
--
-- All three columns are nullable for two reasons:
--   1. Custom user-typed restaurants (no Google data) keep them null.
--   2. Pre-existing rows materialized before this migration ran also
--      keep them null; the refresh-places sweeper populates them over
--      time as rows fall into the staleness window.

ALTER TABLE "restaurants"
  ADD COLUMN "photos"         JSONB,
  ADD COLUMN "rating_count"   INTEGER,
  ADD COLUMN "google_reviews" JSONB;
