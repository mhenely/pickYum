-- CreateEnum
CREATE TYPE "GroupVoteMethod" AS ENUM ('SIMPLE', 'RANKED');

-- AlterTable
ALTER TABLE "group_event_results" ADD COLUMN     "ballots" JSONB,
ADD COLUMN     "irv_rounds" JSONB,
ADD COLUMN     "vote_method" TEXT;

-- AlterTable
ALTER TABLE "group_events" ADD COLUMN     "vote_method" "GroupVoteMethod" NOT NULL DEFAULT 'SIMPLE';
