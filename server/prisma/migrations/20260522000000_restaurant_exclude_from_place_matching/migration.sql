-- Per-row opt-out flag for the post-search "is this custom row a match
-- for a Google result?" suggestion scan. Defaults to false so all
-- existing custom rows remain matchable; users can flip it to true
-- via the "Stop asking" button on the match-confirm modal or the
-- detail-modal toggle for custom restaurants.
ALTER TABLE "restaurants"
  ADD COLUMN "exclude_from_place_matching" BOOLEAN NOT NULL DEFAULT FALSE;
