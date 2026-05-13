import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import {
  createSession,
  getSession,
  saveSession,
  registerClient,
  unregisterClient,
  notifyClients,
  withSessionLock,
  generateVoterToken,
  redactForClient,
  RestaurantSnapshot,
  VoteMethod,
} from '../sessions';
import { requireAuth } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimits';
import { tallyRanked } from '../lib/irv';
import prisma from '../lib/prisma';

// Returns the auth user's id if a valid `token` cookie is present, else null.
// Used on guest-friendly endpoints (/join, /vote) where we want to enrich the
// voter's identity record but not require auth. Never throws — bad/missing
// tokens just give us back null.
function getOptionalAuthUserId(req: Request): number | null {
  const token = req.cookies?.token as string | undefined;
  const secret = process.env.JWT_SECRET;
  if (!token || !secret) return null;
  try {
    const payload = jwt.verify(token, secret) as { userId?: number };
    return typeof payload.userId === 'number' ? payload.userId : null;
  } catch {
    return null;
  }
}

const router = Router();
router.use(writeLimiter);

// Bounds for session inputs. Picked generously but tight enough that a malicious
// host can't push megabytes of crafted JSON to every voter via SSE.
const MAX_NAME_LEN          = 50;
const MAX_CANDIDATES        = 50;
const MAX_CANDIDATE_ID_LEN  = 64;
const MAX_RESTAURANT_NAME   = 200;
const MAX_RESTAURANT_TYPE   = 100;

function validateSessionCreate(body: unknown):
  | { ok: true; hostName: string; candidates: string[]; restaurants: Record<string, RestaurantSnapshot>; voteMethod: VoteMethod }
  | { ok: false; error: string }
{
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be an object' };
  const { hostName, candidates, restaurants, voteMethod } = body as {
    hostName?: unknown; candidates?: unknown; restaurants?: unknown; voteMethod?: unknown;
  };

  if (typeof hostName !== 'string' || !hostName.trim()) {
    return { ok: false, error: 'hostName is required' };
  }
  const trimmedHost = hostName.trim();
  if (trimmedHost.length > MAX_NAME_LEN) {
    return { ok: false, error: `hostName must be ${MAX_NAME_LEN} characters or fewer` };
  }

  if (!Array.isArray(candidates) || candidates.length < 2) {
    return { ok: false, error: 'At least 2 candidates are required' };
  }
  if (candidates.length > MAX_CANDIDATES) {
    return { ok: false, error: `At most ${MAX_CANDIDATES} candidates allowed` };
  }
  if (!candidates.every((c) => typeof c === 'string' && c.length > 0 && c.length <= MAX_CANDIDATE_ID_LEN)) {
    return { ok: false, error: 'candidates must be non-empty strings' };
  }
  const candidateSet = new Set(candidates as string[]);
  if (candidateSet.size !== candidates.length) {
    return { ok: false, error: 'candidates must be unique' };
  }

  const validatedRestaurants: Record<string, RestaurantSnapshot> = {};
  if (restaurants != null) {
    if (typeof restaurants !== 'object' || Array.isArray(restaurants)) {
      return { ok: false, error: 'restaurants must be an object keyed by candidate ID' };
    }
    for (const [key, value] of Object.entries(restaurants as Record<string, unknown>)) {
      if (!candidateSet.has(key)) {
        return { ok: false, error: `restaurants["${key}"] does not match any candidate` };
      }
      if (!value || typeof value !== 'object') {
        return { ok: false, error: `restaurants["${key}"] must be an object` };
      }
      const { name, type, price } = value as { name?: unknown; type?: unknown; price?: unknown };
      if (typeof name !== 'string' || name.length === 0 || name.length > MAX_RESTAURANT_NAME) {
        return { ok: false, error: `restaurants["${key}"].name must be a string ≤${MAX_RESTAURANT_NAME} chars` };
      }
      if (typeof type !== 'string' || type.length > MAX_RESTAURANT_TYPE) {
        return { ok: false, error: `restaurants["${key}"].type must be a string ≤${MAX_RESTAURANT_TYPE} chars` };
      }
      if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 4) {
        return { ok: false, error: `restaurants["${key}"].price must be a number between 0 and 4` };
      }
      validatedRestaurants[key] = { name, type, price };
    }
  }

  // voteMethod defaults to 'simple' for backward compatibility with existing clients.
  let resolvedVoteMethod: VoteMethod = 'simple';
  if (voteMethod !== undefined) {
    if (voteMethod !== 'simple' && voteMethod !== 'ranked') {
      return { ok: false, error: "voteMethod must be 'simple' or 'ranked'" };
    }
    resolvedVoteMethod = voteMethod;
  }

  return {
    ok: true,
    hostName: trimmedHost,
    candidates: candidates as string[],
    restaurants: validatedRestaurants,
    voteMethod: resolvedVoteMethod,
  };
}

// POST /api/sessions — host creates a new group session (requires auth)
router.post('/', requireAuth, async (req: Request, res: Response) => {
  const result = validateSessionCreate(req.body);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  // Look up the host's actual auth username so voterMeta records "display name
  // → auth account" even when the host typed a custom display name at creation.
  const hostUser = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { username: true },
  });
  const session = await createSession(
    req.userId!,
    result.hostName,
    result.candidates,
    result.restaurants,
    0, // groupId — not used for ad-hoc sessions
    0, // eventId
    null, // scheduledFor
    result.voteMethod,
    hostUser?.username ?? null,
  );
  res.status(201).json({ session: redactForClient(session) });
});

// GET /api/sessions/:id — poll for session state (unauthenticated — guests need this)
router.get('/:id', async (req: Request, res: Response) => {
  const session = await getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ session: redactForClient(session) });
});

// GET /api/sessions/:id/stream — SSE for real-time session updates (unauthenticated — guests need this)
router.get('/:id/stream', async (req: Request, res: Response) => {
  const session = await getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current state immediately so the client doesn't wait for the next change
  res.write(`data: ${JSON.stringify(redactForClient(session))}\n\n`);

  registerClient(session.id, res);
  req.on('close', () => unregisterClient(session.id, res));
});

// Reject names that would clobber Object prototype keys when used as voter map keys.
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf']);

// POST /api/sessions/:id/join — participant joins a session by name (unauthenticated — guests)
router.post('/:id/join', async (req: Request, res: Response) => {
  await withSessionLock(req.params.id, async () => {
    const session = await getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.status === 'done') {
      res.status(400).json({ error: 'Session is already over' });
      return;
    }

    const { name } = req.body as { name?: string };
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const trimmed = name.trim();
    if (trimmed.length > MAX_NAME_LEN) {
      res.status(400).json({ error: `name must be ${MAX_NAME_LEN} characters or fewer` });
      return;
    }
    if (FORBIDDEN_NAMES.has(trimmed)) {
      res.status(400).json({ error: 'That name is reserved' });
      return;
    }

    if (trimmed === session.hostName) {
      res.status(409).json({ error: 'That name is already taken by the host' });
      return;
    }

    // Resolve voter identity from the JWT cookie if one happens to be present.
    // Anonymous joiners (no cookie) are flagged as guests; signed-in joiners
    // get their account username stored even when it differs from the display
    // name they chose for the vote.
    const authUserId = getOptionalAuthUserId(req);
    let authUsername: string | null = null;
    if (authUserId) {
      const user = await prisma.user.findUnique({
        where: { id: authUserId },
        select: { username: true },
      });
      authUsername = user?.username ?? null;
    }

    // Voter-token gating (see /vote): a new join under a fresh name mints a
    // token, returned in the response and kept server-side under voterTokens.
    // A re-join under an existing name must present that token to "re-attach"
    // (e.g. after a page refresh) — without it, the name is treated as taken
    // by someone else.
    const existingToken = session.voterTokens?.[trimmed];
    const supplied = typeof (req.body as { voterToken?: unknown }).voterToken === 'string'
      ? (req.body as { voterToken: string }).voterToken
      : null;

    if (existingToken && supplied !== existingToken) {
      res.status(409).json({ error: 'That name is already taken in this session' });
      return;
    }

    const isNewJoin = !existingToken;
    let voterToken = existingToken;
    if (isNewJoin) {
      voterToken = generateVoterToken();
      session.voterTokens ??= {};
      session.voterTokens[trimmed] = voterToken;
      session.voters[trimmed] = {};
    }
    // Always refresh voterMeta on join — a guest who signs in and rejoins under
    // the same name (with their token) should be promoted from guest to
    // signed-in. The token check above ensures only the original joiner can
    // do this, not a stranger who guessed the name.
    session.voterMeta[trimmed] = {
      isGuest: !authUserId,
      username: authUsername,
    };

    await saveSession(session);
    if (isNewJoin) {
      notifyClients(session.id, session);
    }
    // else: meta may have changed but ballot state didn't — skip the SSE
    // broadcast so other clients don't redraw for an invisible diff.

    // voterToken goes only to the joiner. The session object echoed back is
    // sanitized so other clients can't see anyone else's token.
    res.json({ session: redactForClient(session), voterToken });
  });
});

// POST /api/sessions/:id/start — host moves lobby → voting (auth required)
router.post('/:id/start', requireAuth, async (req: Request, res: Response) => {
  await withSessionLock(req.params.id, async () => {
    const session = await getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.hostUserId !== req.userId) {
      res.status(403).json({ error: 'Only the host can start voting' });
      return;
    }
    if (session.status !== 'lobby') {
      res.status(400).json({ error: 'Voting has already started' });
      return;
    }

    session.status = 'voting';
    await saveSession(session);
    notifyClients(session.id, session);
    res.json({ session: redactForClient(session) });
  });
});

// POST /api/sessions/:id/vote — participant submits their ballot.
// Body shape depends on session.voteMethod:
//   simple: { voterName, voterToken, votes: { [candidateId]: boolean } }
//   ranked: { voterName, voterToken, ranking: string[] } — ordered, best-first
//
// Authentication model:
//   - Host votes under voterName === session.hostName and is verified by JWT
//     (the cookie must belong to the user who created the session).
//   - Non-host voters present the `voterToken` they received from /join. Without
//     it the request is 403, even if voterName is in session.voters. This is
//     what prevents the "I know your display name, here's my fake vote for you"
//     attack — see the security audit for context.
router.post('/:id/vote', async (req: Request, res: Response) => {
  await withSessionLock(req.params.id, async () => {
    const session = await getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.status !== 'voting') {
      res.status(400).json({ error: 'Voting is not open' });
      return;
    }

    const { voterName, votes, ranking, voterToken } = req.body as {
      voterName?: unknown;
      votes?: unknown;
      ranking?: unknown;
      voterToken?: unknown;
    };
    if (typeof voterName !== 'string' || !voterName.trim()) {
      res.status(400).json({ error: 'voterName is required' });
      return;
    }

    if (voterName === session.hostName) {
      // Host path — must present a valid JWT cookie for the session's hostUserId.
      const authUserId = getOptionalAuthUserId(req);
      if (authUserId !== session.hostUserId) {
        res.status(403).json({ error: 'Only the host can vote under the host name' });
        return;
      }
    } else {
      // Non-host path — must present the voter token issued at /join.
      const expected = session.voterTokens?.[voterName];
      if (!expected || typeof voterToken !== 'string' || voterToken !== expected) {
        res.status(403).json({ error: 'Invalid voter credentials — rejoin the session' });
        return;
      }
    }

    const candidateSet = new Set(session.candidates);

    if (session.voteMethod === 'ranked') {
      // Validate ranking: array of strings, each a known candidate, no duplicates.
      // We accept partial rankings (voter doesn't have to order every candidate) —
      // IRV handles "exhausted" ballots correctly.
      if (!Array.isArray(ranking)) {
        res.status(400).json({ error: 'ranking (array of candidate IDs) is required for ranked-choice voting' });
        return;
      }
      // Allow oversized rankings — duplicates/unknowns are stripped silently
      // rather than 400'ing, which is friendlier for misbehaving clients.
      const cleanRanking: string[] = [];
      const seenInRanking = new Set<string>();
      for (const id of ranking as unknown[]) {
        if (typeof id !== 'string' || !candidateSet.has(id)) continue;
        if (seenInRanking.has(id)) continue;
        seenInRanking.add(id);
        cleanRanking.push(id);
      }

      session.rankings[voterName] = cleanRanking;
      // Keep an entry in voters too so participant tracking (who's joined / submitted) still works.
      if (!Object.prototype.hasOwnProperty.call(session.voters, voterName)) {
        session.voters[voterName] = {};
      }
    } else {
      // Simple approval voting (existing behavior).
      if (!votes || typeof votes !== 'object' || Array.isArray(votes)) {
        res.status(400).json({ error: 'votes object is required for simple voting' });
        return;
      }
      const cleanVotes: Record<string, boolean> = {};
      for (const [id, val] of Object.entries(votes as Record<string, unknown>)) {
        if (candidateSet.has(id)) cleanVotes[id] = val === true;
      }
      session.voters[voterName] = cleanVotes;
    }

    if (!session.submitted.includes(voterName)) {
      session.submitted.push(voterName);
    }
    await saveSession(session);
    notifyClients(session.id, session);
    res.json({ session: redactForClient(session) });
  });
});

// POST /api/sessions/:id/close — host closes voting and tallies (auth required)
router.post('/:id/close', requireAuth, async (req: Request, res: Response) => {
  await withSessionLock(req.params.id, async () => {
    const session = await getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.hostUserId !== req.userId) {
      res.status(403).json({ error: 'Only the host can close voting' });
      return;
    }
    if (session.status !== 'voting') {
      res.status(400).json({ error: 'Not in voting state' });
      return;
    }

    if (session.voteMethod === 'ranked') {
      // Instant-runoff tally. The final round's counts become `scores` so the UI
      // can render a familiar bar chart; rounds[] preserves the elimination story.
      const irv = tallyRanked(session.candidates, session.rankings);
      session.irvRounds = irv.rounds;
      const lastRound = irv.rounds[irv.rounds.length - 1];
      session.scores = lastRound ? { ...lastRound.counts } : Object.fromEntries(session.candidates.map((id) => [id, 0]));

      if (irv.winner) {
        session.result = irv.winner;
        session.status = 'done';
        session.method = 'vote';
      } else {
        session.tiedIds = irv.tied;
        session.status = 'closed';
      }
    } else {
      // Simple approval voting — count yes-votes per candidate, highest wins.
      const scores: Record<string, number> = {};
      for (const id of session.candidates) scores[id] = 0;
      for (const voterBallot of Object.values(session.voters)) {
        for (const [id, approved] of Object.entries(voterBallot)) {
          if (approved && id in scores) scores[id]++;
        }
      }

      const maxScore = Math.max(...Object.values(scores), 0);
      const topIds = Object.entries(scores)
        .filter(([, s]) => s === maxScore)
        .map(([id]) => id);

      session.scores = scores;

      if (topIds.length === 1) {
        session.result = topIds[0];
        session.status = 'done';
        session.method = 'vote';
      } else {
        session.tiedIds = topIds;
        session.status = 'closed';
      }
    }

    await saveSession(session);
    notifyClients(session.id, session);
    res.json({ session: redactForClient(session) });
  });
});

// POST /api/sessions/:id/flip — host picks a random winner (auth required)
router.post('/:id/flip', requireAuth, async (req: Request, res: Response) => {
  await withSessionLock(req.params.id, async () => {
    const session = await getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.hostUserId !== req.userId) {
      res.status(403).json({ error: 'Only the host can flip' });
      return;
    }
    if (session.status !== 'lobby' && session.status !== 'closed') {
      res.status(400).json({ error: 'Cannot flip in current state' });
      return;
    }

    const { method } = req.body as { method?: 'flip' | 'spin' };
    const pool = session.tiedIds ?? session.candidates;
    // crypto.randomInt over Math.random — for a "decide where we're eating"
    // app this matters less than for a lottery, but using the CSPRNG removes
    // any "the host can predict the next pick" concern and costs us nothing.
    session.result = pool[crypto.randomInt(pool.length)];
    session.status = 'done';
    session.method = method === 'spin' ? 'spin' : 'flip';

    await saveSession(session);
    notifyClients(session.id, session);
    res.json({ session: redactForClient(session) });
  });
});

// Reset session state back to a fresh lobby — used by both /redo and /reject.
// Clears ballot data, scores, IRV rounds, results — leaves identity (id, host,
// candidates, voteMethod) intact. Caller decides whether to mutate candidates.
function resetForNewRound(session: Awaited<ReturnType<typeof getSession>>) {
  if (!session) return;
  session.status     = 'lobby';
  session.result     = null;
  session.scores     = null;
  session.tiedIds    = null;
  session.irvRounds  = null;
  session.method     = null;
  session.submitted  = [];
  session.rankings   = {};
  for (const name of Object.keys(session.voters)) {
    session.voters[name] = {};
  }
}

// POST /api/sessions/:id/redo — host resets a done session back to lobby (auth required)
router.post('/:id/redo', requireAuth, async (req: Request, res: Response) => {
  await withSessionLock(req.params.id, async () => {
    const session = await getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.hostUserId !== req.userId) {
      res.status(403).json({ error: 'Only the host can redo' });
      return;
    }
    if (session.status !== 'done') {
      res.status(400).json({ error: 'Session is not done yet' });
      return;
    }

    resetForNewRound(session);
    await saveSession(session);
    notifyClients(session.id, session);
    res.json({ session: redactForClient(session) });
  });
});

// POST /api/sessions/:id/reject — host rejects the current winner, removes that
// restaurant from candidates, and resets to lobby for another vote/flip/spin.
// Mirrors the individual-user "reject result" pattern. Requires the session to
// be `done` (or `closed` after a tiebreak ended ambiguously, though that path
// is unusual). Returns 400 if fewer than 2 candidates would remain — at that
// point there's nothing meaningful to re-decide.
router.post('/:id/reject', requireAuth, async (req: Request, res: Response) => {
  await withSessionLock(req.params.id, async () => {
    const session = await getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.hostUserId !== req.userId) {
      res.status(403).json({ error: 'Only the host can reject the result' });
      return;
    }
    if (session.status !== 'done') {
      res.status(400).json({ error: 'Can only reject a finished result' });
      return;
    }
    const rejectedId = session.result;
    if (!rejectedId) {
      res.status(400).json({ error: 'No result to reject' });
      return;
    }
    if (session.candidates.length - 1 < 2) {
      res.status(400).json({ error: 'Not enough candidates left to retry after removing this one' });
      return;
    }

    session.candidates = session.candidates.filter((id) => id !== rejectedId);
    delete session.restaurants[rejectedId];

    resetForNewRound(session);
    await saveSession(session);
    notifyClients(session.id, session);
    res.json({ session: redactForClient(session) });
  });
});

export default router;
