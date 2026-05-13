-- CreateTable
CREATE TABLE "user_archives" (
    "user_id" INTEGER NOT NULL,
    "restaurant_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_archives_pkey" PRIMARY KEY ("user_id","restaurant_id")
);

-- AddForeignKey
ALTER TABLE "user_archives" ADD CONSTRAINT "user_archives_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_archives" ADD CONSTRAINT "user_archives_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
