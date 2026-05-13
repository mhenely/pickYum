-- DropIndex
DROP INDEX "user_accepted_user_id_idx";

-- CreateIndex
CREATE INDEX "restaurants_name_idx" ON "restaurants"("name");

-- CreateIndex
CREATE INDEX "user_accepted_user_id_accepted_at_idx" ON "user_accepted"("user_id", "accepted_at");
