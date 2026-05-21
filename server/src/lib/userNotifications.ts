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
import { sendPushToUser, type PushPayload } from './webPush';

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
  | 'vote-result'
  // Fired when a friend explicitly shares one of their recommendation
  // lists with this user. The list itself may already be visible to the
  // recipient via the owner's NETWORK visibility — the share action is
  // a one-tap push to the recipient's bell so it doesn't get missed in
  // a long list of recs.
  | 'list-shared';

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

// Generic push payload per notification reason. Web push payloads are
// intentionally lean — the user clicks through to the URL and reads
// the actual details in-app. Personalized text (who invited, what
// group name) would need notifyUser to take a richer signature;
// keeping it generic for v1 means every existing call site fires push
// without modification.
function buildPushPayload(reason: UserNotificationReason): PushPayload {
  switch (reason) {
    case 'group-invite':
      return { title: 'New group invite', body: 'Someone invited you to a pickYum group.',  url: '/socials', tag: 'group-invite' };
    case 'trip-invite':
      return { title: 'New trip invite',  body: 'Someone invited you to plan a trip.',       url: '/trips',   tag: 'trip-invite' };
    case 'meal-participant':
      return { title: 'Added to a meal',  body: 'You\'ve been added to a trip meal.',         url: '/trips',   tag: 'meal-participant' };
    case 'friend-request':
      return { title: 'New friend request', body: 'Someone sent you a friend request.',       url: '/socials', tag: 'friend-request' };
    case 'vote-result':
      return { title: 'Vote concluded',   body: 'A group decided on tonight\'s pick.',        url: '/socials', tag: 'vote-result' };
    case 'list-shared':
      return { title: 'A list was shared with you', body: 'A friend shared a recommendation list.', url: '/socials?tab=recommendations', tag: 'list-shared' };
  }
}

// Public publisher. Fire-and-forget — failures log but don't propagate to
// the request handler. The downstream client will eventually pick up the
// invite via the 60s poll fallback, so a notification miss isn't fatal.
//
// Dual delivery (Phase G.3):
//   1. In-app SSE refresh ping — same UX as before. Drives the navbar
//      badge update for users with the tab open.
//   2. Web push — reaches users with the tab CLOSED. Goes to every
//      device the user has opted in on. No-op when VAPID isn't
//      configured (sendPushToUser returns 0 silently).
// Both paths are best-effort; failures on either don't impact the other.
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

  // Fire web push in parallel — independent of the SSE path so a push
  // service hiccup doesn't affect the in-app notification (and vice
  // versa). Errors are already logged inside sendPushToUser; we
  // attach a catch here so the floating promise can't surface as an
  // unhandledRejection on Node 15+.
  sendPushToUser(userId, buildPushPayload(reason)).catch((err) => {
    logger.debug({ err, userId, reason }, 'sendPushToUser failed (non-fatal)');
  });
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
