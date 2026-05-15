-- Daily per-user/per-endpoint aggregates of Google Places API spend.
-- Written by lib/apiUsage.trackGoogleCall at every Google call site;
-- queried by future admin-dashboard endpoints + per-user rate limits.
--
-- user_id is intentionally NOT a foreign key — usage history survives
-- user deletion (the row stays under the same user_id for cost
-- accounting). user_id = 0 buckets anonymous calls (mostly the public
-- photo proxy).
--
-- Composite primary key (user_id, day, endpoint) gives us atomic
-- UPSERT semantics — each (user, day, endpoint) tuple is one row
-- regardless of how many calls land. call_count / cache_hits /
-- est_cost_cents accumulate via INCREMENT.
--
-- est_cost_cents is Decimal(10, 4) — four decimal places of
-- precision lets us represent fractional-cent SKUs like Geocoding
-- ($0.005 = 0.5 cents) exactly without floating-point drift.

CREATE TABLE "api_usage" (
  "user_id"        INTEGER       NOT NULL,
  "day"            DATE          NOT NULL,
  "endpoint"       VARCHAR(32)   NOT NULL,
  "call_count"     INTEGER       NOT NULL DEFAULT 0,
  "cache_hits"     INTEGER       NOT NULL DEFAULT 0,
  "est_cost_cents" DECIMAL(10,4) NOT NULL DEFAULT 0,

  CONSTRAINT "api_usage_pkey" PRIMARY KEY ("user_id", "day", "endpoint")
);

-- Index on day alone for "give me the last 30 days across all users"
-- dashboard queries — the PK's leading column is user_id so a
-- day-only filter would otherwise need a full scan.
CREATE INDEX "api_usage_day_idx" ON "api_usage" ("day");
