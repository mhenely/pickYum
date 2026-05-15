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
//
// `username` is a snapshot of the auth username at /join time. `userId` lets
// the read side look up the user's *current* name (after a rename) so the
// modal can render "(signed in as @old, now @new)" — kept in sync via the
// User FK at render time rather than mutating history. Null for guests, and
// null on pre-rollout rows that were written before this field existed.
export interface VoterMeta {
  isGuest: boolean;
  username: string | null;
  userId:   number | null;
}

export interface GroupSession {
  id: string;
  // Parent context. Exactly one of (groupId, tripId) is non-zero — both
  // default to 0 for legacy or ad-hoc sessions. Trip meal events store the
  // trip id here so accept-result + back-navigation can resolve the right
  // parent. tripId is optional so legacy session blobs read from Redis (or
  // hand-built fixtures in tests) that pre-date the field still typecheck;
  // consumers should `?? 0` defensively.
  groupId: number;
  tripId?: number;
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
// `username` + `userId` fields of voterMeta internally; none of them must
// ever reach a response body or SSE frame.
export interface ClientVoterMeta { isGuest: boolean }
export type ClientSession = Omit<GroupSession, 'voterTokens' | 'voterMeta'> & {
  voterMeta: Record<string, ClientVoterMeta>;
};

export function redactForClient(session: GroupSession): ClientSession {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const { voterTokens: _voterTokens, voterMeta, ...rest } = session;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  // Live SSE broadcasts go to every connected client including guests — they
  // shouldn't reveal another voter's auth account name *or* their User row id.
  // Only `isGuest` survives (used for guest/signed-in pills); `username` and
  // `userId` stay server-side and reach the host post-vote via the
  // GroupEventResult.voterMeta stored at /close.
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

// Pre-built SSE frame consumed by writeFrame() — null means "close clients".
type SseFrame = string | null;

// Build the wire frame for an SSE broadcast once, on the publisher. The
// frame is the literal bytes that get written to each connection — no
// per-subscriber re-stringify, no per-instance re-redact. Critically, the
// frame contains only the redacted view (voterTokens stripped), so even
// if the Redis channel is observed, the secret capability tokens never
// leave the publisher.
function buildSseFrame(session: GroupSession | null): SseFrame {
  if (!session) return null; // signals close to the writer
  return `data: ${JSON.stringify(redactForClient(session))}\n\n`;
}

// Writes a pre-built frame to local SSE connections. The frame has already
// been redacted at the publisher; we just byte-copy here.
function writeFrameToLocalClients(sessionId: string, frame: SseFrame): void {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  if (frame !== null) {
    for (const res of clients) {
      try { res.write(frame); } catch { /* connection already closed */ }
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
//
// The pub/sub payload is `{ sessionId, frame }` — a pre-built SSE frame
// produced by the publisher's `buildSseFrame()`. Subscribers just write it
// to local clients verbatim; no parse-of-session, no redaction-per-instance,
// and (key security property) voterTokens never traverse the channel.
if (redis) {
  const subscriber = redis.duplicate();
  subscriber.connect().then(() =>
    subscriber.subscribe(SSE_CHANNEL).then(() => {
      logger.info('subscribed to SSE pub/sub channel');
      subscriber.on('message', (_channel, raw) => {
        try {
          const msg = JSON.parse(raw) as { sessionId: string; frame: SseFrame };
          writeFrameToLocalClients(msg.sessionId, msg.frame);
        } catch (err) {
          logger.warn({ err }, 'malformed SSE pub/sub message');
        }
      });
    }),
  ).catch((err) => logger.error({ err }, 'SSE subscriber failed to connect'));
}

/**
 * Broadcasts a session update to all SSE clients across all instances.
 *
 * The frame is redacted at the publisher and shipped as a finished string
 * over Redis pub/sub. Subscribers byte-copy to local clients. Three wins
 * over the previous design that sent the full session on the channel:
 *
 *   1. Security: voterTokens (per-voter capability secrets) no longer
 *      cross the pub/sub channel where any subscribing instance could see
 *      them. They stay inside the publisher's process.
 *   2. ~2× bandwidth reduction on the channel (no token map, no full
 *      voterMeta entries with userId/username — only what clients see).
 *   3. Each receiving instance saves a JSON.parse + redactForClient call +
 *      JSON.stringify per broadcast. Hot during voting.
 *
 * The serialize-zero-clients early-out skips the redact+stringify entirely
 * when no local clients are connected AND Redis isn't running (single-
 * instance mode). With Redis, we always publish because other instances
 * may have clients.
 */
export function notifyClients(sessionId: string, session: GroupSession | null): void {
  if (redis && redis.status === 'ready') {
    const frame = buildSseFrame(session);
    redis.publish(SSE_CHANNEL, JSON.stringify({ sessionId, frame })).catch((err) => {
      // If publish fails, at least update local clients so single-instance behavior holds.
      logger.error({ err, sessionId }, 'SSE publish failed — falling back to local write');
      writeFrameToLocalClients(sessionId, frame);
    });
  } else {
    // Single-instance mode: skip the serialize entirely when no one's connected.
    if (sseClients.get(sessionId)?.size) {
      const frame = buildSseFrame(session);
      writeFrameToLocalClients(sessionId, frame);
    } else if (session === null) {
      // Even with no clients, we still want to drop the entry on close.
      sseClients.delete(sessionId);
    }
  }
}

// ── ID generation ─────────────────────────────────────────────

// Public so the launchVoting / launchTripVoting helpers can pre-allocate
// an id, claim it atomically in the DB (`groupEvent.sessionId`), and only
// then materialize the session in storage. Without that two-step, a race
// between the manual /start-voting route and the on-read auto-launch
// sweeper can create a session, lose the DB flip, and leak an orphan
// votable session in Redis for the full TTL window.
export function generateSessionId(): string {
  return crypto.randomBytes(12).toString('hex');
}

function generateCode(): string {
  return generateSessionId();
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
  // Trip context for meal events. Mutually exclusive with groupId in
  // practice (both are 0 for ad-hoc sessions); the GroupEvent CHECK
  // constraint already enforces that on the persistent side.
  tripId = 0,
  // Externally-provided id from the launch helpers. They pre-allocate via
  // `generateSessionId()`, claim it in the DB with `updateMany`, and only
  // then call here to materialize storage — fixes the orphan-session race
  // where the loser of a concurrent launch leaks a votable session.
  preallocatedId?: string,
): Promise<GroupSession> {
  // Pre-allocated ids come from the launch helpers, which have already
  // claimed them atomically in the DB — we trust them and skip the
  // collision-retry. The retry is for the auto-generated path (ad-hoc
  // session creation route) where two independent callers could in
  // principle land on the same 12-byte random.
  let id = preallocatedId ?? generateCode();
  if (!preallocatedId) {
    while (await getSession(id)) id = generateCode();
  }

  const ttlMs = getTtlMs();

  const session: GroupSession = {
    id,
    groupId,
    tripId,
    eventId,
    hostUserId,
    hostName,
    candidates,
    restaurants,
    voteMethod,
    voters:    { [hostName]: {} },
    rankings:  {},
    voterMeta: { [hostName]: { isGuest: false, username: hostUsername ?? hostName, userId: hostUserId } },
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
