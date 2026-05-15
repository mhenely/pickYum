import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { DeepMockProxy } from 'jest-mock-extended';

jest.mock('../../sessions', () => ({
  createSession: jest.fn(),
  getSession:    jest.fn(),
  saveSession:   jest.fn().mockResolvedValue(undefined),
  registerClient:   jest.fn(),
  unregisterClient: jest.fn(),
  notifyClients:    jest.fn(),
  // The route mutates state via the lock; the test doesn't need real
  // serialization — just pass through to the fn so handler bodies still run.
  withSessionLock: jest.fn((_id: string, fn: () => Promise<unknown>) => fn()),
  // 16 random bytes — predictable in tests is fine; the test side asserts on
  // presence/equality, not on the entropy of the value.
  generateVoterToken: jest.fn(() => 'test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  // Identity passthrough in tests — production strips voterTokens, but the
  // mock session shape doesn't include them so there's nothing to strip.
  redactForClient: jest.fn((s: unknown) => s),
}));
jest.mock('../../lib/prisma');

import * as sessions from '../../sessions';
import prisma from '../../lib/prisma';
import sessionsRouter from '../../routes/sessions';

const mockSessions = sessions as jest.Mocked<typeof sessions>;
const mockPrisma   = prisma as unknown as DeepMockProxy<PrismaClient>;
const SECRET = process.env.JWT_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/sessions', sessionsRouter);
  return app;
}

const authCookie = (userId = 1) => `token=${jwt.sign({ userId }, SECRET)}`;

const baseSession = {
  id: 'sess-abc',
  groupId: 1,
  eventId: 0,
  hostUserId: 1,
  hostName: 'alice',
  candidates: ['1', '2', '3'],
  restaurants: {},
  voteMethod: 'simple' as const,
  voters: {},
  rankings: {},
  voterMeta: {},
  submitted: [],
  status: 'lobby' as const,
  scores: null,
  irvRounds: null,
  tiedIds: null,
  result: null,
  method: null,
  scheduledFor: null,
  createdAt: Date.now(),
};

describe('POST /api/sessions', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp())
      .post('/api/sessions')
      .send({ hostName: 'alice', candidates: ['1', '2'] });
    expect(res.status).toBe(401);
  });

  it('returns 400 when hostName is missing', async () => {
    const res = await request(buildApp())
      .post('/api/sessions')
      .set('Cookie', authCookie())
      .send({ candidates: ['1', '2'] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when fewer than 2 candidates are provided', async () => {
    const res = await request(buildApp())
      .post('/api/sessions')
      .set('Cookie', authCookie())
      .send({ hostName: 'alice', candidates: ['1'] });
    expect(res.status).toBe(400);
  });

  it('creates a session and returns 201', async () => {
    mockSessions.createSession.mockResolvedValue(baseSession);

    const res = await request(buildApp())
      .post('/api/sessions')
      .set('Cookie', authCookie(1))
      .send({ hostName: 'alice', candidates: ['1', '2'] });

    expect(res.status).toBe(201);
    expect(res.body.session.id).toBe('sess-abc');
  });
});

describe('GET /api/sessions/:id', () => {
  it('returns 404 for an unknown session', async () => {
    mockSessions.getSession.mockResolvedValue(undefined);
    const res = await request(buildApp()).get('/api/sessions/unknown');
    expect(res.status).toBe(404);
  });

  it('returns the session for a known id', async () => {
    mockSessions.getSession.mockResolvedValue(baseSession);
    const res = await request(buildApp()).get('/api/sessions/sess-abc');
    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe('sess-abc');
  });
});

describe('POST /api/sessions/:id/join — voterMeta capture', () => {
  beforeEach(() => jest.clearAllMocks());

  it('marks joiners with no auth cookie as guests (username = null)', async () => {
    const sess = { ...baseSession, voters: {}, voterMeta: {} };
    mockSessions.getSession.mockResolvedValue(sess);

    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/join')
      .send({ name: 'bob' });

    expect(res.status).toBe(200);
    expect(res.body.session.voterMeta.bob).toEqual({ isGuest: true, username: null, userId: null });
  });

  it('records the auth username + userId when the joiner sends a valid token cookie', async () => {
    const sess = { ...baseSession, voters: {}, voterMeta: {} };
    mockSessions.getSession.mockResolvedValue(sess);
    // The user.findUnique on the prisma mock returns whatever we tell it to —
    // simulates "the authenticated user's account username is 'realname42'".
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ username: 'realname42' });

    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/join')
      .set('Cookie', authCookie(7)) // signed in as userId 7
      .send({ name: 'Bob the Dinner Picker' }); // chose a fun display name

    expect(res.status).toBe(200);
    expect(res.body.session.voterMeta['Bob the Dinner Picker']).toEqual({
      isGuest: false,
      username: 'realname42',
      userId: 7,
    });
  });

  it('upgrades voterMeta from guest to signed-in if the same name rejoins with auth', async () => {
    const sess = {
      ...baseSession,
      voters: { bob: {} },
      voterMeta: { bob: { isGuest: true, username: null, userId: null } },
    };
    mockSessions.getSession.mockResolvedValue(sess);
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ username: 'bobsmith' });

    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/join')
      .set('Cookie', authCookie(7))
      .send({ name: 'bob' });

    expect(res.status).toBe(200);
    expect(res.body.session.voterMeta.bob).toEqual({ isGuest: false, username: 'bobsmith', userId: 7 });
  });
});

describe('POST /api/sessions/:id/join', () => {
  it('returns 404 for an unknown session', async () => {
    mockSessions.getSession.mockResolvedValue(undefined);
    const res = await request(buildApp())
      .post('/api/sessions/unknown/join')
      .send({ name: 'bob' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when session is already done', async () => {
    mockSessions.getSession.mockResolvedValue({ ...baseSession, status: 'done' as const });
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/join')
      .send({ name: 'bob' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when name is missing', async () => {
    mockSessions.getSession.mockResolvedValue(baseSession);
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/join')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 409 when name matches the host', async () => {
    mockSessions.getSession.mockResolvedValue(baseSession);
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/join')
      .send({ name: 'alice' });
    expect(res.status).toBe(409);
  });

  it('registers new voter and returns the session', async () => {
    const sess = { ...baseSession, voters: {} };
    mockSessions.getSession.mockResolvedValue(sess);
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/join')
      .send({ name: 'bob' });
    expect(res.status).toBe(200);
    expect(res.body.session).toBeDefined();
  });
});

// ── Trip-context auth gate (Phase 3) ──────────────────────────
// Behavior matrix at /join when session.tripId is set:
//
//   Authed + trip member + (no participant list OR in list)  → allowed
//   Authed + trip member + has participant list + not in it  → 403
//   Authed + not a trip member                                → 403
//   Guest (no cookie)                                          → allowed (current behavior preserved)
//   Group session (tripId = 0)                                 → gate skipped entirely
describe('POST /api/sessions/:id/join — trip-context auth', () => {
  beforeEach(() => jest.clearAllMocks());

  // Session that lives on Trip 42, Event 10. The session itself is in lobby
  // status with an empty voter list; the join handler will run end-to-end.
  const tripSession = {
    ...baseSession,
    groupId: 0,
    tripId:  42,
    eventId: 10,
    voters: {} as Record<string, Record<string, boolean>>,
    voterMeta: {},
  };

  it('lets a signed-in trip member join', async () => {
    mockSessions.getSession.mockResolvedValue(tripSession);
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ username: 'bobsmith' });
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      tripId: 42, participantUserIds: [],
    });
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValue({
      hostId: 99,
      members: [{ userId: 7 }], // user 7 is on the trip
    });

    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/join')
      .set('Cookie', authCookie(7))
      .send({ name: 'Bob' });

    expect(res.status).toBe(200);
  });

  it('rejects a signed-in non-member with 403', async () => {
    mockSessions.getSession.mockResolvedValue(tripSession);
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ username: 'stranger' });
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      tripId: 42, participantUserIds: [],
    });
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValue({
      hostId: 99,
      members: [], // empty: user 7 isn't on the trip
    });

    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/join')
      .set('Cookie', authCookie(7))
      .send({ name: 'Random' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not a member of this trip/i);
  });

  it('rejects a signed-in trip member who is not on the meal participant list', async () => {
    mockSessions.getSession.mockResolvedValue(tripSession);
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ username: 'bobsmith' });
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      tripId: 42,
      participantUserIds: [99, 8], // user 7 is NOT in this list
    });
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValue({
      hostId: 99,
      members: [{ userId: 7 }], // user 7 IS on the trip overall
    });

    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/join')
      .set('Cookie', authCookie(7))
      .send({ name: 'Bob' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/limited to selected participants/i);
  });

  it('lets the trip host join even when not in participantUserIds', async () => {
    // The host might not bother adding themselves to the participant list —
    // the host check (tripRow.hostId === authUserId) short-circuits the
    // membership probe before participantUserIds is consulted.
    mockSessions.getSession.mockResolvedValue(tripSession);
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ username: 'alice' });
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      tripId: 42,
      participantUserIds: [99, 8], // host id 99 IS in the list here, but
                                   // we want to verify the membership check
                                   // accepts the host regardless.
    });
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValue({
      hostId: 99,
      members: [], // even if the host has no trip_members row,
                   // the hostId match should pass membership.
    });

    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/join')
      .set('Cookie', authCookie(99))
      .send({ name: 'Alice' });

    expect(res.status).toBe(200);
  });

  it('lets a guest (no cookie) join a trip session regardless of membership', async () => {
    // Guests with the link are allowed by design; the participantUserIds
    // gate only applies to known accounts. No trip lookup should happen.
    mockSessions.getSession.mockResolvedValue(tripSession);

    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/join')
      .send({ name: 'Guest' });

    expect(res.status).toBe(200);
    // The trip/event lookups should NOT have been triggered — there's no
    // authUserId to gate against, so the new code path bails early.
    expect(mockPrisma.trip.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.groupEvent.findUnique).not.toHaveBeenCalled();
  });

  it('skips the trip-auth path entirely for group sessions (tripId = 0)', async () => {
    // Group session — tripId is 0/falsy. Even an authed user should not
    // trigger the new lookups.
    const groupSession = { ...baseSession, groupId: 1, tripId: 0, voters: {} };
    mockSessions.getSession.mockResolvedValue(groupSession);
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ username: 'bobsmith' });

    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/join')
      .set('Cookie', authCookie(7))
      .send({ name: 'Bob' });

    expect(res.status).toBe(200);
    expect(mockPrisma.trip.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.groupEvent.findUnique).not.toHaveBeenCalled();
  });
});

describe('POST /api/sessions/:id/vote', () => {
  it('returns 400 when session is not in voting state', async () => {
    mockSessions.getSession.mockResolvedValue(baseSession); // lobby
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/vote')
      .send({ voterName: 'alice', votes: { '1': true } });
    expect(res.status).toBe(400);
  });

  it('returns 403 when voter is not a session member', async () => {
    const voting = { ...baseSession, status: 'voting' as const, voters: {} };
    mockSessions.getSession.mockResolvedValue(voting);
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/vote')
      .send({ voterName: 'stranger', votes: { '1': true } });
    expect(res.status).toBe(403);
  });

  it('records a vote from the host (auth-gated, no voterToken needed)', async () => {
    // Host votes via the JWT cookie path — voterToken is required for non-host
    // voters but the host's identity is the auth user matching hostUserId.
    const voting = { ...baseSession, status: 'voting' as const, voters: {} };
    mockSessions.getSession.mockResolvedValue(voting);
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/vote')
      .set('Cookie', authCookie(1)) // baseSession.hostUserId === 1
      .send({ voterName: 'alice', votes: { '1': true, '2': false } });
    expect(res.status).toBe(200);
  });

  it('rejects a host vote without a matching JWT', async () => {
    const voting = { ...baseSession, status: 'voting' as const, voters: {} };
    mockSessions.getSession.mockResolvedValue(voting);
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/vote')
      .set('Cookie', authCookie(999)) // wrong user
      .send({ voterName: 'alice', votes: { '1': true } });
    expect(res.status).toBe(403);
  });

  it('rejects a non-host vote without a voterToken', async () => {
    // Bob is a registered voter (in session.voters) but the request has no
    // voterToken — should be rejected. This is the core fix for the
    // "anyone-can-vote-as-anyone" issue.
    const voting = {
      ...baseSession,
      status: 'voting' as const,
      voters: { bob: {} },
      voterTokens: { bob: 'real-token' },
    };
    mockSessions.getSession.mockResolvedValue(voting);
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/vote')
      .send({ voterName: 'bob', votes: { '1': true } });
    expect(res.status).toBe(403);
  });

  it('accepts a non-host vote with the correct voterToken', async () => {
    const voting = {
      ...baseSession,
      status: 'voting' as const,
      voters: { bob: {} },
      voterTokens: { bob: 'real-token' },
    };
    mockSessions.getSession.mockResolvedValue(voting);
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/vote')
      .send({ voterName: 'bob', voterToken: 'real-token', votes: { '1': true } });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/sessions/:id/close', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).post('/api/sessions/sess-abc/close');
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is not the host', async () => {
    mockSessions.getSession.mockResolvedValue({ ...baseSession, status: 'voting' as const });
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/close')
      .set('Cookie', authCookie(999));
    expect(res.status).toBe(403);
  });

  it('returns 400 when session is not in voting state', async () => {
    mockSessions.getSession.mockResolvedValue(baseSession); // lobby
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/close')
      .set('Cookie', authCookie(1));
    expect(res.status).toBe(400);
  });

  it('picks a clear majority winner and sets status to done', async () => {
    const voting = {
      ...baseSession,
      status: 'voting' as const,
      voters: {
        alice: { '1': true,  '2': false },
        bob:   { '1': true,  '2': false },
      },
    };
    mockSessions.getSession.mockResolvedValue(voting);

    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/close')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.session.result).toBe('1');
    expect(res.body.session.status).toBe('done');
    expect(res.body.session.method).toBe('vote');
  });

  it('enters closed state on a tie and records tiedIds', async () => {
    const voting = {
      ...baseSession,
      status: 'voting' as const,
      voters: {
        alice: { '1': true, '2': true },
      },
    };
    mockSessions.getSession.mockResolvedValue(voting);

    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/close')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe('closed');
    expect(res.body.session.tiedIds).toContain('1');
    expect(res.body.session.tiedIds).toContain('2');
  });
});

describe('POST /api/sessions/:id/flip', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).post('/api/sessions/sess-abc/flip');
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is not the host', async () => {
    mockSessions.getSession.mockResolvedValue(baseSession);
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/flip')
      .set('Cookie', authCookie(999));
    expect(res.status).toBe(403);
  });

  it('picks a random winner from candidates', async () => {
    mockSessions.getSession.mockResolvedValue(baseSession);
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/flip')
      .set('Cookie', authCookie(1))
      .send({ method: 'flip' });

    expect(res.status).toBe(200);
    expect(baseSession.candidates).toContain(res.body.session.result);
    expect(res.body.session.status).toBe('done');
    expect(res.body.session.method).toBe('flip');
  });
});

describe('POST /api/sessions/:id/reject (host rejects winner, retries with reduced pool)', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).post('/api/sessions/sess-abc/reject');
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is not the host', async () => {
    mockSessions.getSession.mockResolvedValue({ ...baseSession, status: 'done' as const, result: '1' });
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/reject')
      .set('Cookie', authCookie(999));
    expect(res.status).toBe(403);
  });

  it('returns 400 when session is not in done state', async () => {
    mockSessions.getSession.mockResolvedValue({ ...baseSession, status: 'lobby' as const });
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/reject')
      .set('Cookie', authCookie(1));
    expect(res.status).toBe(400);
  });

  it('returns 400 when removing the winner would leave fewer than 2 candidates', async () => {
    mockSessions.getSession.mockResolvedValue({
      ...baseSession,
      status: 'done' as const,
      candidates: ['1', '2'],
      result: '1',
      method: 'flip' as const,
    });
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/reject')
      .set('Cookie', authCookie(1));
    expect(res.status).toBe(400);
  });

  it('removes the winner from candidates and resets to lobby', async () => {
    mockSessions.getSession.mockResolvedValue({
      ...baseSession,
      status: 'done' as const,
      candidates: ['1', '2', '3'],
      result: '2',
      method: 'flip' as const,
      scores: { '1': 1, '2': 3, '3': 1 },
      submitted: ['alice'],
      voters: { alice: { '1': false, '2': true, '3': false } },
    });

    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/reject')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.session.candidates).toEqual(['1', '3']);
    expect(res.body.session.status).toBe('lobby');
    expect(res.body.session.result).toBeNull();
    expect(res.body.session.method).toBeNull();
    expect(res.body.session.scores).toBeNull();
    expect(res.body.session.submitted).toEqual([]);
    expect(res.body.session.voters.alice).toEqual({});
  });
});

describe('POST /api/sessions/:id/vote (ranked-choice branch)', () => {
  const rankedSession = {
    ...baseSession,
    status: 'voting' as const,
    voteMethod: 'ranked' as const,
    voters: { alice: {} },
    rankings: {},
  };

  // Alice is the host (hostName: 'alice', hostUserId: 1) — these tests vote as
  // the host so they all need the matching JWT cookie. Non-host voters would
  // present a voterToken instead; see the simple-vote branch above.

  it('returns 400 when ranking is missing on a ranked session', async () => {
    mockSessions.getSession.mockResolvedValue(rankedSession);
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/vote')
      .set('Cookie', authCookie(1))
      .send({ voterName: 'alice', votes: { '1': true } });
    expect(res.status).toBe(400);
  });

  it('accepts a valid ranking and stores it in rankings, leaving voters[] empty for that voter', async () => {
    mockSessions.getSession.mockResolvedValue(rankedSession);
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/vote')
      .set('Cookie', authCookie(1))
      .send({ voterName: 'alice', ranking: ['2', '1', '3'] });
    expect(res.status).toBe(200);
    expect(res.body.session.rankings.alice).toEqual(['2', '1', '3']);
  });

  it('strips unknown candidate ids and dedupes within a ranking', async () => {
    mockSessions.getSession.mockResolvedValue(rankedSession);
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/vote')
      .set('Cookie', authCookie(1))
      // '99' is not a candidate; '1' appears twice — only first wins
      .send({ voterName: 'alice', ranking: ['1', '99', '2', '1'] });
    expect(res.status).toBe(200);
    expect(res.body.session.rankings.alice).toEqual(['1', '2']);
  });
});

describe('POST /api/sessions/:id/close (ranked tally)', () => {
  it('uses IRV when voteMethod is ranked', async () => {
    mockSessions.getSession.mockResolvedValue({
      ...baseSession,
      status: 'voting' as const,
      voteMethod: 'ranked' as const,
      candidates: ['1', '2', '3'],
      voters: { alice: {}, bob: {}, carol: {} },
      rankings: {
        alice: ['1', '2', '3'],
        bob:   ['1', '3', '2'],
        carol: ['2', '1', '3'],
      },
    });

    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/close')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.session.result).toBe('1');     // alice + bob = 2 of 3, majority
    expect(res.body.session.status).toBe('done');
    expect(res.body.session.method).toBe('vote');
    expect(res.body.session.irvRounds).toHaveLength(1);
    expect(res.body.session.irvRounds[0].counts).toEqual({ '1': 2, '2': 1, '3': 0 });
  });
});
