-- CreateTable
CREATE TABLE "recommendations" (
    "id" SERIAL NOT NULL,
    "from_user_id" INTEGER NOT NULL,
    "restaurant_id" INTEGER NOT NULL,
    "tip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recommendations_from_user_id_restaurant_id_key" ON "recommendations"("from_user_id", "restaurant_id");

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
