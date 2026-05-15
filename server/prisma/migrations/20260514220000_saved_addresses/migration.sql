-- ── Address book ───────────────────────────────────────────────
-- Replaces the single `User.default_address` string with a SavedAddress
-- table, letting users keep multiple labeled addresses for quick prefill
-- on the Search page.

-- 1. Create the new table.
CREATE TABLE "saved_addresses" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_addresses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "saved_addresses_user_id_idx" ON "saved_addresses"("user_id");
CREATE UNIQUE INDEX "saved_addresses_user_id_label_key" ON "saved_addresses"("user_id", "label");

ALTER TABLE "saved_addresses" ADD CONSTRAINT "saved_addresses_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Migrate existing defaultAddress data into the new table BEFORE
--    dropping the column. Each existing user with a default_address
--    gets a SavedAddress row labeled "Home" marked as default.
INSERT INTO "saved_addresses" ("user_id", "label", "address", "is_default")
SELECT id, 'Home', "default_address", true
FROM "users"
WHERE "default_address" IS NOT NULL AND TRIM("default_address") <> '';

-- 3. Now safe to drop the old column.
ALTER TABLE "users" DROP COLUMN "default_address";
