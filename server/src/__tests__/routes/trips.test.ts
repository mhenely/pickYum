import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { DeepMockProxy } from 'jest-mock-extended';

jest.mock('../../lib/prisma');
// sessions.ts is mocked because start-voting calls into createSession; the
// real implementation would try to talk to Redis/in-memory and isn't what
// we're testing here. accept-result reads back via getSession.
jest.mock('../../sessions', () => ({
  createSession:     jest.fn(),
  getSession:        jest.fn(),
  saveSession:       jest.fn().mockResolvedValue(undefined),
  notifyClients:     jest.fn(),
  // withSessionLock runs the callback directly in tests — concurrency
  // semantics aren't what we're exercising here.
  withSessionLock:   jest.fn((_id: string, fn: () => Promise<unknown>) => fn()),
  generateSessionId: jest.fn(() => 'sess-mock-id'),
}));

import prisma from '../../lib/prisma';
import tripsRouter from '../../routes/trips';

const mockPrisma = prisma as unknown as DeepMockProxy<PrismaClient>;
const SECRET = process.env.JWT_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/trips', tripsRouter);
  return app;
}

const authCookie = (userId = 1) => `token=${jwt.sign({ userId }, SECRET)}`;

// Canonical fake trip returned by checkTripAuth's findUnique. The auth
// helper does a select that includes `members: where userId=req.userId`,
// so the `members` array here represents only the caller's own membership
// row (or empty for non-members). hostId=1 throughout.
const tripMetaForHost = {
  id: 1,
  hostId: 1,
  archivedAt: null,
  members: [{ userId: 1 }],
};

const tripMetaForNonMember = {
  id: 1,
  hostId: 1,
  archivedAt: null,
  members: [],
};

const tripMetaForMember = (userId: number) => ({
  id: 1,
  hostId: 1,
  archivedAt: null,
  members: [{ userId }],
});

// Full include shape — the routes re-query with `include: tripInclude`
// after most mutations to return the fresh denormalized trip. Tests don't
// assert on contents of this payload (the route does), so a minimal stub
// is fine.
const fullTrip = {
  id: 1,
  name: 'Italy 2026',
  destination: 'Rome, Italy',
  hostId: 1,
  archivedAt: null,
  host:    { id: 1, username: 'alice', avatarUrl: null },
  members: [],
  anchors: [],
  invites: [],
};

beforeEach(() => {
  // resetAllMocks clears mockImplementation + queued mockResolvedValueOnce
  // returns, not just call history (which is what clearAllMocks does). We
  // need the full reset because a few tests below set persistent impls
  // (e.g. $transaction as `(fn) => fn(mockPrisma)`) that would otherwise
  // leak into later tests and cause "fn is not a function" when those tests
  // call `$transaction([op1, op2])`.
  jest.resetAllMocks();
  // Default safety net for the auto-launch sweeper in GET /api/trips/:id —
  // it iterates `prisma.groupEvent.findMany`, which jest-mock-extended
  // returns as undefined when unmocked. Tests that exercise overdue events
  // can override; the rest get a harmless empty result.
  (mockPrisma.groupEvent.findMany as jest.Mock).mockResolvedValue([]);
  // resetAllMocks also wipes the factory implementations on the mocked
  // `../../sessions` module. Re-establish the pass-throughs each test:
  // withSessionLock just invokes the callback (we don't exercise the lock's
  // serialization in these tests), and generateSessionId returns a stable id
  // so route assertions can match on it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sessionsMock = require('../../sessions') as {
    withSessionLock: jest.Mock;
    generateSessionId: jest.Mock;
  };
  sessionsMock.withSessionLock.mockImplementation((_id: string, fn: () => Promise<unknown>) => fn());
  sessionsMock.generateSessionId.mockReturnValue('sess-mock-id');
});

// ──────────────────────────────────────────────────────────────
// List + auth
// ──────────────────────────────────────────────────────────────
describe('GET /api/trips', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/trips');
    expect(res.status).toBe(401);
  });

  it('returns hosted + member trips for the caller', async () => {
    (mockPrisma.trip.findMany as jest.Mock)
      .mockResolvedValueOnce([fullTrip])                          // hosted
      .mockResolvedValueOnce([{ ...fullTrip, id: 2, hostId: 9 }]); // member-only

    const res = await request(buildApp()).get('/api/trips').set('Cookie', authCookie(1));
    expect(res.status).toBe(200);
    expect(res.body.trips).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────
// Create
// ──────────────────────────────────────────────────────────────
describe('POST /api/trips', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).post('/api/trips').send({ name: 'x', destination: 'y' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(buildApp())
      .post('/api/trips').set('Cookie', authCookie(1))
      .send({ destination: 'Rome' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when destination is missing', async () => {
    const res = await request(buildApp())
      .post('/api/trips').set('Cookie', authCookie(1))
      .send({ name: 'Italy 2026' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when endDate precedes startDate', async () => {
    const res = await request(buildApp())
      .post('/api/trips').set('Cookie', authCookie(1))
      .send({ name: 'Italy 2026', destination: 'Rome', startDate: '2026-06-10', endDate: '2026-06-01' });
    expect(res.status).toBe(400);
  });

  it('creates the trip in a transaction and returns 201', async () => {
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn) => fn(mockPrisma));
    (mockPrisma.trip.create as jest.Mock).mockResolvedValue({ id: 1 });
    (mockPrisma.tripMember.create as jest.Mock).mockResolvedValue({ tripId: 1, userId: 1 });
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValue(fullTrip);

    const res = await request(buildApp())
      .post('/api/trips').set('Cookie', authCookie(1))
      .send({ name: 'Italy 2026', destination: 'Rome, Italy' });

    expect(res.status).toBe(201);
    expect(res.body.trip.name).toBe('Italy 2026');
    // Host is added as a member as part of the same transaction
    expect(mockPrisma.tripMember.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tripId: 1, userId: 1 }),
    });
  });
});

// ──────────────────────────────────────────────────────────────
// Single trip read + edit + archive
// ──────────────────────────────────────────────────────────────
describe('GET /api/trips/:id', () => {
  it('returns 403 when caller is not a member', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForNonMember);
    const res = await request(buildApp()).get('/api/trips/1').set('Cookie', authCookie(999));
    expect(res.status).toBe(403);
  });

  it('returns 404 when trip does not exist', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(null);
    const res = await request(buildApp()).get('/api/trips/1').set('Cookie', authCookie(1));
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid id', async () => {
    const res = await request(buildApp()).get('/api/trips/abc').set('Cookie', authCookie(1));
    expect(res.status).toBe(400);
  });

  it('returns the trip when caller is the host', async () => {
    (mockPrisma.trip.findUnique as jest.Mock)
      .mockResolvedValueOnce(tripMetaForHost)  // auth check
      .mockResolvedValueOnce(fullTrip);         // full read
    const res = await request(buildApp()).get('/api/trips/1').set('Cookie', authCookie(1));
    expect(res.status).toBe(200);
    expect(res.body.trip).toMatchObject({ id: 1 });
  });
});

describe('PATCH /api/trips/:id', () => {
  it('returns 403 when caller is not the host', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce({
      ...tripMetaForHost, members: [{ userId: 5 }],
    });
    const res = await request(buildApp())
      .patch('/api/trips/1').set('Cookie', authCookie(5))
      .send({ name: 'New name' });
    expect(res.status).toBe(403);
  });

  it('rejects edits on archived trips', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce({
      ...tripMetaForHost, archivedAt: new Date(),
    });
    const res = await request(buildApp())
      .patch('/api/trips/1').set('Cookie', authCookie(1))
      .send({ name: 'New name' });
    expect(res.status).toBe(400);
  });

  it('updates name + destination for the host', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.trip.update as jest.Mock).mockResolvedValue({ ...fullTrip, name: 'Italy Trip' });

    const res = await request(buildApp())
      .patch('/api/trips/1').set('Cookie', authCookie(1))
      .send({ name: 'Italy Trip', destination: 'Florence' });

    expect(res.status).toBe(200);
    expect(mockPrisma.trip.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data:  expect.objectContaining({ name: 'Italy Trip', destination: 'Florence' }),
      }),
    );
  });
});

describe('POST /api/trips/:id/archive', () => {
  it('returns 403 for non-host', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce({
      ...tripMetaForHost, members: [{ userId: 5 }],
    });
    const res = await request(buildApp()).post('/api/trips/1/archive').set('Cookie', authCookie(5));
    expect(res.status).toBe(403);
  });

  it('returns 400 if the trip is already archived', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce({
      ...tripMetaForHost, archivedAt: new Date(),
    });
    const res = await request(buildApp()).post('/api/trips/1/archive').set('Cookie', authCookie(1));
    expect(res.status).toBe(400);
  });

  it('archives (soft-delete) for the host', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.trip.update as jest.Mock).mockResolvedValue({ ...fullTrip, archivedAt: new Date() });

    const res = await request(buildApp()).post('/api/trips/1/archive').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(mockPrisma.trip.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data:  expect.objectContaining({ archivedAt: expect.any(Date) }),
      }),
    );
    // Hard delete must NOT be called — soft-delete keeps history for members.
    expect(mockPrisma.trip.delete).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────
// Invite flow — host-only, by-username, with rescind + respond
// ──────────────────────────────────────────────────────────────
describe('POST /api/trips/:id/invites', () => {
  it('returns 403 when caller is not the host', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce({
      ...tripMetaForHost, members: [{ userId: 5 }],
    });
    const res = await request(buildApp())
      .post('/api/trips/1/invites').set('Cookie', authCookie(5))
      .send({ username: 'bob' });
    expect(res.status).toBe(403);
  });

  it('returns 400 if username is missing/blank', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    const res = await request(buildApp())
      .post('/api/trips/1/invites').set('Cookie', authCookie(1))
      .send({ username: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the invited user does not exist', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(buildApp())
      .post('/api/trips/1/invites').set('Cookie', authCookie(1))
      .send({ username: 'ghost' });
    expect(res.status).toBe(404);
  });

  it('refuses self-invite', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 1, username: 'alice', avatarUrl: null });

    const res = await request(buildApp())
      .post('/api/trips/1/invites').set('Cookie', authCookie(1))
      .send({ username: 'alice' });
    expect(res.status).toBe(400);
  });

  it('returns 409 when target is already a member', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 2, username: 'bob', avatarUrl: null });
    (mockPrisma.tripMember.findUnique as jest.Mock).mockResolvedValue({ tripId: 1, userId: 2 });

    const res = await request(buildApp())
      .post('/api/trips/1/invites').set('Cookie', authCookie(1))
      .send({ username: 'bob' });
    expect(res.status).toBe(409);
  });

  it('upserts the invite to PENDING (re-invites a previously DECLINED user)', async () => {
    (mockPrisma.trip.findUnique as jest.Mock)
      .mockResolvedValueOnce(tripMetaForHost)
      .mockResolvedValueOnce(fullTrip);
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 2, username: 'bob', avatarUrl: null });
    (mockPrisma.tripMember.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.tripMember.count   as jest.Mock).mockResolvedValue(1);
    (mockPrisma.tripInvite.count   as jest.Mock).mockResolvedValue(0);
    (mockPrisma.tripInvite.upsert  as jest.Mock).mockResolvedValue({
      id: 7, tripId: 1, invitedId: 2, invitedById: 1, status: 'PENDING',
    });

    const res = await request(buildApp())
      .post('/api/trips/1/invites').set('Cookie', authCookie(1))
      .send({ username: 'bob' });

    expect(res.status).toBe(201);
    expect(mockPrisma.tripInvite.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where:  { tripId_invitedId: { tripId: 1, invitedId: 2 } },
        create: expect.objectContaining({ status: 'PENDING', invitedById: 1 }),
        update: expect.objectContaining({ status: 'PENDING', invitedById: 1 }),
      }),
    );
  });

  it('rejects when member + pending count is at the cap', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ id: 2, username: 'bob', avatarUrl: null });
    (mockPrisma.tripMember.findUnique as jest.Mock).mockResolvedValue(null);
    // 50 = MAX_MEMBERS_PER_TRIP
    (mockPrisma.tripMember.count as jest.Mock).mockResolvedValue(40);
    (mockPrisma.tripInvite.count as jest.Mock).mockResolvedValue(10);

    const res = await request(buildApp())
      .post('/api/trips/1/invites').set('Cookie', authCookie(1))
      .send({ username: 'bob' });
    expect(res.status).toBe(400);
    expect(mockPrisma.tripInvite.upsert).not.toHaveBeenCalled();
  });
});

describe('POST /api/trips/:id/invites/import-from-group', () => {
  it('returns 403 when caller is not a member of the source group', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue({
      hostId: 99, members: [{ userId: 5 }], // host=99, member=5; caller=1
    });

    const res = await request(buildApp())
      .post('/api/trips/1/invites/import-from-group')
      .set('Cookie', authCookie(1))
      .send({ groupId: 7 });
    expect(res.status).toBe(403);
  });

  it('skips existing members + already-pending invitees + the trip host', async () => {
    (mockPrisma.trip.findUnique as jest.Mock)
      .mockResolvedValueOnce(tripMetaForHost)
      .mockResolvedValueOnce(fullTrip);
    // Source group: host=1 (trip host, skipped), members 2,3,4,5.
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue({
      hostId: 1, members: [{ userId: 2 }, { userId: 3 }, { userId: 4 }, { userId: 5 }],
    });
    // 2 is already on the trip; 3 has a pending invite already. 4 + 5 are new.
    (mockPrisma.tripMember.findMany as jest.Mock).mockResolvedValue([{ userId: 1 }, { userId: 2 }]);
    (mockPrisma.tripInvite.findMany as jest.Mock).mockResolvedValue([{ invitedId: 3 }]);
    (mockPrisma.tripInvite.createMany as jest.Mock).mockResolvedValue({ count: 2 });
    (mockPrisma.tripInvite.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    const res = await request(buildApp())
      .post('/api/trips/1/invites/import-from-group')
      .set('Cookie', authCookie(1))
      .send({ groupId: 7 });

    expect(res.status).toBe(200);
    expect(res.body.invited).toBe(2);          // only 4 + 5 get invited
    // Was N parallel upserts; now a single createMany covers net-new rows
    // and a single updateMany flips any DECLINED rows back to PENDING.
    expect(mockPrisma.tripInvite.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: expect.arrayContaining([
          expect.objectContaining({ invitedId: 4 }),
          expect.objectContaining({ invitedId: 5 }),
        ]),
      }),
    );
  });

  it('caps the import so total invites + members stay within MAX_MEMBERS_PER_TRIP', async () => {
    (mockPrisma.trip.findUnique as jest.Mock)
      .mockResolvedValueOnce(tripMetaForHost)
      .mockResolvedValueOnce(fullTrip);
    // Pretend the group has 5 candidates beyond the trip host.
    (mockPrisma.group.findUnique as jest.Mock).mockResolvedValue({
      hostId: 1, members: [
        { userId: 10 }, { userId: 11 }, { userId: 12 }, { userId: 13 }, { userId: 14 },
      ],
    });
    // 48 existing members + 0 pending → room for 2 more before the 50 cap.
    (mockPrisma.tripMember.findMany as jest.Mock).mockResolvedValue(
      Array.from({ length: 48 }, (_, i) => ({ userId: 100 + i })),
    );
    (mockPrisma.tripInvite.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.tripInvite.createMany as jest.Mock).mockResolvedValue({ count: 2 });
    (mockPrisma.tripInvite.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    const res = await request(buildApp())
      .post('/api/trips/1/invites/import-from-group')
      .set('Cookie', authCookie(1))
      .send({ groupId: 7 });

    expect(res.status).toBe(200);
    expect(res.body.invited).toBe(2);
    expect(res.body.skipped).toBe(3);
  });
});

describe('DELETE /api/trips/:id/invites/:inviteId', () => {
  it('returns 403 for non-host', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce({
      ...tripMetaForHost, members: [{ userId: 5 }],
    });
    const res = await request(buildApp())
      .delete('/api/trips/1/invites/7').set('Cookie', authCookie(5));
    expect(res.status).toBe(403);
  });

  it('rescinds (idempotent — succeeds even if already gone)', async () => {
    (mockPrisma.trip.findUnique as jest.Mock)
      .mockResolvedValueOnce(tripMetaForHost)
      .mockResolvedValueOnce(fullTrip);
    (mockPrisma.tripInvite.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });

    const res = await request(buildApp())
      .delete('/api/trips/1/invites/7').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    // The deleteMany filter scopes by both inviteId AND tripId so a host of
    // a different trip can't rescind someone else's invite by guessing its id.
    expect(mockPrisma.tripInvite.deleteMany).toHaveBeenCalledWith({
      where: { id: 7, tripId: 1 },
    });
  });
});

describe('POST /api/trips/:id/invites/:inviteId/respond', () => {
  it('returns 400 for an invalid action', async () => {
    const res = await request(buildApp())
      .post('/api/trips/1/invites/7/respond').set('Cookie', authCookie(2))
      .send({ action: 'maybe' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when invite is not for this user (anti-enumeration)', async () => {
    (mockPrisma.tripInvite.findUnique as jest.Mock).mockResolvedValue({
      id: 7, tripId: 1, invitedId: 999, invitedById: 1, status: 'PENDING',
    });
    const res = await request(buildApp())
      .post('/api/trips/1/invites/7/respond').set('Cookie', authCookie(2))
      .send({ action: 'accept' });
    expect(res.status).toBe(404);
  });

  it('returns 400 if invite is no longer PENDING', async () => {
    (mockPrisma.tripInvite.findUnique as jest.Mock).mockResolvedValue({
      id: 7, tripId: 1, invitedId: 2, invitedById: 1, status: 'ACCEPTED',
    });
    const res = await request(buildApp())
      .post('/api/trips/1/invites/7/respond').set('Cookie', authCookie(2))
      .send({ action: 'accept' });
    expect(res.status).toBe(400);
  });

  it('rejects accepting an invite to an archived trip', async () => {
    (mockPrisma.tripInvite.findUnique as jest.Mock).mockResolvedValue({
      id: 7, tripId: 1, invitedId: 2, invitedById: 1, status: 'PENDING',
    });
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValue({ archivedAt: new Date() });

    const res = await request(buildApp())
      .post('/api/trips/1/invites/7/respond').set('Cookie', authCookie(2))
      .send({ action: 'accept' });
    expect(res.status).toBe(400);
  });

  it('decline marks the invite DECLINED — no membership row created', async () => {
    (mockPrisma.tripInvite.findUnique as jest.Mock).mockResolvedValue({
      id: 7, tripId: 1, invitedId: 2, invitedById: 1, status: 'PENDING',
    });
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValue({ archivedAt: null });
    (mockPrisma.tripInvite.update as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .post('/api/trips/1/invites/7/respond').set('Cookie', authCookie(2))
      .send({ action: 'decline' });

    expect(res.status).toBe(200);
    expect(mockPrisma.tripInvite.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 }, data: { status: 'DECLINED' } }),
    );
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('accept atomically marks ACCEPTED + creates a TripMember row', async () => {
    (mockPrisma.tripInvite.findUnique as jest.Mock).mockResolvedValue({
      id: 7, tripId: 1, invitedId: 2, invitedById: 1, status: 'PENDING',
    });
    (mockPrisma.trip.findUnique as jest.Mock)
      .mockResolvedValueOnce({ archivedAt: null })  // archive check
      .mockResolvedValueOnce(fullTrip);              // post-accept read
    (mockPrisma.$transaction as jest.Mock).mockResolvedValue([{}, {}]);

    const res = await request(buildApp())
      .post('/api/trips/1/invites/7/respond').set('Cookie', authCookie(2))
      .send({ action: 'accept' });

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // Status flip + TripMember create are the two operations in the transaction.
    expect(mockPrisma.tripInvite.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 }, data: { status: 'ACCEPTED' } }),
    );
    expect(mockPrisma.tripMember.create).toHaveBeenCalledWith({
      data: { tripId: 1, userId: 2 },
    });
  });
});

describe('GET /api/trips/me/invites', () => {
  it('returns pending invites for the caller', async () => {
    (mockPrisma.tripInvite.findMany as jest.Mock).mockResolvedValue([
      {
        id: 7, tripId: 1, createdAt: new Date(),
        trip:      { id: 1, name: 'Italy', destination: 'Rome' },
        invitedBy: { id: 1, username: 'alice', avatarUrl: null },
      },
    ]);

    const res = await request(buildApp()).get('/api/trips/me/invites').set('Cookie', authCookie(2));

    expect(res.status).toBe(200);
    expect(res.body.invites).toHaveLength(1);
    expect(mockPrisma.tripInvite.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { invitedId: 2, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });
});

// ──────────────────────────────────────────────────────────────
// Member removal — leave vs. host-removes-someone-else
// ──────────────────────────────────────────────────────────────
describe('DELETE /api/trips/:id/members/:userId', () => {
  it('host cannot remove themselves (must archive instead)', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    const res = await request(buildApp())
      .delete('/api/trips/1/members/1').set('Cookie', authCookie(1));
    expect(res.status).toBe(400);
  });

  it('non-host cannot remove someone else', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForMember(5));
    const res = await request(buildApp())
      .delete('/api/trips/1/members/2').set('Cookie', authCookie(5));
    expect(res.status).toBe(403);
  });

  it('lets a member remove themselves (leave) → 204', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForMember(5));
    (mockPrisma.tripMember.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const res = await request(buildApp())
      .delete('/api/trips/1/members/5').set('Cookie', authCookie(5));

    expect(res.status).toBe(204);
    expect(mockPrisma.tripMember.deleteMany).toHaveBeenCalledWith({
      where: { tripId: 1, userId: 5 },
    });
  });

  it('lets the host remove another member → 200 with refreshed trip', async () => {
    (mockPrisma.trip.findUnique as jest.Mock)
      .mockResolvedValueOnce(tripMetaForHost)
      .mockResolvedValueOnce(fullTrip);
    (mockPrisma.tripMember.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const res = await request(buildApp())
      .delete('/api/trips/1/members/2').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.trip).toMatchObject({ id: 1 });
  });
});

// ──────────────────────────────────────────────────────────────
// Anchors — CRUD + isPrimary invariant
// ──────────────────────────────────────────────────────────────
describe('POST /api/trips/:id/anchors', () => {
  it('returns 403 for non-host', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForMember(5));
    const res = await request(buildApp())
      .post('/api/trips/1/anchors').set('Cookie', authCookie(5))
      .send({ label: 'Hotel', address: '1 Main St' });
    expect(res.status).toBe(403);
  });

  it('returns 400 when label or address is missing', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    const res = await request(buildApp())
      .post('/api/trips/1/anchors').set('Cookie', authCookie(1))
      .send({ label: '   ', address: '' });
    expect(res.status).toBe(400);
  });

  it('first anchor is auto-promoted to primary even without isPrimary flag', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.tripAnchor.count as jest.Mock).mockResolvedValue(0);
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn) => fn(mockPrisma));
    (mockPrisma.tripAnchor.create as jest.Mock).mockResolvedValue({
      id: 1, tripId: 1, label: 'Hotel', address: '1 Main', isPrimary: true,
    });

    const res = await request(buildApp())
      .post('/api/trips/1/anchors').set('Cookie', authCookie(1))
      .send({ label: 'Hotel', address: '1 Main' });

    expect(res.status).toBe(201);
    expect(mockPrisma.tripAnchor.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isPrimary: true }) }),
    );
  });

  it('promoting a later anchor demotes the current primary first', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.tripAnchor.count as jest.Mock).mockResolvedValue(1);
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn) => fn(mockPrisma));
    (mockPrisma.tripAnchor.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (mockPrisma.tripAnchor.create as jest.Mock).mockResolvedValue({
      id: 2, tripId: 1, label: 'Office', address: '5 Oak', isPrimary: true,
    });

    const res = await request(buildApp())
      .post('/api/trips/1/anchors').set('Cookie', authCookie(1))
      .send({ label: 'Office', address: '5 Oak', isPrimary: true });

    expect(res.status).toBe(201);
    // Demote-then-create order: updateMany should run before the create
    expect(mockPrisma.tripAnchor.updateMany).toHaveBeenCalledWith({
      where: { tripId: 1, isPrimary: true },
      data:  { isPrimary: false },
    });
  });

  it('rejects when the anchor cap is reached', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.tripAnchor.count as jest.Mock).mockResolvedValue(10); // MAX_ANCHORS_PER_TRIP

    const res = await request(buildApp())
      .post('/api/trips/1/anchors').set('Cookie', authCookie(1))
      .send({ label: 'Eleventh', address: 'Too many' });
    expect(res.status).toBe(400);
  });

  it('returns 409 on duplicate label (unique constraint)', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.tripAnchor.count as jest.Mock).mockResolvedValue(1);
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async () => {
      const err: Error & { code?: string } = Object.assign(new Error('Unique violation'), { code: 'P2002' });
      throw err;
    });

    const res = await request(buildApp())
      .post('/api/trips/1/anchors').set('Cookie', authCookie(1))
      .send({ label: 'Hotel', address: '1 Main' });
    expect(res.status).toBe(409);
  });
});

describe('PATCH /api/trips/:id/anchors/:anchorId', () => {
  it('returns 403 for non-host', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForMember(5));
    const res = await request(buildApp())
      .patch('/api/trips/1/anchors/2').set('Cookie', authCookie(5))
      .send({ label: 'Renamed' });
    expect(res.status).toBe(403);
  });

  it('returns 404 when the anchor belongs to a different trip', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.tripAnchor.findUnique as jest.Mock).mockResolvedValue({
      id: 2, tripId: 999, label: 'X', address: 'Y', isPrimary: false,
    });
    const res = await request(buildApp())
      .patch('/api/trips/1/anchors/2').set('Cookie', authCookie(1))
      .send({ label: 'Renamed' });
    expect(res.status).toBe(404);
  });

  it('rejects clearing isPrimary directly (must promote another instead)', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.tripAnchor.findUnique as jest.Mock).mockResolvedValue({
      id: 2, tripId: 1, label: 'Hotel', address: '1 Main', isPrimary: true,
    });
    const res = await request(buildApp())
      .patch('/api/trips/1/anchors/2').set('Cookie', authCookie(1))
      .send({ isPrimary: false });
    expect(res.status).toBe(400);
  });

  it('promoting demotes the previous primary in the same transaction', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.tripAnchor.findUnique as jest.Mock).mockResolvedValue({
      id: 2, tripId: 1, label: 'Office', address: '5 Oak', isPrimary: false,
    });
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn) => fn(mockPrisma));
    (mockPrisma.tripAnchor.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (mockPrisma.tripAnchor.update as jest.Mock).mockResolvedValue({
      id: 2, tripId: 1, label: 'Office', address: '5 Oak', isPrimary: true,
    });

    const res = await request(buildApp())
      .patch('/api/trips/1/anchors/2').set('Cookie', authCookie(1))
      .send({ isPrimary: true });

    expect(res.status).toBe(200);
    expect(mockPrisma.tripAnchor.updateMany).toHaveBeenCalledWith({
      where: { tripId: 1, isPrimary: true, NOT: { id: 2 } },
      data:  { isPrimary: false },
    });
  });
});

describe('DELETE /api/trips/:id/anchors/:anchorId', () => {
  it('returns 403 for non-host', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForMember(5));
    const res = await request(buildApp())
      .delete('/api/trips/1/anchors/2').set('Cookie', authCookie(5));
    expect(res.status).toBe(403);
  });

  it('deletes a non-primary anchor without re-promotion', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.tripAnchor.findUnique as jest.Mock).mockResolvedValue({
      id: 2, tripId: 1, label: 'Office', address: '5 Oak', isPrimary: false,
    });
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn) => fn(mockPrisma));
    (mockPrisma.tripAnchor.delete as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .delete('/api/trips/1/anchors/2').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(mockPrisma.tripAnchor.delete).toHaveBeenCalledWith({ where: { id: 2 } });
    // No demotion or promotion is needed — only the delete runs.
    expect(mockPrisma.tripAnchor.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.tripAnchor.update).not.toHaveBeenCalled();
  });

  it('promotes the next-oldest anchor when deleting the primary', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.tripAnchor.findUnique as jest.Mock).mockResolvedValue({
      id: 2, tripId: 1, label: 'Hotel', address: '1 Main', isPrimary: true,
    });
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn) => fn(mockPrisma));
    (mockPrisma.tripAnchor.delete as jest.Mock).mockResolvedValue({});
    (mockPrisma.tripAnchor.findFirst as jest.Mock).mockResolvedValue({ id: 3, tripId: 1 });
    (mockPrisma.tripAnchor.update as jest.Mock).mockResolvedValue({ id: 3, isPrimary: true });

    const res = await request(buildApp())
      .delete('/api/trips/1/anchors/2').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(mockPrisma.tripAnchor.findFirst).toHaveBeenCalledWith({
      where: { tripId: 1 },
      orderBy: { createdAt: 'asc' },
    });
    expect(mockPrisma.tripAnchor.update).toHaveBeenCalledWith({
      where: { id: 3 }, data: { isPrimary: true },
    });
  });

  it('handles deleting the last primary anchor gracefully (nothing to promote)', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.tripAnchor.findUnique as jest.Mock).mockResolvedValue({
      id: 2, tripId: 1, label: 'Hotel', address: '1 Main', isPrimary: true,
    });
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn) => fn(mockPrisma));
    (mockPrisma.tripAnchor.delete as jest.Mock).mockResolvedValue({});
    (mockPrisma.tripAnchor.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(buildApp())
      .delete('/api/trips/1/anchors/2').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(mockPrisma.tripAnchor.update).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────
// Meal events (Phase 2) — CRUD, options, voting lifecycle
// ──────────────────────────────────────────────────────────────
const fakeTripEvent = {
  id: 10,
  tripId: 1,
  groupId: null,
  name: 'Friday dinner',
  status: 'OPEN' as const,
  voteMethod: 'SIMPLE' as const,
  mealSlot: null,
  participantUserIds: [] as number[],
  scheduledFor: null,
  votingStartsAt: null,
  sessionId: null,
  createdById: 1,
  createdAt: new Date(),
  options: [],
  createdBy: { id: 1, username: 'alice' },
  result: null,
};

describe('POST /api/trips/:id/events', () => {
  it('returns 403 when caller is not a member', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForNonMember);
    const res = await request(buildApp())
      .post('/api/trips/1/events').set('Cookie', authCookie(999))
      .send({ name: 'Dinner' });
    expect(res.status).toBe(403);
  });

  it('rejects creation on archived trips', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce({
      ...tripMetaForHost, archivedAt: new Date(),
    });
    const res = await request(buildApp())
      .post('/api/trips/1/events').set('Cookie', authCookie(1))
      .send({ name: 'Dinner' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown mealSlot value', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    const res = await request(buildApp())
      .post('/api/trips/1/events').set('Cookie', authCookie(1))
      .send({ name: 'Dinner', mealSlot: 'BRUNCH' }); // not in enum
    expect(res.status).toBe(400);
  });

  it('rejects participantUserIds containing non-members', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    // Only user 2 is a member; 99 is not. The route should 400 because the
    // cleaned list (2, 99) doesn't fully match the validated set ({2}).
    (mockPrisma.tripMember.findMany as jest.Mock).mockResolvedValue([{ userId: 2 }]);

    const res = await request(buildApp())
      .post('/api/trips/1/events').set('Cookie', authCookie(1))
      .send({ name: 'Dinner', participantUserIds: [2, 99] });
    expect(res.status).toBe(400);
  });

  it('creates a meal event with all optional fields', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.tripMember.findMany as jest.Mock).mockResolvedValue([{ userId: 2 }, { userId: 3 }]);
    (mockPrisma.groupEvent.create as jest.Mock).mockResolvedValue(fakeTripEvent);

    const res = await request(buildApp())
      .post('/api/trips/1/events').set('Cookie', authCookie(1))
      .send({
        name: 'Saturday lunch',
        scheduledFor: '2026-06-10T13:00:00.000Z',
        mealSlot: 'LUNCH',
        participantUserIds: [2, 3, 2], // dedupes on the server side
      });

    expect(res.status).toBe(201);
    expect(mockPrisma.groupEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tripId: 1,
          name: 'Saturday lunch',
          mealSlot: 'LUNCH',
          participantUserIds: [2, 3],
          createdById: 1,
        }),
      }),
    );
  });
});

describe('DELETE /api/trips/:id/events/:eventId', () => {
  it('returns 403 when neither host nor creator', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForMember(7));
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...fakeTripEvent, createdById: 1, // not user 7
    });
    const res = await request(buildApp())
      .delete('/api/trips/1/events/10').set('Cookie', authCookie(7));
    expect(res.status).toBe(403);
  });

  it('refuses to delete an event that is currently voting', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...fakeTripEvent, status: 'VOTING',
    });
    const res = await request(buildApp())
      .delete('/api/trips/1/events/10').set('Cookie', authCookie(1));
    expect(res.status).toBe(400);
  });

  it('lets the original creator delete their meal even if not host', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForMember(5));
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...fakeTripEvent, createdById: 5,
    });
    (mockPrisma.groupEvent.delete as jest.Mock).mockResolvedValue({});

    const res = await request(buildApp())
      .delete('/api/trips/1/events/10').set('Cookie', authCookie(5));

    expect(res.status).toBe(200);
    expect(mockPrisma.groupEvent.delete).toHaveBeenCalledWith({ where: { id: 10 } });
  });
});

describe('POST /api/trips/:id/events/:eventId/options', () => {
  it('rejects adding to an event whose status is not OPEN', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...fakeTripEvent, status: 'VOTING',
    });
    const res = await request(buildApp())
      .post('/api/trips/1/events/10/options').set('Cookie', authCookie(1))
      .send({ restaurantId: 7 });
    expect(res.status).toBe(400);
  });

  it('hides private restaurants owned by another user (404 visibility)', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForMember(5));
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue(fakeTripEvent);
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
      id: 7, private: true, createdBy: 99, // owned by someone else
    });
    const res = await request(buildApp())
      .post('/api/trips/1/events/10/options').set('Cookie', authCookie(5))
      .send({ restaurantId: 7 });
    expect(res.status).toBe(404);
  });

  it('auto-publishes a private restaurant when its creator shares it into a meal', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForMember(5));
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue(fakeTripEvent);
    (mockPrisma.restaurant.findUnique as jest.Mock).mockResolvedValue({
      id: 7, private: true, createdBy: 5, // owned by caller
    });
    (mockPrisma.restaurant.update as jest.Mock).mockResolvedValue({ id: 7, private: false });
    (mockPrisma.groupEventOption.upsert as jest.Mock).mockResolvedValue({
      id: 1, eventId: 10, restaurantId: 7, addedById: 5,
    });

    const res = await request(buildApp())
      .post('/api/trips/1/events/10/options').set('Cookie', authCookie(5))
      .send({ restaurantId: 7 });

    expect(res.status).toBe(201);
    expect(mockPrisma.restaurant.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data:  { private: false },
    });
  });
});

describe('PATCH /api/trips/:id/events/:eventId/vote-method', () => {
  it('rejects invalid voteMethod values', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue(fakeTripEvent);
    const res = await request(buildApp())
      .patch('/api/trips/1/events/10/vote-method').set('Cookie', authCookie(1))
      .send({ voteMethod: 'WEIRD' });
    expect(res.status).toBe(400);
  });

  it('locks the method once status is not OPEN', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...fakeTripEvent, status: 'VOTING',
    });
    const res = await request(buildApp())
      .patch('/api/trips/1/events/10/vote-method').set('Cookie', authCookie(1))
      .send({ voteMethod: 'RANKED' });
    expect(res.status).toBe(400);
  });

  it('flips an OPEN meal from SIMPLE to RANKED', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue(fakeTripEvent);
    (mockPrisma.groupEvent.update as jest.Mock).mockResolvedValue({ ...fakeTripEvent, voteMethod: 'RANKED' });

    const res = await request(buildApp())
      .patch('/api/trips/1/events/10/vote-method').set('Cookie', authCookie(1))
      .send({ voteMethod: 'RANKED' });

    expect(res.status).toBe(200);
    expect(res.body.voteMethod).toBe('RANKED');
  });
});

describe('POST /api/trips/:id/events/:eventId/start-voting', () => {
  const { createSession } = require('../../sessions') as { createSession: jest.Mock };
  beforeEach(() => createSession.mockReset());

  it('returns 403 for non-host', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForMember(5));
    const res = await request(buildApp())
      .post('/api/trips/1/events/10/start-voting').set('Cookie', authCookie(5));
    expect(res.status).toBe(403);
  });

  it('rejects when fewer than 2 options exist', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...fakeTripEvent,
      options: [{ restaurantId: 1, restaurant: { id: 1, name: 'A', cuisineType: null, priceLevel: 1 } }],
    });
    const res = await request(buildApp())
      .post('/api/trips/1/events/10/start-voting').set('Cookie', authCookie(1));
    expect(res.status).toBe(400);
  });

  it('starts the session and atomically flips status to VOTING', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...fakeTripEvent,
      options: [
        { restaurantId: 1, restaurant: { id: 1, name: 'Pho 99',   cuisineType: 'Vietnamese', priceLevel: 1 } },
        { restaurantId: 2, restaurant: { id: 2, name: 'Sushi Bar', cuisineType: 'Japanese',   priceLevel: 3 } },
      ],
    });
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ username: 'alice' });
    createSession.mockResolvedValue({ id: 'sess-trip-1' });
    (mockPrisma.groupEvent.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    const res = await request(buildApp())
      .post('/api/trips/1/events/10/start-voting').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe('sess-trip-1');
    // tripId must be passed (10th positional arg) so the session ties back
    // to the trip on accept-result + GroupSessionPage back-nav.
    const args = createSession.mock.calls[0];
    expect(args[4]).toBe(0);   // groupId — 0 for trip events
    expect(args[9]).toBe(1);   // tripId — the trip's id
  });

  it('surrenders the session and 400s if another caller raced ahead', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...fakeTripEvent,
      options: [
        { restaurantId: 1, restaurant: { id: 1, name: 'A', cuisineType: null, priceLevel: 1 } },
        { restaurantId: 2, restaurant: { id: 2, name: 'B', cuisineType: null, priceLevel: 1 } },
      ],
    });
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ username: 'alice' });
    createSession.mockResolvedValue({ id: 'sess-zzz' });
    // Race: another request flipped status first, so the updateMany affects 0 rows.
    (mockPrisma.groupEvent.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    const res = await request(buildApp())
      .post('/api/trips/1/events/10/start-voting').set('Cookie', authCookie(1));

    expect(res.status).toBe(400);
  });
});

describe('POST /api/trips/:id/events/:eventId/accept-result', () => {
  const { getSession } = require('../../sessions') as { getSession: jest.Mock };
  beforeEach(() => getSession.mockReset());

  const votingEvent = {
    ...fakeTripEvent, status: 'VOTING' as const, sessionId: 'sess-trip-1',
  };
  const baseSession = {
    id: 'sess-trip-1', groupId: 0, tripId: 1, eventId: 10,
    hostUserId: 1, hostName: 'alice',
    candidates: ['100', '200'],
    restaurants: { '100': { name: 'Pho 99', type: 'Vietnamese', price: 1 }, '200': { name: 'Sushi Bar', type: 'Japanese', price: 3 } },
    voteMethod: 'simple' as const,
    voters: { alice: {}, bob: {} },
    rankings: {},
    voterMeta: { alice: { isGuest: false, username: 'alice', userId: 1 } },
    submitted: ['alice', 'bob'],
    status: 'done' as const,
    scores: null, irvRounds: null, tiedIds: null,
    result: '100', method: 'flip' as const, scheduledFor: null, createdAt: Date.now(),
  };

  it('returns 403 for non-host', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForMember(5));
    const res = await request(buildApp())
      .post('/api/trips/1/events/10/accept-result').set('Cookie', authCookie(5));
    expect(res.status).toBe(403);
  });

  it('is idempotent when event is already DONE', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...votingEvent, status: 'DONE',
    });
    const res = await request(buildApp())
      .post('/api/trips/1/events/10/accept-result').set('Cookie', authCookie(1));
    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('recovers when the session expired but a result was already persisted', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue(votingEvent);
    getSession.mockResolvedValue(undefined);
    (mockPrisma.groupEventResult.findUnique as jest.Mock).mockResolvedValue({ id: 1, eventId: 10 });
    (mockPrisma.groupEvent.update as jest.Mock).mockResolvedValue({ ...votingEvent, status: 'DONE' });

    const res = await request(buildApp())
      .post('/api/trips/1/events/10/accept-result').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(mockPrisma.groupEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DONE', sessionId: null }),
      }),
    );
  });

  it('persists the result and marks the event DONE in one transaction', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue(votingEvent);
    getSession.mockResolvedValue(baseSession);
    (mockPrisma.restaurant.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.$transaction as jest.Mock).mockResolvedValue([{}, {}]);

    const res = await request(buildApp())
      .post('/api/trips/1/events/10/accept-result').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // The result upsert carries the winner name + method snapshot
    expect(mockPrisma.groupEventResult.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventId: 10 },
        create: expect.objectContaining({
          eventId: 10,
          winnerName: 'Pho 99',
          method: 'flip',
        }),
      }),
    );
    // Trip accept-result must NOT write personal UserAccepted rows (those
    // are group-side personal-insights entries we don't surface for trips).
    expect(mockPrisma.userAccepted.create).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────
// PATCH /:id/events/:eventId/schedule (Phase 3) — host sets
// votingStartsAt; the on-read sweeper in GET /:id opens voting
// once that time has passed.
// ──────────────────────────────────────────────────────────────
describe('PATCH /api/trips/:id/events/:eventId/schedule', () => {
  it('returns 403 for non-host', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForMember(5));
    const res = await request(buildApp())
      .patch('/api/trips/1/events/10/schedule').set('Cookie', authCookie(5))
      .send({ votingStartsAt: '2099-01-01T00:00:00Z' });
    expect(res.status).toBe(403);
  });

  it('rejects a date in the past', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue(fakeTripEvent);
    const res = await request(buildApp())
      .patch('/api/trips/1/events/10/schedule').set('Cookie', authCookie(1))
      .send({ votingStartsAt: '2000-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
  });

  it('refuses to change schedule once the event left OPEN', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...fakeTripEvent, status: 'VOTING',
    });
    const res = await request(buildApp())
      .patch('/api/trips/1/events/10/schedule').set('Cookie', authCookie(1))
      .send({ votingStartsAt: '2099-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
  });

  it('sets votingStartsAt to a future date', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue(fakeTripEvent);
    const future = new Date(Date.now() + 60_000).toISOString();
    (mockPrisma.groupEvent.update as jest.Mock).mockResolvedValue({
      ...fakeTripEvent, votingStartsAt: new Date(future),
    });

    const res = await request(buildApp())
      .patch('/api/trips/1/events/10/schedule').set('Cookie', authCookie(1))
      .send({ votingStartsAt: future });

    expect(res.status).toBe(200);
    expect(mockPrisma.groupEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 10 },
        data:  { votingStartsAt: expect.any(Date) },
      }),
    );
  });

  it('clears votingStartsAt when passed null', async () => {
    (mockPrisma.trip.findUnique as jest.Mock).mockResolvedValueOnce(tripMetaForHost);
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue(fakeTripEvent);
    (mockPrisma.groupEvent.update as jest.Mock).mockResolvedValue({
      ...fakeTripEvent, votingStartsAt: null,
    });

    const res = await request(buildApp())
      .patch('/api/trips/1/events/10/schedule').set('Cookie', authCookie(1))
      .send({ votingStartsAt: null });

    expect(res.status).toBe(200);
    expect(mockPrisma.groupEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 10 },
        data:  { votingStartsAt: null },
      }),
    );
  });
});

// ──────────────────────────────────────────────────────────────
// GET /:id auto-start sweeper (Phase 3) — overdue OPEN events get
// their vote opened on read, just like the groups endpoint.
// ──────────────────────────────────────────────────────────────
describe('GET /api/trips/:id — auto-launch overdue events', () => {
  const { createSession } = require('../../sessions') as { createSession: jest.Mock };
  beforeEach(() => createSession.mockReset());

  it('launches voting for overdue OPEN events before returning the trip', async () => {
    // checkTripAuth's findUnique
    (mockPrisma.trip.findUnique as jest.Mock)
      .mockResolvedValueOnce(tripMetaForHost)
      // The final findUnique that returns the trip with tripInclude
      .mockResolvedValueOnce(fullTrip);

    // One overdue event ready to launch — has ≥2 options.
    (mockPrisma.groupEvent.findMany as jest.Mock).mockResolvedValueOnce([{ id: 10 }]);

    // launchTripVoting re-loads the event with options to feed the session.
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 10, tripId: 1, status: 'OPEN', scheduledFor: null, voteMethod: 'SIMPLE',
      options: [
        { restaurantId: 1, restaurant: { id: 1, name: 'A', cuisineType: null, priceLevel: 1 } },
        { restaurantId: 2, restaurant: { id: 2, name: 'B', cuisineType: null, priceLevel: 1 } },
      ],
    });
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ username: 'alice' });
    // launchTripVoting now pre-allocates the session id via generateSessionId,
    // claims it atomically in the DB (`updateMany` with status='OPEN' guard),
    // and only on win calls `createSession` with the pre-allocated id as the
    // last argument. The test mock for generateSessionId returns
    // 'sess-mock-id' (see beforeEach above), so that's the id we expect to
    // see in BOTH the updateMany and createSession's preallocatedId arg.
    createSession.mockResolvedValue({ id: 'sess-mock-id' });
    (mockPrisma.groupEvent.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    const res = await request(buildApp())
      .get('/api/trips/1').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    // Sweeper queried for overdue events with the right shape
    expect(mockPrisma.groupEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tripId: 1,
          status: 'OPEN',
          votingStartsAt: { lte: expect.any(Date) },
        }),
      }),
    );
    // And launched the session for the overdue event
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(mockPrisma.groupEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 10, status: 'OPEN' },
        data:  expect.objectContaining({ status: 'VOTING', sessionId: 'sess-mock-id' }),
      }),
    );
  });

  it('skips the sweeper entirely on archived trips', async () => {
    (mockPrisma.trip.findUnique as jest.Mock)
      .mockResolvedValueOnce({ ...tripMetaForHost, archivedAt: new Date() })
      .mockResolvedValueOnce({ ...fullTrip, archivedAt: new Date().toISOString() });

    const res = await request(buildApp())
      .get('/api/trips/1').set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    // Sweeper queries are gated behind the archived check — no findMany call.
    expect(mockPrisma.groupEvent.findMany).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });
});
