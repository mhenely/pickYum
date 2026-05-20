// Server-Sent Events endpoint for per-user notifications. Replaces (mostly)
// the navbar's 60s polling fallback for invite badges. Polling stays in
// place as a backstop — if a client misses an SSE push (lost socket, mid-
// rotation deploy) the next poll picks it up.

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  registerUserClient, unregisterUserClient,
} from '../lib/userNotifications';

const router = Router();
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

export default router;
