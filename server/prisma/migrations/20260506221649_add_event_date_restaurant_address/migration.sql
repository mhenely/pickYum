-- AlterTable
ALTER TABLE "group_events" ADD COLUMN     "scheduled_for" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "address" TEXT;
