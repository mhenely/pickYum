-- Link a UserAccepted row to the GroupEvent that produced it (when applicable).
-- New column is nullable: solo flip/spin/surprise/direct picks have no event,
-- and pre-rollout group acceptances can't be safely backfilled (we'd be
-- guessing the join by user + restaurant + timing). ON DELETE SET NULL so
-- deleting an event doesn't wipe the user's acceptance history — they still
-- went there, the row just loses its ballot deep-link.

ALTER TABLE "user_accepted" ADD COLUMN "event_id" INTEGER;

ALTER TABLE "user_accepted"
  ADD CONSTRAINT "user_accepted_event_id_fkey"
  FOREIGN KEY ("event_id") REFERENCES "group_events"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "user_accepted_event_id_idx" ON "user_accepted"("event_id");
