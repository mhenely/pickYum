// Server-Sent Events endpoint for per-user notifications. Replaces (mostly)
// the navbar's 60s polling fallback for invite badges. Polling stays in
// place as a backstop — if a client misses an SSE push (lost socket, mid-
// rotation deploy) the next poll picks it up.

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  registerUserClient, unregisterUserClient,
} from '../lib/userNotifications';
import prisma from '../lib/prisma';
import { getVapidPublicKey, isPushEnabled } from '../lib/webPush';

const router = Router();

// `/vapid-key` is intentionally public — the VAPID public key is by
// definition not a secret, and the client needs it before any subscribe
// handshake (the subscribe call itself uses authenticated cookies).
// Registering it BEFORE the requireAuth middleware below lets it
// short-circuit before the auth check runs.
router.get('/vapid-key', (_req: Request, res: Response) => {
  res.json({ publicKey: getVapidPublicKey(), enabled: isPushEnabled() });
});

router.use(requireAuth);

// GET /api/notifications/stream — opens an SSE stream for the auth'd user.
// Clients listen for `event: refresh` and re-fetch their notification
// state via the usual REST endpoints.
//
// Headers chosen to match the existing /api/sessions/:id/stream endpoint:
// `Cache-Control: no-cache, no-transform` defeats every proxy layer's
// attempt to buffer the stream; `X-Accel-Buffering: no` is the same hint
// for nginx specifically; flushing eagerly after each write keeps latency
// in the sub-100ms range for invite badges.
router.get('/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type',   'text/event-stream');
  res.setHeader('Cache-Control',  'no-cache, no-transform');
  res.setHeader('Connection',     'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Initial comment line — primes the connection and keeps proxies from
  // closing it for "no data after X seconds". Mirrors the session stream.
  res.write(': connected\n\n');

  registerUserClient(req.userId, res);

  // Heartbeat every 25s so the connection stays alive across NLBs and
  // mobile carrier idle timeouts (often 30-60s). The 25s figure matches
  // the session stream — same trade-off, same justification.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unregisterUserClient(req.userId, res);
  });
});

// ── Web Push subscription management ───────────────────────────────
// (vapid-key registered above the requireAuth gate — public endpoint)
//
// POST /api/notifications/subscriptions
// Body: { endpoint, keys: { p256dh, auth }, userAgent? }
// Idempotent — `endpoint` is the natural unique key, so re-subscribing
// from the same device just updates the row in place (re-issued keys,
// fresh userAgent) instead of accumulating duplicates.
router.post('/subscriptions', async (req: Request, res: Response) => {
  const { endpoint, keys, userAgent } = req.body as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
    userAgent?: string;
  };

  if (!endpoint || typeof endpoint !== 'string' || endpoint.length > 2048) {
    res.status(400).json({ error: 'endpoint is required (<=2048 chars)' });
    return;
  }
  if (!keys?.p256dh || !keys?.auth) {
    res.status(400).json({ error: 'keys.p256dh and keys.auth are required' });
    return;
  }
  // Length-cap the UA so a hostile client can't push megabytes here.
  const ua = typeof userAgent === 'string' ? userAgent.slice(0, 512) : null;

  await prisma.pushSubscription.upsert({
    where:  { endpoint },
    create: { userId: req.userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: ua },
    // Re-bind to this user if the endpoint was previously owned by a
    // different account on the same device (e.g. logout → login as
    // someone else). Refresh keys + UA either way.
    update: { userId: req.userId, p256dh: keys.p256dh, auth: keys.auth, userAgent: ua },
  });
  res.status(204).end();
});

// DELETE /api/notifications/subscriptions
// Body: { endpoint }  (the endpoint is the natural key on the client too)
// Used by the frontend's "unsubscribe / turn off notifications" path.
router.delete('/subscriptions', async (req: Request, res: Response) => {
  const { endpoint } = req.body as { endpoint?: string };
  if (!endpoint || typeof endpoint !== 'string') {
    res.status(400).json({ error: 'endpoint is required' });
    return;
  }
  // Scope to req.userId so user A can't unsubscribe user B's device
  // by knowing the endpoint URL.
  await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.userId } });
  res.status(204).end();
});

export default router;
