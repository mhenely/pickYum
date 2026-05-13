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
export type VoteMethod    = 'simple' | 'ranked';

export interface IrvRound {
  counts: Record<string, number>;
  eliminated: string | null;
}

// Identity metadata for a voter. The display name (the key used in voters /
// rankings / submitted) is what they typed when joining; this carries the
// "behind the scenes" identity so we can show "Bob (signed in as alice42)"
// or "Bob (guest)" in past-vote ballot detail.
export interface VoterMeta {
  isGuest: boolean;
  username: string | null;
}

export interface GroupSession {
  id: string;
  groupId: number;
  eventId: number;
  hostUserId: number;
  hostName: string;
  candidates: string[];
  restaurants: Record<string, RestaurantSnapshot>;
  // voteMethod determines how ballots are stored and tallied. Simple is the
  // existing approval pattern (yes/no per candidate). Ranked stores ordered
  // candidate IDs per voter and uses instant-runoff tallying.
  voteMethod: VoteMethod;
  // Approval ballots for SIMPLE — voters by name → restaurantId → approved.
  // Also populated as `{[hostName]: {}}` to track joined participants in RANKED
  // mode (the inner record stays empty; rankings live in `rankings`).
  voters: Record<string, Record<string, boolean>>;
  // Ranked ballots for RANKED — voters by name → ordered candidate IDs.
  // Always present (empty object in SIMPLE mode) to keep the type stable.
  rankings: Record<string, string[]>;
  // Per-voter identity (guest vs signed-in + their auth username).
  // Keyed by the same display name as `voters` / `rankings`.
  voterMeta: Record<string, VoterMeta>;
  // Per-voter capability tokens minted at /join. The token is returned ONCE in
  // the /join response and must accompany every subsequent /vote from that
  // voter. Without it, anyone who knew a voter's display name could overwrite
  // their ballot. Never sent to other clients — `redactForClient()` strips it
  // before any wire serialization. Optional only because legacy in-flight
  // sessions from before this field existed shouldn't crash on load.
  voterTokens?: Record<string, string>;
  submitted: string[];
  status: SessionStatus;
  scores: Record<string, number> | null;
  // Round-by-round IRV trace, populated when a RANKED vote closes.
  irvRounds: IrvRound[] | null;
  tiedIds: string[] | null;
  result: string | null;
  method: 'vote' | 'flip' | 'spin' | null;
  scheduledFor: string | null;
  createdAt: number;
}

// Wire shape — what every client sees. The server keeps voterTokens and the
// `username` field of voterMeta internally; both must never reach a response
// body or SSE frame.
export interface ClientVoterMeta { isGuest: boolean }
export type ClientSession = Omit<GroupSession, 'voterTokens' | 'voterMeta'> & {
  voterMeta: Record<string, ClientVoterMeta>;
};

export function redactForClient(session: GroupSession): ClientSession {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const { voterTokens: _voterTokens, voterMeta, ...rest } = session;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  // Live SSE broadcasts go to every connected client including guests — they
  // shouldn't reveal another voter's auth account name. Only `isGuest` survives
  // (used for guest/signed-in pills); `username` stays server-side and reaches
  // the host post-vote via the GroupEventResult.voterMeta stored at /close.
  const safeMeta: Record<string, ClientVoterMeta> = {};
  for (const [name, meta] of Object.entries(voterMeta)) {
    safeMeta[name] = { isGuest: meta.isGuest };
  }
  return { ...rest, voterMeta: safeMeta };
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
    // Strip voterTokens before broadcasting — those are per-voter capabilities
    // and must not be visible to other connected clients.
    const payload = `data: ${JSON.stringify(redactForClient(session))}\n\n`;
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

// 16 bytes = 128 bits, hex-encoded. Each voter gets one at /join, must present
// it on /vote. Strong enough that the only realistic way an attacker votes as
// someone else is if they steal the token directly from the legit voter.
export function generateVoterToken(): string {
  return crypto.randomBytes(16).toString('hex');
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

// ── Per-session async lock ────────────────────────────────────
// Vote / join / start / close / flip / reject all follow the read-modify-write
// pattern `getSession → mutate in memory → saveSession`. With two concurrent
// requests both reads see the same pre-state, both writes back overwrite the
// other — last writer wins, the other request's ballot is lost.
//
// JS is single-threaded but every `await` yields the loop, so without a lock
// two votes arriving milliseconds apart absolutely race. We serialize all
// mutations on a given session through a per-id promise chain. Subsequent
// callers `await` the previous one's completion before they read state.
//
// Caveat: this is per-process only. With multiple App Runner instances writing
// the same Redis-backed session, two locks (one per instance) don't see each
// other. The mitigation for that is Redis WATCH/MULTI/EXEC; we accept the
// remaining gap for now because (a) the current deploy is single-instance and
// (b) the in-process lock closes the realistic in-process race that fires when
// six phones in a friend group tap "submit" simultaneously.
const sessionLocks = new Map<string, Promise<unknown>>();

export async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const key = sessionId.toLowerCase();
  const prev = sessionLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Track the latest task so the next caller chains onto *this* task, not the
  // older one. Clear the map entry once we're done so the Map doesn't leak.
  sessionLocks.set(key, next);
  try {
    return await next;
  } finally {
    if (sessionLocks.get(key) === next) sessionLocks.delete(key);
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
  voteMethod: VoteMethod = 'simple',
  // Auth username of the host — may equal hostName (group sessions) or differ
  // (ad-hoc sessions where the host typed a custom display name). Defaults to
  // hostName so callers that don't pass it still get sensible metadata.
  hostUsername: string | null = null,
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
    voteMethod,
    voters:    { [hostName]: {} },
    rankings:  {},
    voterMeta: { [hostName]: { isGuest: false, username: hostUsername ?? hostName } },
    // The host doesn't get a voter token — they vote under requireAuth (their
    // JWT proves identity in /vote). Only non-host display names need a token.
    voterTokens: {},
    submitted: [],
    status: 'lobby',
    scores: null,
    irvRounds: null,
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
