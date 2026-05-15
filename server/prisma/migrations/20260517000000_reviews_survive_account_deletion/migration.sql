-- Reviews now survive account deletion (anonymized by default). The user_id
-- column becomes nullable and the FK switches from ON DELETE CASCADE to
-- ON DELETE SET NULL. Users who want full retraction opt in at delete time;
-- the route deletes their review rows explicitly before the cascade fires.
--
-- No data migration needed — existing rows keep their non-null user_id; the
-- nullable column only matters for future deletions.

ALTER TABLE "reviews" DROP CONSTRAINT "reviews_user_id_fkey";

ALTER TABLE "reviews" ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
