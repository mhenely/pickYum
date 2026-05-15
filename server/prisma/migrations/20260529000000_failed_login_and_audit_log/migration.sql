-- Per-account failed-login lockout: defends against credential-stuffing
-- botnets that distribute attempts across many IPs (the existing IP-based
-- rate limiter only stops per-IP brute force).
--
-- Both columns default-NOT-NULL safe values, so existing rows are
-- equivalent to "0 failures, never locked." No backfill needed.
ALTER TABLE "users"
  ADD COLUMN "failed_login_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "failed_login_locked_until" TIMESTAMP(3);

-- Audit log: append-only record of security-relevant events. Read paths
-- (admin dashboard / support tooling) filter heavily on (actor, created)
-- or (kind, created) or (ip, created), so each gets its own index.
-- We intentionally don't FK actor_user_id / target_user_id — keeping the
-- log when a user is deleted is the whole point of an audit trail.
CREATE TABLE "audit_log" (
  "id"             SERIAL          PRIMARY KEY,
  "kind"           VARCHAR(64)     NOT NULL,
  "actor_user_id"  INTEGER,
  "target_user_id" INTEGER,
  "ip"             VARCHAR(45),
  "metadata"       JSONB,
  "created_at"     TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "audit_log_actor_user_id_created_at_idx"   ON "audit_log" ("actor_user_id",  "created_at");
CREATE INDEX "audit_log_target_user_id_created_at_idx"  ON "audit_log" ("target_user_id", "created_at");
CREATE INDEX "audit_log_kind_created_at_idx"            ON "audit_log" ("kind",           "created_at");
CREATE INDEX "audit_log_ip_created_at_idx"              ON "audit_log" ("ip",             "created_at");
