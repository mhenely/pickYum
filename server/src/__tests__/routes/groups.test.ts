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
  selections: [],
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

describe('POST /api/groups/:id/selections/:restaurantId', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).post('/api/groups/1/selections/5');
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
    voters: { alice: {}, bob: {} },
    submitted: ['alice', 'bob'],
    status: 'done' as const,
    scores: null,
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
      expect.objectContaining({ data: { userId: 1, restaurantId: 100 } }),
    );
    // Bob (matched username) gets one
    expect(mockPrisma.userAccepted.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { userId: 2, restaurantId: 100 } }),
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
