-- Trip invitations — same pattern as group invites. Host issues a
-- PENDING invite; invitee accepts to become a TripMember, or declines.
CREATE TYPE "TripInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

CREATE TABLE "trip_invites" (
    "id" SERIAL NOT NULL,
    "trip_id" INTEGER NOT NULL,
    "invited_id" INTEGER NOT NULL,
    "invited_by_id" INTEGER NOT NULL,
    "status" "TripInviteStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_invites_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "trip_invites_invited_id_idx" ON "trip_invites"("invited_id");
CREATE INDEX "trip_invites_trip_id_idx"    ON "trip_invites"("trip_id");
CREATE UNIQUE INDEX "trip_invites_trip_id_invited_id_key" ON "trip_invites"("trip_id", "invited_id");

ALTER TABLE "trip_invites" ADD CONSTRAINT "trip_invites_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trip_invites" ADD CONSTRAINT "trip_invites_invited_id_fkey"
  FOREIGN KEY ("invited_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trip_invites" ADD CONSTRAINT "trip_invites_invited_by_id_fkey"
  FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
