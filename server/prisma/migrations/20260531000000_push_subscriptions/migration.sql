-- Web Push subscriptions (RFC 8030) per device per user. Created when
-- the user opts in to browser notifications from a given device, and
-- removed either by an explicit unsubscribe or by the server when the
-- push service responds 410 GONE (we treat that as "subscription is
-- invalid, drop the row" — see lib/webPush.ts cleanup path).
--
-- `endpoint` is the unique per-device URL the push service hands us;
-- using it as the natural unique key means re-subscribing from the
-- same device just updates the existing row instead of accumulating
-- duplicates. Sized 2048 because the spec allows up to ~2KB; current
-- push services (FCM, Mozilla) sit around 200-300 chars, so this is
-- generously oversized but still fits a B-tree index without issue.
--
-- `p256dh` (ECDH public key) and `auth` (HMAC secret) are the W3C
-- cryptographic keys the push service needs to encrypt payloads.
-- We never inspect them — round-tripped to web-push at dispatch time.
--
-- `user_agent` is a free-form snapshot of the browser/device string
-- at subscription time so a future "manage your devices" UI can show
-- the user something recognizable ("MacBook · Chrome 130") instead
-- of a raw endpoint URL. Truncated to 512 — UA strings can run long
-- but anything past 512 is noise we'd ellide on display anyway.

CREATE TABLE "push_subscription" (
    "id"         SERIAL PRIMARY KEY,
    "user_id"    INTEGER NOT NULL,
    "endpoint"   VARCHAR(2048) NOT NULL,
    "p256dh"     VARCHAR(256)  NOT NULL,
    "auth"       VARCHAR(64)   NOT NULL,
    "user_agent" VARCHAR(512),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscription_endpoint_key" UNIQUE ("endpoint"),
    CONSTRAINT "push_subscription_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- Index for "all subscriptions belonging to user X" — the hot path for
-- dispatch (look up every device the recipient has registered, fan out).
CREATE INDEX "push_subscription_user_id_idx" ON "push_subscription"("user_id");
