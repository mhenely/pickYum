-- AlterTable
ALTER TABLE "user_accepted" ADD COLUMN     "choose_method" TEXT,
ADD COLUMN     "selections_snapshot" JSONB;
