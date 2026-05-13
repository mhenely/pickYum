-- AlterTable
ALTER TABLE "group_events" ADD COLUMN     "created_by_id" INTEGER;

-- CreateTable
CREATE TABLE "group_favorites" (
    "group_id" INTEGER NOT NULL,
    "restaurant_id" INTEGER NOT NULL,
    "added_by_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_favorites_pkey" PRIMARY KEY ("group_id","restaurant_id")
);

-- CreateIndex
CREATE INDEX "group_favorites_group_id_idx" ON "group_favorites"("group_id");

-- CreateIndex
CREATE INDEX "group_favorites_restaurant_id_idx" ON "group_favorites"("restaurant_id");

-- AddForeignKey
ALTER TABLE "group_events" ADD CONSTRAINT "group_events_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_favorites" ADD CONSTRAINT "group_favorites_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_favorites" ADD CONSTRAINT "group_favorites_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_favorites" ADD CONSTRAINT "group_favorites_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
