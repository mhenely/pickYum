/*
  Warnings:

  - You are about to drop the column `session_id` on the `groups` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `groups` table. All the data in the column will be lost.
  - You are about to drop the column `voting_starts_at` on the `groups` table. All the data in the column will be lost.
  - You are about to drop the `group_results` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `group_selections` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "GroupEventStatus" AS ENUM ('OPEN', 'VOTING', 'DONE');

-- DropForeignKey
ALTER TABLE "group_results" DROP CONSTRAINT "group_results_group_id_fkey";

-- DropForeignKey
ALTER TABLE "group_selections" DROP CONSTRAINT "group_selections_added_by_id_fkey";

-- DropForeignKey
ALTER TABLE "group_selections" DROP CONSTRAINT "group_selections_group_id_fkey";

-- DropForeignKey
ALTER TABLE "group_selections" DROP CONSTRAINT "group_selections_restaurant_id_fkey";

-- AlterTable
ALTER TABLE "groups" DROP COLUMN "session_id",
DROP COLUMN "status",
DROP COLUMN "voting_starts_at";

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "community_rating" DECIMAL(4,2);

-- DropTable
DROP TABLE "group_results";

-- DropTable
DROP TABLE "group_selections";

-- DropEnum
DROP TYPE "GroupStatus";

-- CreateTable
CREATE TABLE "group_events" (
    "id" SERIAL NOT NULL,
    "group_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" "GroupEventStatus" NOT NULL DEFAULT 'OPEN',
    "session_id" TEXT,
    "voting_starts_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_event_results" (
    "id" SERIAL NOT NULL,
    "event_id" INTEGER NOT NULL,
    "host_username" TEXT NOT NULL,
    "winner_name" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "participants" TEXT[],
    "scores" JSONB,
    "restaurant_pool" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_event_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_event_selections" (
    "id" SERIAL NOT NULL,
    "event_id" INTEGER NOT NULL,
    "restaurant_id" INTEGER NOT NULL,
    "added_by_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_event_selections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_events_group_id_idx" ON "group_events"("group_id");

-- CreateIndex
CREATE INDEX "group_events_status_idx" ON "group_events"("status");

-- CreateIndex
CREATE UNIQUE INDEX "group_event_results_event_id_key" ON "group_event_results"("event_id");

-- CreateIndex
CREATE INDEX "group_event_selections_event_id_idx" ON "group_event_selections"("event_id");

-- CreateIndex
CREATE INDEX "group_event_selections_restaurant_id_idx" ON "group_event_selections"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_event_selections_event_id_restaurant_id_key" ON "group_event_selections"("event_id", "restaurant_id");

-- CreateIndex
CREATE INDEX "follows_following_id_idx" ON "follows"("following_id");

-- CreateIndex
CREATE INDEX "friend_requests_receiver_id_idx" ON "friend_requests"("receiver_id");

-- CreateIndex
CREATE INDEX "group_invites_invited_id_idx" ON "group_invites"("invited_id");

-- CreateIndex
CREATE INDEX "group_invites_group_id_idx" ON "group_invites"("group_id");

-- CreateIndex
CREATE INDEX "group_members_user_id_idx" ON "group_members"("user_id");

-- CreateIndex
CREATE INDEX "groups_host_id_idx" ON "groups"("host_id");

-- CreateIndex
CREATE INDEX "oauth_accounts_user_id_idx" ON "oauth_accounts"("user_id");

-- CreateIndex
CREATE INDEX "recommendations_restaurant_id_idx" ON "recommendations"("restaurant_id");

-- CreateIndex
CREATE INDEX "restaurants_cuisine_type_idx" ON "restaurants"("cuisine_type");

-- CreateIndex
CREATE INDEX "restaurants_google_data_updated_at_idx" ON "restaurants"("google_data_updated_at");

-- CreateIndex
CREATE INDEX "reviews_user_id_idx" ON "reviews"("user_id");

-- CreateIndex
CREATE INDEX "reviews_restaurant_id_idx" ON "reviews"("restaurant_id");

-- CreateIndex
CREATE INDEX "user_accepted_user_id_idx" ON "user_accepted"("user_id");

-- CreateIndex
CREATE INDEX "user_accepted_restaurant_id_idx" ON "user_accepted"("restaurant_id");

-- CreateIndex
CREATE INDEX "user_archives_restaurant_id_idx" ON "user_archives"("restaurant_id");

-- CreateIndex
CREATE INDEX "user_favorites_restaurant_id_idx" ON "user_favorites"("restaurant_id");

-- CreateIndex
CREATE INDEX "user_selections_restaurant_id_idx" ON "user_selections"("restaurant_id");

-- AddForeignKey
ALTER TABLE "group_events" ADD CONSTRAINT "group_events_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_event_results" ADD CONSTRAINT "group_event_results_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "group_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_event_selections" ADD CONSTRAINT "group_event_selections_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "group_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_event_selections" ADD CONSTRAINT "group_event_selections_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_event_selections" ADD CONSTRAINT "group_event_selections_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
