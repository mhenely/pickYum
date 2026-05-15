import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { DeepMockProxy } from 'jest-mock-extended';

jest.mock('../../lib/prisma');
jest.mock('../../sessions', () => ({
  createSession:     jest.fn(),
  getSession:        jest.fn(),
  saveSession:       jest.fn().mockResolvedValue(undefined),
  notifyClients:     jest.fn(),
  // Pass-through: withSessionLock just runs the inner function in tests.
  // The real implementation serializes via a per-id promise chain; the
  // tests aren't exercising concurrency so a simple invocation matches
  // the success-path contract while keeping mock results synchronous.
  withSessionLock:   jest.fn((_id: string, fn: () => Promise<unknown>) => fn()),
  generateSessionId: jest.fn(() => 'sess-mock-id'),
}));

import prisma from '../../lib/prisma';
import groupsRouter from '../../routes/groups';

const mockPrisma = prisma as unknown as DeepMockProxy<PrismaClient>;
const SECRET = process.env.JWT_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/groups', groupsRouter);
  return app;
}

const authCookie = (userId = 1) => `token=${jwt.sign({ userId }, SECRET)}`;

const fakeGroup = {
  id: 1,
  name: 'Friday Crew',
  hostId: 1,
  status: 'OPEN',
  sessionId: null,
  host: { id: 1, username: 'alice', avatarUrl: null },
  members: [],
  options: [],
  result: null,
  _count: { invites: 0 },
};

describe('GET /api/groups', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/groups');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/groups', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp())
      .post('/api/groups')
      .send({ name: 'Friday Crew' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(buildApp())
      .post('/api/groups')
      .set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(400);
  });

  it('creates a group and returns 201', async () => {
    (mockPrisma.group.create as jest.Mock).mockResolvedValue(fakeGroup);

    const res = await request(buildApp())
      .post('/api/groups')
      .set('Cookie', authCookie(1))
      .send({ name: 'Friday Crew' });

    expect(res.status).toBe(201);
    expect(res.body.group.name).toBe('Friday Crew');
  });
});

describe('DELETE /api/groups/:id', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).delete('/api/groups/1');
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is not the host', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);

    const res = await request(buildApp())
      .delete('/api/groups/1')
      .set('Cookie', authCookie(999));

    expect(res.status).toBe(403);
  });

  it('archives (soft-deletes) the group when caller is the host', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.group.update as jest.Mock).mockResolvedValue({ ...fakeGroup, archivedAt: new Date() });

    const res = await request(buildApp())
      .delete('/api/groups/1')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(mockPrisma.group.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ archivedAt: expect.any(Date) }),
      }),
    );
    // Hard delete must NOT be called — accepting "Disband" should keep history
    expect(mockPrisma.group.delete).not.toHaveBeenCalled();
  });
});

describe('POST /api/groups/:id/options/:restaurantId', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).post('/api/groups/1/options/5');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/groups/:id/launch', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).post('/api/groups/1/launch');
    expect(res.status).toBe(401);
  });
});

// ── accept-result is the most complex transactional flow in the codebase ──
describe('POST /api/groups/:id/events/:eventId/accept-result', () => {
  // Imported here so mocks above can take effect
  const { getSession } = require('../../sessions') as { getSession: jest.Mock };

  const baseEvent = {
    id: 10,
    groupId: 1,
    name: 'Friday',
    status: 'VOTING' as const,
    sessionId: 'sess-abc',
    votingStartsAt: null,
    scheduledFor: null,
    createdAt: new Date(),
  };

  const baseSession = {
    id: 'sess-abc',
    groupId: 1,
    eventId: 10,
    hostUserId: 1,
    hostName: 'alice',
    candidates: ['100', '200'],
    restaurants: { '100': { name: 'Pho 99', type: 'Vietnamese', price: 1 }, '200': { name: 'Sushi Bar', type: 'Japanese', price: 3 } },
    voteMethod: 'simple' as const,
    voters: { alice: {}, bob: {} },
    rankings: {},
    voterMeta: {
      alice: { isGuest: false, username: 'alice' },
      bob:   { isGuest: true,  username: null },
    },
    submitted: ['alice', 'bob'],
    status: 'done' as const,
    scores: null,
    irvRounds: null,
    tiedIds: null,
    result: '100',
    method: 'flip' as const,
    scheduledFor: null,
    createdAt: Date.now(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).post('/api/groups/1/events/10/accept-result');
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is not the host', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    const res = await request(buildApp())
      .post('/api/groups/1/events/10/accept-result')
      .set('Cookie', authCookie(999));
    expect(res.status).toBe(403);
  });

  it('returns 404 when the event does not belong to the group', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({ ...baseEvent, groupId: 999 });
    const res = await request(buildApp())
      .post('/api/groups/1/events/10/accept-result')
      .set('Cookie', authCookie(1));
    expect(res.status).toBe(404);
  });

  it('is idempotent — returns 200 if event is already DONE', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({ ...baseEvent, status: 'DONE' });
    const res = await request(buildApp())
      .post('/api/groups/1/events/10/accept-result')
      .set('Cookie', authCookie(1));
    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 400 when event is not in voting state', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({ ...baseEvent, status: 'OPEN', sessionId: null });
    const res = await request(buildApp())
      .post('/api/groups/1/events/10/accept-result')
      .set('Cookie', authCookie(1));
    expect(res.status).toBe(400);
  });

  it('returns 400 when session is missing AND no result has been recorded', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue(baseEvent);
    getSession.mockResolvedValue(undefined);
    (mockPrisma.groupEventResult.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(buildApp())
      .post('/api/groups/1/events/10/accept-result')
      .set('Cookie', authCookie(1));
    expect(res.status).toBe(400);
  });

  it('recovers gracefully when session expired but a result already exists', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue(baseEvent);
    getSession.mockResolvedValue(undefined);
    (mockPrisma.groupEventResult.findUnique as jest.Mock).mockResolvedValue({ id: 1, eventId: 10 });
    (mockPrisma.groupEvent.update as jest.Mock).mockResolvedValue({ ...baseEvent, status: 'DONE' });

    const res = await request(buildApp())
      .post('/api/groups/1/events/10/accept-result')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(mockPrisma.groupEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DONE', sessionId: null }) }),
    );
  });

  it('persists ballots + voteMethod in the result for later ballot-detail display', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue(baseEvent);
    const votingSession = {
      ...baseSession,
      method: 'vote' as const,
      voters: { alice: { '100': true, '200': false }, bob: { '100': true, '200': true } },
    };
    getSession.mockResolvedValue(votingSession);
    (mockPrisma.restaurant.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.groupMember.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.$transaction as jest.Mock).mockResolvedValue([{}, {}]);

    const res = await request(buildApp())
      .post('/api/groups/1/events/10/accept-result')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    const upsertArgs = (mockPrisma.groupEventResult.upsert as jest.Mock).mock.calls[0][0];
    // method='vote' → voteMethod should be the session's voteMethod ('simple')
    expect(upsertArgs.create.voteMethod).toBe('simple');
    // Ballots snapshot for simple voting is the voters object (per-voter approvals)
    expect(upsertArgs.create.ballots).toEqual(votingSession.voters);
  });

  it('persists voterMeta from the session in the result for guest/signed-in display', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue(baseEvent);
    getSession.mockResolvedValue(baseSession); // already has voterMeta for alice/bob
    (mockPrisma.restaurant.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.groupMember.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.$transaction as jest.Mock).mockResolvedValue([{}, {}]);

    await request(buildApp())
      .post('/api/groups/1/events/10/accept-result')
      .set('Cookie', authCookie(1));

    const upsertArgs = (mockPrisma.groupEventResult.upsert as jest.Mock).mock.calls[0][0];
    expect(upsertArgs.create.voterMeta).toEqual({
      alice: { isGuest: false, username: 'alice' },
      bob:   { isGuest: true,  username: null },
    });
  });

  it('stores null voteMethod when the winner came from a pure flip/spin', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue(baseEvent);
    getSession.mockResolvedValue(baseSession); // method = 'flip'
    (mockPrisma.restaurant.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.groupMember.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.$transaction as jest.Mock).mockResolvedValue([{}, {}]);

    await request(buildApp())
      .post('/api/groups/1/events/10/accept-result')
      .set('Cookie', authCookie(1));

    const upsertArgs = (mockPrisma.groupEventResult.upsert as jest.Mock).mock.calls[0][0];
    expect(upsertArgs.create.voteMethod).toBeNull();
  });

  it('writes result + creates UserAccepted rows for host and matched members in one transaction', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue(baseEvent);
    // The route now resolves participant userIds from session.voterMeta
    // (entries with isGuest:false + userId set) instead of matching display
    // names against the group member roster. Override bob's meta here so
    // he's a signed-in voter with a userId — that's what now drives the
    // UserAccepted write. Carol is NOT in voterMeta and shouldn't get a row.
    getSession.mockResolvedValue({
      ...baseSession,
      voterMeta: {
        alice: { isGuest: false, username: 'alice', userId: 1 },
        bob:   { isGuest: false, username: 'bob',   userId: 2 },
      },
    });
    (mockPrisma.restaurant.findMany as jest.Mock).mockResolvedValue([
      { id: 100, address: '1 Main St', website: 'pho99.test' },
      { id: 200, address: null, website: null },
    ]);
    (mockPrisma.$transaction as jest.Mock).mockResolvedValue([{}, {}]);

    const res = await request(buildApp())
      .post('/api/groups/1/events/10/accept-result')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);

    // Inspect the operations passed to $transaction. With Prisma's mock, calls to
    // model.upsert/.create/.update are recorded as their own jest mocks.
    expect(mockPrisma.groupEventResult.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventId: 10 },
        create: expect.objectContaining({
          eventId: 10,
          hostUsername: 'alice',
          winnerName: 'Pho 99',
          method: 'flip',
          participants: expect.arrayContaining(['alice', 'bob']),
          restaurantPool: expect.any(Array),
        }),
      }),
    );

    // Pool entries should have been enriched with address + website from the DB
    const upsertArgs = (mockPrisma.groupEventResult.upsert as jest.Mock).mock.calls[0][0];
    const pool = upsertArgs.create.restaurantPool as Array<Record<string, unknown>>;
    expect(pool[0]).toEqual(expect.objectContaining({ id: '100', address: '1 Main St', website: 'pho99.test' }));

    // Host + signed-in voters share one createMany INSERT — was previously
    // N individual `userAccepted.create` round-trips. The @@unique on
    // (userId, eventId) + skipDuplicates makes this idempotent for retries.
    expect(mockPrisma.userAccepted.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: expect.arrayContaining([
          expect.objectContaining({ userId: 1, restaurantId: 100, eventId: 10 }), // host
          expect.objectContaining({ userId: 2, restaurantId: 100, eventId: 10 }), // bob (signed-in)
        ]),
      }),
    );
    // Carol isn't in voterMeta at all (didn't vote) — must NOT be in the rows.
    const createManyArgs = (mockPrisma.userAccepted.createMany as jest.Mock).mock.calls[0][0];
    expect(createManyArgs.data.find((r: { userId: number }) => r.userId === 3)).toBeUndefined();
  });

  it('skips UserAccepted writes if winner id is not numeric (custom restaurant edge case)', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue(baseEvent);
    getSession.mockResolvedValue({
      ...baseSession,
      candidates: ['custom-1', 'custom-2'],
      result: 'custom-1',
      restaurants: { 'custom-1': { name: 'Home Cooking', type: 'Custom', price: 1 }, 'custom-2': { name: 'Other', type: 'Custom', price: 1 } },
    });
    (mockPrisma.restaurant.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.groupMember.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.$transaction as jest.Mock).mockResolvedValue([{}, {}]);

    const res = await request(buildApp())
      .post('/api/groups/1/events/10/accept-result')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    // Non-numeric winner id (custom restaurant) → no UserAccepted writes at all.
    expect(mockPrisma.userAccepted.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.userAccepted.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/groups/:id/events/:eventId/vote-method', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).patch('/api/groups/1/events/10/vote-method');
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is not the host', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    const res = await request(buildApp())
      .patch('/api/groups/1/events/10/vote-method')
      .set('Cookie', authCookie(999))
      .send({ voteMethod: 'RANKED' });
    expect(res.status).toBe(403);
  });

  it('returns 400 for an invalid voteMethod value', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      id: 10, groupId: 1, status: 'OPEN', voteMethod: 'SIMPLE',
    });
    const res = await request(buildApp())
      .patch('/api/groups/1/events/10/vote-method')
      .set('Cookie', authCookie(1))
      .send({ voteMethod: 'WEIRD' });
    expect(res.status).toBe(400);
  });

  it('rejects changes once voting has started', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      id: 10, groupId: 1, status: 'VOTING', voteMethod: 'SIMPLE',
    });
    const res = await request(buildApp())
      .patch('/api/groups/1/events/10/vote-method')
      .set('Cookie', authCookie(1))
      .send({ voteMethod: 'RANKED' });
    expect(res.status).toBe(400);
  });

  it('flips an OPEN event from SIMPLE to RANKED', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      id: 10, groupId: 1, status: 'OPEN', voteMethod: 'SIMPLE',
    });
    (mockPrisma.groupEvent.update as jest.Mock).mockResolvedValue({ id: 10, voteMethod: 'RANKED' });

    const res = await request(buildApp())
      .patch('/api/groups/1/events/10/vote-method')
      .set('Cookie', authCookie(1))
      .send({ voteMethod: 'RANKED' });

    expect(res.status).toBe(200);
    expect(res.body.voteMethod).toBe('RANKED');
    expect(mockPrisma.groupEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 10 }, data: { voteMethod: 'RANKED' } }),
    );
  });
});

// ── Q1: PATCH /:id/transfer-host ───────────────────────────────
describe('PATCH /api/groups/:id/transfer-host', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).patch('/api/groups/1/transfer-host').send({ newHostId: 2 });
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is not the current host', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    const res = await request(buildApp())
      .patch('/api/groups/1/transfer-host')
      .set('Cookie', authCookie(999))
      .send({ newHostId: 2 });
    expect(res.status).toBe(403);
  });

  it('rejects transfer of an archived group', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue({ ...fakeGroup, archivedAt: new Date() });
    const res = await request(buildApp())
      .patch('/api/groups/1/transfer-host')
      .set('Cookie', authCookie(1))
      .send({ newHostId: 2 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when newHostId is missing or self', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    const a = await request(buildApp()).patch('/api/groups/1/transfer-host').set('Cookie', authCookie(1)).send({});
    expect(a.status).toBe(400);
    const b = await request(buildApp()).patch('/api/groups/1/transfer-host').set('Cookie', authCookie(1)).send({ newHostId: 1 });
    expect(b.status).toBe(400);
  });

  it('returns 400 when newHost is not an existing member', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(buildApp())
      .patch('/api/groups/1/transfer-host')
      .set('Cookie', authCookie(1))
      .send({ newHostId: 99 });
    expect(res.status).toBe(400);
  });

  it('atomically promotes the new host and demotes the old', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 2 });
    // Interactive transaction now — `(fn) => fn(mockPrisma)` lets the
    // inner mutations run against the mock prisma client.
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn) => fn(mockPrisma));
    (mockPrisma.group.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    const res = await request(buildApp())
      .patch('/api/groups/1/transfer-host')
      .set('Cookie', authCookie(1))
      .send({ newHostId: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Host transferred', hostId: 2 });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // Verify the swap shape — delete the new host's existing member row,
    // updateMany on group guarded by the EXPECTED previous host id, and
    // upsert the demoted host's row (so a pre-existing member row from
    // an earlier transfer-host doesn't 500 with P2002).
    expect(mockPrisma.groupMember.deleteMany).toHaveBeenCalledWith({ where: { groupId: 1, userId: 2 } });
    expect(mockPrisma.group.updateMany).toHaveBeenCalledWith({
      where: { id: 1, hostId: 1 },
      data:  { hostId: 2 },
    });
    expect(mockPrisma.groupMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where:  { groupId_userId: { groupId: 1, userId: 1 } },
        create: { groupId: 1, userId: 1 },
        update: {},
      }),
    );
  });

  it('returns 409 when a concurrent transfer-host won the race', async () => {
    // Pre-flight passes (hostId=1) but by the time the inner update fires,
    // another request has already moved hostId to someone else, so the
    // guarded updateMany hits 0 rows.
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 2 });
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn) => fn(mockPrisma));
    (mockPrisma.group.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    const res = await request(buildApp())
      .patch('/api/groups/1/transfer-host')
      .set('Cookie', authCookie(1))
      .send({ newHostId: 2 });

    expect(res.status).toBe(409);
    expect(mockPrisma.groupMember.upsert).not.toHaveBeenCalled();
  });
});

// ── Q2: POST /:id/events — any member can create ───────────────
describe('POST /api/groups/:id/events (any-member creation)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lets a non-host member create an event and stamps createdById', async () => {
    // isMember() looks up the group then groupMember — host check passes
    // because the caller has a membership row, even though hostId is 1.
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 5 });
    (mockPrisma.groupEvent.create as jest.Mock).mockResolvedValue({
      id: 99, groupId: 1, name: 'Friday Dinner', status: 'OPEN', createdById: 5,
    });

    const res = await request(buildApp())
      .post('/api/groups/1/events')
      .set('Cookie', authCookie(5))
      .send({ name: 'Friday Dinner' });

    expect(res.status).toBe(201);
    expect(mockPrisma.groupEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ groupId: 1, name: 'Friday Dinner', createdById: 5 }),
      }),
    );
  });

  it('returns 403 when caller is not a member at all', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(buildApp())
      .post('/api/groups/1/events')
      .set('Cookie', authCookie(99))
      .send({ name: 'Stranger danger' });
    expect(res.status).toBe(403);
  });

  it('rejects creation on archived groups', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue({ ...fakeGroup, archivedAt: new Date() });
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 1 });
    const res = await request(buildApp())
      .post('/api/groups/1/events')
      .set('Cookie', authCookie(1))
      .send({ name: 'Too late' });
    expect(res.status).toBe(400);
  });
});

// ── Add-event-option privacy boundary ──
describe('POST /api/groups/:id/events/:eventId/options (privacy)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects adding a private restaurant owned by another user', async () => {
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 5 });
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      id: 10, groupId: 1, status: 'OPEN',
    });
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
      id: 7, private: true, createdBy: 99, // owned by someone else
    });

    const res = await request(buildApp())
      .post('/api/groups/1/events/10/options')
      .set('Cookie', authCookie(5))
      .send({ restaurantId: 7 });

    expect(res.status).toBe(404); // visibility-preserving — don't reveal it exists
    expect(mockPrisma.groupEventOption.upsert).not.toHaveBeenCalled();
  });

  it('auto-publishes a private restaurant when its creator shares it', async () => {
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 5 });
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      id: 10, groupId: 1, status: 'OPEN',
    });
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
      id: 7, private: true, createdBy: 5, // owned by the caller
    });
    (mockPrisma.restaurant.update as jest.Mock).mockResolvedValue({ id: 7, private: false });
    (mockPrisma.groupEventOption.upsert as jest.Mock).mockResolvedValue({ id: 1, eventId: 10, restaurantId: 7 });

    const res = await request(buildApp())
      .post('/api/groups/1/events/10/options')
      .set('Cookie', authCookie(5))
      .send({ restaurantId: 7 });

    expect(res.status).toBe(201);
    expect(mockPrisma.restaurant.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { private: false },
    });
  });
});

// ── Q3: DELETE event option — adder or orphaned-adder fallback ──
describe('DELETE /api/groups/:id/events/:eventId/options/:restaurantId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lets the member who added it remove their own option', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 5 });
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      id: 10, groupId: 1, status: 'OPEN',
    });
    (mockPrisma.groupEventOption.findUnique as jest.Mock).mockResolvedValue({
      eventId: 10, restaurantId: 7, addedById: 5,
    });

    const res = await request(buildApp())
      .delete('/api/groups/1/events/10/options/7')
      .set('Cookie', authCookie(5));

    expect(res.status).toBe(200);
    expect(mockPrisma.groupEventOption.deleteMany).toHaveBeenCalledWith({ where: { eventId: 10, restaurantId: 7 } });
  });

  it('blocks a different member when the adder is still in the group', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    // The remover (id=7) is a member; the adder (id=5) is ALSO still a member.
    (mockPrisma.groupMember.findUnique as jest.Mock).mockImplementation(({ where }: { where: { groupId_userId: { userId: number } } }) =>
      Promise.resolve({ groupId: 1, userId: where.groupId_userId.userId }),
    );
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({ id: 10, groupId: 1, status: 'OPEN' });
    (mockPrisma.groupEventOption.findUnique as jest.Mock).mockResolvedValue({
      eventId: 10, restaurantId: 7, addedById: 5,
    });

    const res = await request(buildApp())
      .delete('/api/groups/1/events/10/options/7')
      .set('Cookie', authCookie(7));

    expect(res.status).toBe(403);
    expect(mockPrisma.groupEventOption.deleteMany).not.toHaveBeenCalled();
  });

  it('lets ANY member remove an orphaned option (adder no longer in group)', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupMember.findUnique as jest.Mock).mockImplementation(({ where }: { where: { groupId_userId: { userId: number } } }) => {
      // User 7 is the remover (still in group). User 5 (the adder) has LEFT —
      // their membership lookup returns null.
      if (where.groupId_userId.userId === 7) return Promise.resolve({ groupId: 1, userId: 7 });
      return Promise.resolve(null);
    });
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({ id: 10, groupId: 1, status: 'OPEN' });
    (mockPrisma.groupEventOption.findUnique as jest.Mock).mockResolvedValue({
      eventId: 10, restaurantId: 7, addedById: 5,
    });

    const res = await request(buildApp())
      .delete('/api/groups/1/events/10/options/7')
      .set('Cookie', authCookie(7));

    expect(res.status).toBe(200);
    expect(mockPrisma.groupEventOption.deleteMany).toHaveBeenCalledWith({ where: { eventId: 10, restaurantId: 7 } });
  });

  it('host can always remove regardless of adder', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup); // hostId = 1
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 1 });
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({ id: 10, groupId: 1, status: 'OPEN' });
    (mockPrisma.groupEventOption.findUnique as jest.Mock).mockResolvedValue({
      eventId: 10, restaurantId: 7, addedById: 99, // someone else added it
    });

    const res = await request(buildApp())
      .delete('/api/groups/1/events/10/options/7')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
  });
});

// ── Q4a: Group favorites ───────────────────────────────────────
describe('Group favorites (CRUD)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('GET returns 403 for non-members', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(buildApp())
      .get('/api/groups/1/favorites')
      .set('Cookie', authCookie(99));
    expect(res.status).toBe(403);
  });

  it('GET returns the list ordered newest-first', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 5 });
    (mockPrisma.groupFavorite.findMany as jest.Mock).mockResolvedValue([
      { groupId: 1, restaurantId: 10, addedById: 1, createdAt: new Date(), restaurant: { id: 10, name: 'Pho 99' }, addedBy: { id: 1, username: 'alice' } },
    ]);

    const res = await request(buildApp())
      .get('/api/groups/1/favorites')
      .set('Cookie', authCookie(5));

    expect(res.status).toBe(200);
    expect(res.body.favorites).toHaveLength(1);
    expect(mockPrisma.groupFavorite.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: 1 }, orderBy: { createdAt: 'desc' } }),
    );
  });

  it('POST upserts so re-adding a favorite is idempotent', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 5 });
    // Privacy check loads the restaurant first — return a public row so the
    // route proceeds to the favorite upsert.
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({ private: false, createdBy: null });
    (mockPrisma.groupFavorite.upsert as jest.Mock).mockResolvedValue({
      groupId: 1, restaurantId: 10, addedById: 5,
    });

    const res = await request(buildApp())
      .post('/api/groups/1/favorites/10')
      .set('Cookie', authCookie(5));

    expect(res.status).toBe(201);
    expect(mockPrisma.groupFavorite.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { groupId_restaurantId: { groupId: 1, restaurantId: 10 } },
        create: expect.objectContaining({ addedById: 5 }),
        update: {},
      }),
    );
  });

  it('POST rejects archived groups', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue({ ...fakeGroup, archivedAt: new Date() });
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 5 });

    const res = await request(buildApp())
      .post('/api/groups/1/favorites/10')
      .set('Cookie', authCookie(5));
    expect(res.status).toBe(400);
  });

  it('DELETE — any member can remove (collectively owned)', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 5 });

    const res = await request(buildApp())
      .delete('/api/groups/1/favorites/10')
      .set('Cookie', authCookie(5));

    expect(res.status).toBe(200);
    expect(mockPrisma.groupFavorite.deleteMany).toHaveBeenCalledWith({ where: { groupId: 1, restaurantId: 10 } });
  });
});

// ── Q4b: Group insights ────────────────────────────────────────
describe('GET /api/groups/:id/insights', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 403 for non-members', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue(null);
    const res = await request(buildApp())
      .get('/api/groups/1/insights')
      .set('Cookie', authCookie(99));
    expect(res.status).toBe(403);
  });

  it('returns empty rollups when group has no DONE events', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 1 });
    (mockPrisma.groupEventResult.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(buildApp())
      .get('/api/groups/1/insights')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalEvents: 0,
      distinctWinners: 0,
      methodCounts: {},
      topConsidered: [],
      oftenSkipped: [],
      topWinners: [],
      recent: [],
    });
  });

  it('aggregates considerations, wins, methods, and member appearances', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 1 });

    // 3 events: pho wins twice, sushi wins once. Bob attends all 3, Carol 1.
    (mockPrisma.groupEventResult.findMany as jest.Mock).mockResolvedValue([
      {
        winnerName: 'Pho 99', method: 'vote', voteMethod: 'simple', participants: ['alice', 'bob', 'carol'],
        restaurantPool: [{ id: 1, name: 'Pho 99' }, { id: 2, name: 'Sushi Bar' }, { id: 3, name: 'Pizza Place' }],
        ballots: null, createdAt: new Date('2026-05-01'),
        event: { id: 1, name: 'Friday', voteMethod: 'SIMPLE', scheduledFor: null },
      },
      {
        winnerName: 'Pho 99', method: 'flip', voteMethod: null, participants: ['alice', 'bob'],
        restaurantPool: [{ id: 1, name: 'Pho 99' }, { id: 2, name: 'Sushi Bar' }],
        ballots: null, createdAt: new Date('2026-05-02'),
        event: { id: 2, name: 'Saturday', voteMethod: 'SIMPLE', scheduledFor: null },
      },
      {
        winnerName: 'Sushi Bar', method: 'spin', voteMethod: null, participants: ['alice', 'bob'],
        restaurantPool: [{ id: 1, name: 'Pho 99' }, { id: 2, name: 'Sushi Bar' }],
        ballots: null, createdAt: new Date('2026-05-03'),
        event: { id: 3, name: 'Sunday', voteMethod: 'SIMPLE', scheduledFor: null },
      },
    ]);

    const res = await request(buildApp())
      .get('/api/groups/1/insights')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.totalEvents).toBe(3);
    expect(res.body.distinctWinners).toBe(2);
    expect(res.body.methodCounts).toEqual({ vote: 1, flip: 1, spin: 1 });
    expect(res.body.memberAppearances).toEqual({ alice: 3, bob: 3, carol: 1 });

    // Pho: considered 3 times (in all 3 pools) + won 2 times
    const pho = res.body.topConsidered.find((r: { restaurantId: string }) => r.restaurantId === '1');
    expect(pho).toMatchObject({ name: 'Pho 99', considered: 3, wins: 2 });

    // Pizza Place: considered once, never won — fits oftenSkipped only when ≥2 considerations,
    // so with only 1 consideration it shouldn't appear there. Verify.
    expect(res.body.oftenSkipped.find((r: { restaurantId: string }) => r.restaurantId === '3')).toBeUndefined();
  });

  it('builds memberCuisines fingerprint, hiding members with <3 contributions', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 1 });
    (mockPrisma.groupEventResult.findMany as jest.Mock).mockResolvedValue([]);
    // Alice proposes 3× Italian + 1× Thai (4 total → shows up);
    // Bob proposes 2× Sushi (2 total → below the 3-add cutoff, filtered out).
    (mockPrisma.groupEventOption.findMany as jest.Mock).mockResolvedValue([
      { addedBy: { username: 'alice' }, restaurant: { cuisineType: 'Italian' } },
      { addedBy: { username: 'alice' }, restaurant: { cuisineType: 'Italian' } },
      { addedBy: { username: 'alice' }, restaurant: { cuisineType: 'Italian' } },
      { addedBy: { username: 'alice' }, restaurant: { cuisineType: 'Thai'    } },
      { addedBy: { username: 'bob'   }, restaurant: { cuisineType: 'Sushi'   } },
      { addedBy: { username: 'bob'   }, restaurant: { cuisineType: 'Sushi'   } },
    ]);

    const res = await request(buildApp())
      .get('/api/groups/1/insights')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.memberCuisines).toBeDefined();
    expect(res.body.memberCuisines.alice).toEqual([
      { cuisine: 'Italian', count: 3 },
      { cuisine: 'Thai',    count: 1 },
    ]);
    expect(res.body.memberCuisines.bob).toBeUndefined(); // below threshold
  });

  it('counts ranked-vote alignment when voter ranks the winner #1', async () => {
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue(fakeGroup);
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 1 });
    // One ranked event: winner is Pho (id 1). Alice ranked Pho #1 (aligned);
    // Bob ranked Sushi #1 with Pho second (not aligned by strict-#1 rule).
    (mockPrisma.groupEventResult.findMany as jest.Mock).mockResolvedValue([
      {
        winnerName: 'Pho 99', method: 'vote', voteMethod: 'ranked',
        participants: ['alice', 'bob'],
        restaurantPool: [{ id: 1, name: 'Pho 99' }, { id: 2, name: 'Sushi Bar' }],
        ballots: {
          alice: ['1', '2'],
          bob:   ['2', '1'],
        },
        createdAt: new Date('2026-05-01'),
        event: { id: 1, name: 'Friday', voteMethod: 'RANKED', scheduledFor: null },
      },
    ]);

    const res = await request(buildApp())
      .get('/api/groups/1/insights')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.memberWinAccuracy.alice).toMatchObject({ picks: 1, wins: 1, rate: 1 });
    expect(res.body.memberWinAccuracy.bob).toMatchObject({ picks: 1, wins: 0, rate: 0 });
  });
});

// ── voterMeta currentUsername enrichment on the ballot-detail endpoint ──
describe('GET /api/groups/:id/events/:eventId (voterMeta enrichment)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sets currentUsername when a voter has renamed since the vote', async () => {
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 5 });
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      id: 10, groupId: 1,
      result: {
        winnerName: 'Pho 99',
        method: 'vote',
        voteMethod: 'simple',
        voterMeta: {
          // Voter chose display name "Alice"; was signed in as @alice_old at vote time.
          'Alice': { isGuest: false, username: 'alice_old', userId: 42 },
          // Bob has not renamed — currentUsername should come back null.
          'Bob':   { isGuest: false, username: 'bobsmith',  userId: 7  },
          // Guest — no userId, no enrichment.
          'Guest': { isGuest: true,  username: null,        userId: null },
        },
      },
    });
    // The lookup returns Alice's CURRENT name (renamed since) and Bob's unchanged.
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
      { id: 42, username: 'alice_new' },
      { id: 7,  username: 'bobsmith'  },
    ]);

    const res = await request(buildApp())
      .get('/api/groups/1/events/10')
      .set('Cookie', authCookie(5));

    expect(res.status).toBe(200);
    expect(res.body.event.result.voterMeta.Alice).toMatchObject({
      username: 'alice_old',       // historical
      currentUsername: 'alice_new', // live — different from historical
    });
    expect(res.body.event.result.voterMeta.Bob).toMatchObject({
      username: 'bobsmith',
      currentUsername: null,        // unchanged
    });
    expect(res.body.event.result.voterMeta.Guest).toMatchObject({
      isGuest: true,
      currentUsername: null,        // no userId → no lookup
    });
  });

  it('handles a deleted account by leaving currentUsername null', async () => {
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 5 });
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      id: 10, groupId: 1,
      result: {
        winnerName: 'Pho',
        method: 'vote',
        voteMethod: 'simple',
        voterMeta: {
          'Ghost': { isGuest: false, username: 'ghost_old', userId: 999 },
        },
      },
    });
    // User no longer exists in the lookup result
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(buildApp())
      .get('/api/groups/1/events/10')
      .set('Cookie', authCookie(5));

    expect(res.status).toBe(200);
    expect(res.body.event.result.voterMeta.Ghost).toMatchObject({
      username: 'ghost_old',
      currentUsername: null, // account gone — no live name to surface
    });
  });

  it('skips the user lookup entirely when voterMeta has no userIds (pre-rollout / guest-only)', async () => {
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 5 });
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      id: 10, groupId: 1,
      result: {
        winnerName: 'Pho',
        method: 'vote',
        voteMethod: 'simple',
        // No userId on any entry — legacy data.
        voterMeta: {
          'Alice': { isGuest: false, username: 'alice' },
        },
      },
    });

    const res = await request(buildApp())
      .get('/api/groups/1/events/10')
      .set('Cookie', authCookie(5));

    expect(res.status).toBe(200);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });
});

// ── voterMeta enrichment on the group-detail endpoint ──
// The same enrichment is applied to every event.result on GET /api/groups/:id
// so the inline ResultDisplay component (not just the ballot modal) can show
// rename info on host labels and participant pills.
describe('GET /api/groups/:id (voterMeta enrichment)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('enriches voterMeta on every event.result in the group payload', async () => {
    (mockPrisma.groupMember.findUnique as jest.Mock).mockResolvedValue({ groupId: 1, userId: 5 });
    // Single persistent mock that satisfies both findUnique calls the route
    // makes (archivedAt-only select + the full include). The full payload
    // already carries `archivedAt: null` so the auto-launch check is happy.
    // Persistent (not Once) so we don't have to know the exact call count
    // and so earlier tests' un-consumed Once-queue doesn't leak through.
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue({
      id: 1, name: 'Group', hostId: 5, archivedAt: null,
      host: { id: 5, username: 'host', avatarUrl: null },
      members: [],
      invites: [],
      events: [
        {
          id: 10, name: 'Friday Night', status: 'DONE',
          result: {
            winnerName: 'Pho',
            voterMeta: {
              'Alice': { isGuest: false, username: 'alice_old', userId: 42 },
            },
          },
        },
      ],
    });
    (mockPrisma.groupEvent.findMany as jest.Mock).mockResolvedValue([]); // no overdue events
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
      { id: 42, username: 'alice_new' }, // Alice has renamed
    ]);

    const res = await request(buildApp())
      .get('/api/groups/1')
      .set('Cookie', authCookie(5));

    expect(res.status).toBe(200);
    expect(res.body.group.events[0].result.voterMeta.Alice).toMatchObject({
      username: 'alice_old',
      currentUsername: 'alice_new',
    });
  });
});
