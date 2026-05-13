-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "google_data_updated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "flip_count" INTEGER NOT NULL DEFAULT 0;
