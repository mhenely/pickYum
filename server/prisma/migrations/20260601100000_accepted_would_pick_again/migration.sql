-- Decision-regret signal on UserAccepted. Nullable boolean — null means
-- "user hasn't answered yet," true = would pick again, false = wouldn't.
-- Drives the regret-rate stat on Insights and creates the data shape we
-- need to later weight the Choose flow against historically-regretted picks.
ALTER TABLE "user_accepted" ADD COLUMN "would_pick_again" BOOLEAN;
