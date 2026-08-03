-- Overture identity on Restaurant — open-data twin of google_place_id.
-- Nullable + unique; existing rows unaffected.
ALTER TABLE "restaurants" ADD COLUMN "overture_id" VARCHAR(64);
CREATE UNIQUE INDEX "restaurants_overture_id_key" ON "restaurants"("overture_id");
