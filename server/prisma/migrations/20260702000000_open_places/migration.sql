-- Open-data places index (Overture Maps POC). See schema.prisma
-- OpenPlace comment for design rationale. Plain lat/lng (no PostGIS)
-- so this migration applies on vanilla postgres in CI.

CREATE TABLE "open_places" (
    "id" SERIAL NOT NULL,
    "source" VARCHAR(16) NOT NULL DEFAULT 'overture',
    "source_id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "category_primary" VARCHAR(64),
    "categories" TEXT[],
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "address" VARCHAR(300),
    "locality" VARCHAR(100),
    "region" VARCHAR(50),
    "postcode" VARCHAR(20),
    "phone" VARCHAR(40),
    "website" VARCHAR(500),
    "confidence" DOUBLE PRECISION,
    "ingested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "open_places_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "open_places_source_source_id_key" ON "open_places"("source", "source_id");

CREATE INDEX "open_places_lat_lng_idx" ON "open_places"("lat", "lng");

CREATE INDEX "open_places_category_primary_idx" ON "open_places"("category_primary");
