-- Add geo columns to Restaurant for map rendering on the Compare page.
-- Both nullable so existing rows continue to validate (lat/lng will be
-- back-filled lazily by refresh-places as places come up for refresh,
-- and captured at create-time for new Google-Place-backed rows).
ALTER TABLE "restaurants" ADD COLUMN "lat" DOUBLE PRECISION,
                          ADD COLUMN "lng" DOUBLE PRECISION;
