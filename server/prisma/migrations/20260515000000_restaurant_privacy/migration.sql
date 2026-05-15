-- Add per-user visibility to custom restaurant entries.
--
-- Going forward, a Restaurant row with no googlePlaceId (i.e. typed by a user
-- as a custom entry) is created with private = true so it's visible only to
-- the creator. Google-sourced entries (with googlePlaceId) remain public.
--
-- Existing rows default to private = false so favorites/options pointing at
-- pre-rollout custom entries don't suddenly disappear for non-creators. Only
-- entries created after this migration adopt the new private-by-default behavior.

ALTER TABLE "restaurants" ADD COLUMN "private" BOOLEAN NOT NULL DEFAULT false;
