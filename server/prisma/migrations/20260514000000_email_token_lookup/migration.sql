-- Add SHA-256 lookup column to email_tokens so consume can match in O(1)
-- instead of bcrypt-comparing every outstanding token. Nullable so existing
-- rows from before this column don't fail the NOT-NULL check; those legacy
-- rows can no longer be consumed (their raw token can't be recovered from
-- the bcrypt hash to backfill the lookup), but they expire within 24h.

ALTER TABLE "email_tokens" ADD COLUMN "token_lookup" TEXT;

-- Unique partial index — Postgres allows multiple NULLs in a UNIQUE column
-- by default, which is what we want during the legacy rollover.
CREATE UNIQUE INDEX "email_tokens_token_lookup_key" ON "email_tokens"("token_lookup");
