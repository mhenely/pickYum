-- CreateTable
CREATE TABLE "group_results" (
    "id" SERIAL NOT NULL,
    "group_id" INTEGER NOT NULL,
    "host_username" TEXT NOT NULL,
    "winner_name" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "participants" TEXT[],
    "scores" JSONB,
    "restaurant_pool" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "group_results_group_id_key" ON "group_results"("group_id");

-- AddForeignKey
ALTER TABLE "group_results" ADD CONSTRAINT "group_results_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
