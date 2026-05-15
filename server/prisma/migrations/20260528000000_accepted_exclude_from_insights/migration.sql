-- Per-entry opt-out from the InsightsPage aggregation.
-- Default false preserves the pre-rollout behavior: every existing accepted
-- row continues to count toward insights until the user explicitly flips it.
-- The column is NOT NULL so the /me/insights aggregation can rely on a
-- simple equality filter (`WHERE exclude_from_insights = false`) without
-- having to coalesce NULLs on every read.
ALTER TABLE "user_accepted"
  ADD COLUMN "exclude_from_insights" BOOLEAN NOT NULL DEFAULT false;
