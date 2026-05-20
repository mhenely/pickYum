// Per-user SSE channel for real-time notifications (group invites, trip
// invites, meal-participant assignments, friend requests). Sister module
// to sessions.ts's session-scoped SSE — same pub/sub-with-Redis-fallback
// pattern, keyed by userId instead of sessionId.
//
// Frames are intentionally tiny: just `event: refresh` with a `reason`
// hint. Clients respond by re-fetching their notifications via the usual
// REST endpoints. No invite content traverses the channel, so multi-
// instance broadcasts can't leak data to subscribers they shouldn't see.

import type { Response } from 'express';
import redis from './redis';
import { logger } from './logger';

const USER_SSE_CHANNEL = 'pickyum:user-notifications';

export type UserNotificationReason =
  | 'group-invite'
  | 'trip-invite'
  | 'meal-participant'
  | 'friend-request'
  // Fired when a session reaches `status: 'done'` (winner determined,
  // whether via close-and-tally, flip, or spin). Sent to every event
  // participant except the host, who already saw the result via the
  // request they made. Group events notify all group members; trip
  // meal events notify the meal's participantUserIds (or all trip
  // members when participantUserIds is empty = "everyone").
  | 'vote-result';

// Map<userId, Set<Response>> — per-instance registry of open SSE
// connections. A user can hold multiple connections (two tabs open).
const userClients = new Map<number, Set<Response>>();

export function registerUserClient(userId: number, res: Response): void {
  let conns = userClients.get(userId);
  if (!conns) { conns = new Set(); userClients.set(userId, conns); }
  conns.add(res);
}

export function unregisterUserClient(userId: number, res: Response): void {
  const conns = userClients.get(userId);
  if (!conns) return;
  conns.delete(res);
  if (conns.size === 0) userClients.delete(userId);
}

function buildRefreshFrame(reason: UserNotificationReason): string {
  // SSE `event:` line lets the client EventSource use `addEventListener` to
  // route by type; `data:` is the JSON payload. We keep the data minimal —
  // the client will refetch the canonical resource via REST anyway.
  return `event: refresh\ndata: ${JSON.stringify({ reason })}\n\n`;
}

function writeFrameToLocalUserClients(userId: number, frame: string): void {
  const conns = userClients.get(userId);
  if (!conns || conns.size === 0) return;
  for (const res of conns) {
    try { res.write(frame); } catch { /* connection already closed */ }
  }
}

// Subscribe once at module load if Redis is configured. Single dedicated
// connection — ioredis can't issue commands on a subscribed connection.
if (redis) {
  const subscriber = redis.duplicate();
  subscriber.connect().then(() =>
    subscriber.subscribe(USER_SSE_CHANNEL).then(() => {
      logger.info('subscribed to user-notifications pub/sub channel');
      subscriber.on('message', (_channel, raw) => {
        try {
          const msg = JSON.parse(raw) as { userId: number; frame: string };
          writeFrameToLocalUserClients(msg.userId, msg.frame);
        } catch (err) {
          logger.warn({ err }, 'malformed user-notifications pub/sub message');
        }
      });
    }),
  ).catch((err) => logger.error({ err }, 'user-notifications subscriber failed to connect'));
}

// Public publisher. Fire-and-forget — failures log but don't propagate to
// the request handler. The downstream client will eventually pick up the
// invite via the 60s poll fallback, so a notification miss isn't fatal.
export function notifyUser(userId: number, reason: UserNotificationReason): void {
  const frame = buildRefreshFrame(reason);
  if (redis && redis.status === 'ready') {
    redis.publish(USER_SSE_CHANNEL, JSON.stringify({ userId, frame })).catch((err) => {
      logger.error({ err, userId, reason }, 'user-notifications publish failed — falling back to local write');
      writeFrameToLocalUserClients(userId, frame);
    });
  } else {
    writeFrameToLocalUserClients(userId, frame);
  }
}

// Cleanup helper for graceful shutdown. Closes every open SSE connection
// and clears the registry. Called from index.ts's shutdown handler.
export function closeAllUserClients(): void {
  for (const conns of userClients.values()) {
    for (const res of conns) {
      try { res.write('event: close\ndata: {}\n\n'); res.end(); } catch { /* ignore */ }
    }
  }
  userClients.clear();
}
