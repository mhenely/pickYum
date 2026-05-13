import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { DeepMockProxy } from 'jest-mock-extended';

jest.mock('../../lib/prisma');
jest.mock('../../sessions', () => ({
  createSession:  jest.fn(),
  getSession:     jest.fn(),
  saveSession:    jest.fn().mockResolvedValue(undefined),
  notifyClients:  jest.fn(),
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
    getSession.mockResolvedValue(baseSession);
    (mockPrisma.restaurant.findMany as jest.Mock).mockResolvedValue([
      { id: 100, address: '1 Main St', website: 'pho99.test' },
      { id: 200, address: null, website: null },
    ]);
    (mockPrisma.groupMember.findMany as jest.Mock).mockResolvedValue([
      { user: { id: 2, username: 'bob' } },
      { user: { id: 3, username: 'carol' } }, // not in voters — must NOT get an acceptance row
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

    // Host gets a UserAccepted row
    expect(mockPrisma.userAccepted.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 1, restaurantId: 100 }) }),
    );
    // Bob (matched username) gets one
    expect(mockPrisma.userAccepted.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 2, restaurantId: 100 }) }),
    );
    // Carol (no participant entry) does NOT
    expect(mockPrisma.userAccepted.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 3 }) }),
    );
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
    (mockPrisma.$transaction as jest.Mock).mockResolvedValue([{}, {}, {}]);

    const res = await request(buildApp())
      .patch('/api/groups/1/transfer-host')
      .set('Cookie', authCookie(1))
      .send({ newHostId: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Host transferred', hostId: 2 });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // Verify the swap shape: delete new host's GroupMember, update Group.hostId, insert old host as member.
    expect(mockPrisma.groupMember.deleteMany).toHaveBeenCalledWith({ where: { groupId: 1, userId: 2 } });
    expect(mockPrisma.group.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { hostId: 2 } });
    expect(mockPrisma.groupMember.create).toHaveBeenCalledWith({ data: { groupId: 1, userId: 1 } });
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
});
