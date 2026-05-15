-- Admin role gate. Default 'user' for every existing + new account;
-- promote individual users to 'admin' via direct DB update when
-- granting access to /api/admin/* endpoints. String column rather
-- than an enum so additional roles (e.g. 'support') can be added
-- later without a migration — requireAdmin treats anything outside
-- the known set as 'user'.
ALTER TABLE "users"
  ADD COLUMN "role" VARCHAR(16) NOT NULL DEFAULT 'user';
