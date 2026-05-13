import { Router, Request, Response } from 'express';
import {
  createSession,
  getSession,
  saveSession,
  registerClient,
  unregisterClient,
  notifyClients,
  RestaurantSnapshot,
} from '../sessions';
import { requireAuth } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimits';

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
  | { ok: true; hostName: string; candidates: string[]; restaurants: Record<string, RestaurantSnapshot> }
  | { ok: false; error: string }
{
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be an object' };
  const { hostName, candidates, restaurants } = body as {
    hostName?: unknown; candidates?: unknown; restaurants?: unknown;
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

  return { ok: true, hostName: trimmedHost, candidates: candidates as string[], restaurants: validatedRestaurants };
}

// POST /api/sessions — host creates a new group session (requires auth)
router.post('/', requireAuth, async (req: Request, res: Response) => {
  const result = validateSessionCreate(req.body);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  const session = await createSession(req.userId!, result.hostName, result.candidates, result.restaurants);
  res.status(201).json({ session });
});

// GET /api/sessions/:id — poll for session state (unauthenticated — guests need this)
router.get('/:id', async (req: Request, res: Response) => {
  const session = await getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ session });
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
  res.write(`data: ${JSON.stringify(session)}\n\n`);

  registerClient(session.id, res);
  req.on('close', () => unregisterClient(session.id, res));
});

// Reject names that would clobber Object prototype keys when used as voter map keys.
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf']);

// POST /api/sessions/:id/join — participant joins a session by name (unauthenticated — guests)
router.post('/:id/join', async (req: Request, res: Response) => {
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

  if (!Object.prototype.hasOwnProperty.call(session.voters, trimmed)) {
    session.voters[trimmed] = {};
    await saveSession(session);
    notifyClients(session.id, session);
  }

  res.json({ session });
});

// POST /api/sessions/:id/start — host moves lobby → voting (auth required)
router.post('/:id/start', requireAuth, async (req: Request, res: Response) => {
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
  res.json({ session });
});

// POST /api/sessions/:id/vote — participant submits their ballot (unauthenticated — guests)
router.post('/:id/vote', async (req: Request, res: Response) => {
  const session = await getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (session.status !== 'voting') {
    res.status(400).json({ error: 'Voting is not open' });
    return;
  }

  const { voterName, votes } = req.body as {
    voterName?: unknown;
    votes?: unknown;
  };
  if (typeof voterName !== 'string' || !voterName.trim() || !votes || typeof votes !== 'object' || Array.isArray(votes)) {
    res.status(400).json({ error: 'voterName and votes are required' });
    return;
  }
  if (voterName !== session.hostName && !Object.prototype.hasOwnProperty.call(session.voters, voterName)) {
    res.status(403).json({ error: 'Not a member of this session' });
    return;
  }
  // Strip any vote keys that aren't candidate IDs and coerce values to boolean —
  // prevents arbitrary keys from being persisted and broadcast via SSE.
  const candidateSet = new Set(session.candidates);
  const cleanVotes: Record<string, boolean> = {};
  for (const [id, val] of Object.entries(votes as Record<string, unknown>)) {
    if (candidateSet.has(id)) cleanVotes[id] = val === true;
  }

  session.voters[voterName] = cleanVotes;
  if (!session.submitted.includes(voterName)) {
    session.submitted.push(voterName);
  }
  await saveSession(session);
  notifyClients(session.id, session);
  res.json({ session });
});

// POST /api/sessions/:id/close — host closes voting and tallies (auth required)
router.post('/:id/close', requireAuth, async (req: Request, res: Response) => {
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

  await saveSession(session);
  notifyClients(session.id, session);
  res.json({ session });
});

// POST /api/sessions/:id/flip — host picks a random winner (auth required)
router.post('/:id/flip', requireAuth, async (req: Request, res: Response) => {
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
  session.result = pool[Math.floor(Math.random() * pool.length)];
  session.status = 'done';
  session.method = method === 'spin' ? 'spin' : 'flip';

  await saveSession(session);
  notifyClients(session.id, session);
  res.json({ session });
});

// POST /api/sessions/:id/redo — host resets a done session back to lobby (auth required)
router.post('/:id/redo', requireAuth, async (req: Request, res: Response) => {
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

  session.status = 'lobby';
  session.result = null;
  session.scores = null;
  session.tiedIds = null;
  session.submitted = [];
  for (const name of Object.keys(session.voters)) {
    session.voters[name] = {};
  }

  await saveSession(session);
  notifyClients(session.id, session);
  res.json({ session });
});

export default router;
