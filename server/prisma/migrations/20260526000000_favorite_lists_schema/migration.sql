-- ── Multi-list favorites: schema ───────────────────────────────
-- Adds two tables that together replace the flat `user_favorites`
-- bucket with named, user-organized lists. The old table stays
-- during the v1 rollout as a safety net; a separate later migration
-- drops it once we're confident.
--
-- Ownership is polymorphic: a FavoriteList belongs to exactly one
-- User OR exactly one Group, enforced by a CHECK constraint at the
-- bottom of this file (Prisma can't model XOR natively). v1 only
-- exposes user-owned lists via the API; the group-owned path is
-- future-proofing.

-- 1. favorite_lists — one row per user-named list.
CREATE TABLE "favorite_lists" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "group_id" INTEGER,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" VARCHAR(7),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorite_lists_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "favorite_lists_user_id_idx"  ON "favorite_lists"("user_id");
CREATE INDEX "favorite_lists_group_id_idx" ON "favorite_lists"("group_id");

-- Per-owner uniqueness on name. Postgres treats NULLs as distinct in
-- a unique index, so user-owned and group-owned rows don't collide
-- with one another via their NULL counterpart column — exactly the
-- semantics we want.
CREATE UNIQUE INDEX "favorite_lists_user_id_name_key"  ON "favorite_lists"("user_id", "name");
CREATE UNIQUE INDEX "favorite_lists_group_id_name_key" ON "favorite_lists"("group_id", "name");

ALTER TABLE "favorite_lists" ADD CONSTRAINT "favorite_lists_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "favorite_lists" ADD CONSTRAINT "favorite_lists_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Polymorphic owner XOR: exactly one of user_id / group_id must be
-- non-null. Prisma drift-detection will keep the columns nullable;
-- this CHECK is what makes the column pair behave like a tagged union.
ALTER TABLE "favorite_lists" ADD CONSTRAINT "favorite_lists_owner_xor"
  CHECK (("user_id" IS NULL) <> ("group_id" IS NULL));


-- 2. favorite_list_entries — membership rows. Composite PK lets a
--    restaurant appear once per list but in many lists across the user.
CREATE TABLE "favorite_list_entries" (
    "list_id" INTEGER NOT NULL,
    "restaurant_id" INTEGER NOT NULL,
    "note" TEXT,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorite_list_entries_pkey" PRIMARY KEY ("list_id", "restaurant_id")
);

CREATE INDEX "favorite_list_entries_restaurant_id_idx" ON "favorite_list_entries"("restaurant_id");

ALTER TABLE "favorite_list_entries" ADD CONSTRAINT "favorite_list_entries_list_id_fkey"
  FOREIGN KEY ("list_id") REFERENCES "favorite_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "favorite_list_entries" ADD CONSTRAINT "favorite_list_entries_restaurant_id_fkey"
  FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
