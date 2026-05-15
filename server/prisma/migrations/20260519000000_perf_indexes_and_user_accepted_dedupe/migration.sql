-- Performance indexes for the auto-launch sweepers, the trip member-removal
-- cleanup, and the accept-result idempotency guard.
--
-- Three changes:
--   1. user_accepted: dedupe (user_id, event_id) where event_id is set, then
--      add a unique index. Lets accept-result use createMany(skipDuplicates).
--   2. group_events: index on session_id for the active-session cleanup.
--   3. group_events: composite indexes for the (parent, status='OPEN',
--      votingStartsAt <= now) sweep that runs on every detail page load.

-- ── 1. user_accepted dedupe + unique index ──────────────────────
-- Older accept-result writes (before withSessionLock was added) could
-- produce duplicate (user_id, event_id) rows on host double-click. Drop
-- the duplicates by keeping the EARLIEST id (preserves provenance of the
-- first acceptance). NULL event_ids are unaffected by both this dedupe
-- and the unique index — solo flip/spin acceptances can repeat freely.
DELETE FROM "user_accepted" a
WHERE event_id IS NOT NULL
  AND a.id > (
    SELECT MIN(b.id)
    FROM "user_accepted" b
    WHERE b.user_id = a.user_id
      AND b.event_id = a.event_id
  );

-- Postgres unique indexes on nullable columns naturally allow multiple
-- NULL rows (NULL is not equal to NULL), so this constraint applies only
-- to acceptances bound to an event — exactly what we want.
CREATE UNIQUE INDEX "user_accepted_user_id_event_id_key"
  ON "user_accepted"("user_id", "event_id");

-- ── 2. group_events.session_id index ────────────────────────────
-- Used by the trip member-removal cleanup that scans active VOTING
-- sessions, and is conceptually a join key for the launcher's
-- race-resolution code.
CREATE INDEX "group_events_session_id_idx" ON "group_events"("session_id");

-- ── 3. group_events composite sweep indexes ─────────────────────
-- Auto-launch sweeper runs on every detail GET:
--   WHERE group_id = $1 AND status = 'OPEN' AND voting_starts_at <= now()
-- (and the trip variant with trip_id). Single-column indexes are
-- intersect-able but a composite is one B-tree range scan.
CREATE INDEX "group_events_group_status_voting_idx"
  ON "group_events"("group_id", "status", "voting_starts_at");

CREATE INDEX "group_events_trip_status_voting_idx"
  ON "group_events"("trip_id", "status", "voting_starts_at");
