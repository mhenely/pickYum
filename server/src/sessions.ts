import crypto from 'crypto';
import type { Response } from 'express';
import redis from './lib/redis';
import { logger } from './lib/logger';

// ── Interfaces ────────────────────────────────────────────────

export interface RestaurantSnapshot {
  name: string;
  type: string;
  price: number;
}

export type SessionStatus = 'lobby' | 'voting' | 'closed' | 'done';

export interface GroupSession {
  id: string;
  groupId: number;
  eventId: number;
  hostUserId: number;
  hostName: string;
  candidates: string[];
  restaurants: Record<string, RestaurantSnapshot>;
  voters: Record<string, Record<string, boolean>>;
  submitted: string[];
  status: SessionStatus;
  scores: Record<string, number> | null;
  tiedIds: string[] | null;
  result: string | null;
  method: 'vote' | 'flip' | 'spin' | null;
  scheduledFor: string | null;
  createdAt: number;
}

// ── Storage backend (Redis when available, else in-memory) ──────

const memStore = new Map<string, GroupSession>();

function getTtlMs(): number {
  return (parseInt(process.env.SESSION_TTL_HOURS ?? '4', 10) || 4) * 60 * 60 * 1000;
}

// ── SSE client registry (per-instance, in-memory) ─────────────
// SSE connections are HTTP-bound to a specific server instance. To broadcast
// updates from any instance to clients connected anywhere, we publish to a
// Redis pub/sub channel and let every instance's subscriber forward to its
// own local clients. Without REDIS_URL we fall back to direct local writes
// (single-instance dev mode).

const sseClients = new Map<string, Set<Response>>();
const SSE_CHANNEL = 'pickyum:sse';

export function registerClient(sessionId: string, res: Response): void {
  let clients = sseClients.get(sessionId);
  if (!clients) { clients = new Set(); sseClients.set(sessionId, clients); }
  clients.add(res);
}

export function unregisterClient(sessionId: string, res: Response): void {
  const clients = sseClients.get(sessionId);
  if (!clients) return;
  clients.delete(res);
  if (clients.size === 0) sseClients.delete(sessionId);
}

// Writes to local connections only — does not publish.
function writeToLocalClients(sessionId: string, session: GroupSession | null): void {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  if (session) {
    const payload = `data: ${JSON.stringify(session)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { /* connection already closed */ }
    }
  } else {
    // Session expired — signal clients to stop and close their streams
    for (const res of clients) {
      try { res.write('event: close\ndata: {}\n\n'); res.end(); } catch { /* ignore */ }
    }
    sseClients.delete(sessionId);
  }
}

// Subscribe once on module load. Uses a dedicated duplicate connection because
// ioredis can't send commands on a connection that has SUBSCRIBEd.
if (redis) {
  const subscriber = redis.duplicate();
  subscriber.connect().then(() =>
    subscriber.subscribe(SSE_CHANNEL).then(() => {
      logger.info('subscribed to SSE pub/sub channel');
      subscriber.on('message', (_channel, raw) => {
        try {
          const msg = JSON.parse(raw) as { sessionId: string; session: GroupSession | null };
          writeToLocalClients(msg.sessionId, msg.session);
        } catch (err) {
          logger.warn({ err }, 'malformed SSE pub/sub message');
        }
      });
    }),
  ).catch((err) => logger.error({ err }, 'SSE subscriber failed to connect'));
}

/**
 * Broadcasts a session update to all SSE clients across all instances.
 * - With Redis: publishes to the channel; every instance's subscriber writes
 *   to its own local clients (including this one).
 * - Without Redis: writes to local clients directly.
 *
 * Net effect is the same in single-instance mode; in multi-instance mode the
 * extra Redis round-trip (~1ms on same network) is the cost of fan-out.
 */
export function notifyClients(sessionId: string, session: GroupSession | null): void {
  if (redis && redis.status === 'ready') {
    redis.publish(SSE_CHANNEL, JSON.stringify({ sessionId, session })).catch((err) => {
      // If publish fails, at least update local clients so single-instance behavior holds.
      logger.error({ err, sessionId }, 'SSE publish failed — falling back to local write');
      writeToLocalClients(sessionId, session);
    });
  } else {
    writeToLocalClients(sessionId, session);
  }
}

// ── ID generation ─────────────────────────────────────────────

function generateCode(): string {
  return crypto.randomBytes(12).toString('hex');
}

// ── Session operations ────────────────────────────────────────

export async function getSession(id: string): Promise<GroupSession | undefined> {
  const key = id.toLowerCase();
  if (redis && redis.status === 'ready') {
    const raw = await redis.get(`session:${key}`);
    return raw ? (JSON.parse(raw) as GroupSession) : undefined;
  }
  return memStore.get(key);
}

export async function saveSession(session: GroupSession): Promise<void> {
  if (redis && redis.status === 'ready') {
    const ttlMs = getTtlMs();
    await redis.set(`session:${session.id}`, JSON.stringify(session), 'PX', ttlMs);
  } else {
    memStore.set(session.id, session);
  }
}

export async function createSession(
  hostUserId: number,
  hostName: string,
  candidates: string[],
  restaurants: Record<string, RestaurantSnapshot>,
  groupId = 0,
  eventId = 0,
  scheduledFor: string | null = null,
): Promise<GroupSession> {
  let id = generateCode();
  while (await getSession(id)) id = generateCode();

  const ttlMs = getTtlMs();

  const session: GroupSession = {
    id,
    groupId,
    eventId,
    hostUserId,
    hostName,
    candidates,
    restaurants,
    voters: { [hostName]: {} },
    submitted: [],
    status: 'lobby',
    scores: null,
    tiedIds: null,
    result: null,
    method: null,
    scheduledFor,
    createdAt: Date.now(),
  };

  if (redis && redis.status === 'ready') {
    await redis.set(`session:${session.id}`, JSON.stringify(session), 'PX', ttlMs);
    // Schedule SSE client cleanup when Redis key expires
    setTimeout(() => notifyClients(session.id, null), ttlMs);
  } else {
    memStore.set(session.id, session);
    setTimeout(() => {
      memStore.delete(session.id);
      notifyClients(session.id, null);
    }, ttlMs);
  }

  return session;
}
