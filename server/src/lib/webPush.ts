// Web Push (RFC 8030) dispatch. Wraps the `web-push` package and the
// PushSubscription table so callers don't worry about VAPID signing,
// subscription enumeration, or stale-endpoint cleanup — they just say
// `sendPushToUser(userId, payload)` and we fan out to every device
// the user has subscribed.
//
// Setup (one-time, done by the operator outside this file):
//   1. Generate a VAPID keypair:
//        npx web-push generate-vapid-keys
//   2. Set the server env vars:
//        VAPID_PUBLIC_KEY  (also shipped to the client via /api/notifications/vapid-key)
//        VAPID_PRIVATE_KEY (server-only, never logged)
//        VAPID_SUBJECT     (mailto:ops@yourdomain.com — required by spec)
//   3. Run the push_subscriptions migration.
//
// If any VAPID env var is missing, this module logs a single warning
// at boot and `sendPushToUser` becomes a no-op. Web push is treated as
// a best-effort delivery channel — failures here must never break the
// wrapping flow (e.g. accepting a friend request shouldn't 500
// because a push failed).

import webpush from 'web-push';
import prisma from './prisma';
import { logger } from './logger';

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  ?? '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY ?? '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT     ?? '';

const PUSH_ENABLED = !!(VAPID_PUBLIC && VAPID_PRIVATE && VAPID_SUBJECT);

if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  logger.info('[webPush] enabled — VAPID keys configured');
} else {
  logger.warn('[webPush] disabled — set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT to enable browser push notifications');
}

/** Returns true when web push is configured + ready to send. */
export function isPushEnabled(): boolean {
  return PUSH_ENABLED;
}

/** Public VAPID key exposed to the frontend at subscribe time. */
export function getVapidPublicKey(): string {
  return VAPID_PUBLIC;
}

// Payload shape the service worker reads. Kept minimal — service
// workers can't ship rich UI, so we stick to title + body + optional
// click-through URL. Icon/badge use frontend-controlled defaults; no
// reason to ship them per-message.
export interface PushPayload {
  title: string;
  body:  string;
  // Relative URL the service worker navigates to on notification
  // click. Defaults to '/' if omitted. Pass full paths like
  // '/socials' or '/vote/:sessionId'.
  url?:  string;
  // Tag groups related notifications — a second message with the
  // same tag replaces the first instead of stacking. Useful for
  // chatty events ("Mark joined the vote, then Sam joined, then…").
  tag?:  string;
}

/**
 * Dispatch a push payload to every subscription registered for the
 * user. Returns the number of successful deliveries. Failures are
 * logged but never thrown — the caller can ignore the result and
 * move on. Subscriptions that come back 410 GONE (browser revoked /
 * device gone) are deleted so the next dispatch doesn't waste a
 * round-trip on them.
 */
export async function sendPushToUser(userId: number, payload: PushPayload): Promise<number> {
  if (!PUSH_ENABLED) return 0;

  const subs = await prisma.pushSubscription.findMany({
    where: { userId },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (subs.length === 0) return 0;

  const body = JSON.stringify(payload);
  let delivered = 0;
  const staleIds: number[] = [];

  // Parallel fan-out. Each push is independent — failure of one
  // subscription doesn't affect the others. Promise.allSettled so
  // a single bad endpoint doesn't short-circuit.
  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
      ),
    ),
  );

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      delivered += 1;
      return;
    }
    // web-push surfaces the HTTP status in the rejection. 404 / 410
    // mean the subscription is permanently gone (user revoked, device
    // wiped, etc.) — drop it from our table so next dispatch doesn't
    // try again. Everything else is transient (network, push service
    // outage) and gets retried implicitly on the next dispatch.
    const err = r.reason as { statusCode?: number; message?: string };
    if (err?.statusCode === 404 || err?.statusCode === 410) {
      staleIds.push(subs[i].id);
    } else {
      logger.warn({ err: err?.message, userId, endpoint: subs[i].endpoint }, '[webPush] dispatch failed');
    }
  });

  if (staleIds.length > 0) {
    // Fire-and-forget cleanup. If this fails we just retry later.
    prisma.pushSubscription.deleteMany({ where: { id: { in: staleIds } } })
      .catch((err) => logger.warn({ err: err?.message, count: staleIds.length }, '[webPush] stale-subscription cleanup failed'));
  }

  return delivered;
}
