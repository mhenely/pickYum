-- Curated recommendation lists. A user can group their existing
-- recommendations into named lists ("Date night", "Best brunch") and
-- friends/followers see those lists on the owner's recs surface
-- alongside individual recommendations.
--
-- Visibility starts at NETWORK (= friends ∪ follows) to match the
-- audience of a single recommendation today, so adopting lists doesn't
-- accidentally hide content. The enum is forward-extensible — PUBLIC
-- and UNLISTED can be added later via ALTER TYPE.

CREATE TYPE "RecommendationListVisibility" AS ENUM ('FRIENDS', 'FOLLOWERS', 'NETWORK');

CREATE TABLE "recommendation_lists" (
  "id"          SERIAL                         NOT NULL,
  "user_id"     INTEGER                        NOT NULL,
  "name"        TEXT                           NOT NULL,
  "description" TEXT,
  "color"       VARCHAR(7),
  "visibility"  "RecommendationListVisibility" NOT NULL DEFAULT 'NETWORK',
  "position"    INTEGER                        NOT NULL DEFAULT 0,
  "created_at"  TIMESTAMP(3)                   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3)                   NOT NULL,
  CONSTRAINT "recommendation_lists_pkey" PRIMARY KEY ("id")
);

-- Per-owner name uniqueness keeps the management UI sane and matches
-- the FavoriteList constraint.
CREATE UNIQUE INDEX "recommendation_lists_user_id_name_key"
  ON "recommendation_lists" ("user_id", "name");

CREATE INDEX "recommendation_lists_user_id_idx"
  ON "recommendation_lists" ("user_id");

ALTER TABLE "recommendation_lists"
  ADD CONSTRAINT "recommendation_lists_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Many-to-many: one rec can appear in multiple lists, one list holds
-- many recs. The API layer enforces that all entries in a given list
-- belong to the list's owner (no cross-user list-stuffing). Composite
-- PK guarantees a rec appears at most once per list.
CREATE TABLE "recommendation_list_entries" (
  "list_id"           INTEGER      NOT NULL,
  "recommendation_id" INTEGER      NOT NULL,
  "position"          INTEGER      NOT NULL DEFAULT 0,
  "added_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recommendation_list_entries_pkey" PRIMARY KEY ("list_id", "recommendation_id")
);

CREATE INDEX "recommendation_list_entries_recommendation_id_idx"
  ON "recommendation_list_entries" ("recommendation_id");

ALTER TABLE "recommendation_list_entries"
  ADD CONSTRAINT "recommendation_list_entries_list_id_fkey"
  FOREIGN KEY ("list_id") REFERENCES "recommendation_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recommendation_list_entries"
  ADD CONSTRAINT "recommendation_list_entries_recommendation_id_fkey"
  FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
