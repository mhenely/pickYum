-- AlterTable
ALTER TABLE "group_events" ALTER COLUMN "participant_user_ids" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "group_events_group_status_voting_idx" RENAME TO "group_events_group_id_status_voting_starts_at_idx";

-- RenameIndex
ALTER INDEX "group_events_trip_status_voting_idx" RENAME TO "group_events_trip_id_status_voting_starts_at_idx";
