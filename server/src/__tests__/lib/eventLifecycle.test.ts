import { DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

jest.mock('../../lib/prisma');
// Sessions is the Redis-backed storage layer; we don't want real I/O in
// unit tests. Stubbing it lets us assert that launchVoting + the voter-
// token revoker call the right boundary functions in the right order,
// while the actual session state stays in our test fixtures.
jest.mock('../../sessions', () => ({
  createSession:     jest.fn(),
  getSession:        jest.fn(),
  saveSession:       jest.fn().mockResolvedValue(undefined),
  notifyClients:     jest.fn(),
  withSessionLock:   jest.fn((_id: string, fn: () => Promise<unknown>) => fn()),
  generateSessionId: jest.fn(() => 'sess-mock-id'),
}));

import prisma from '../../lib/prisma';
import {
  createSession, getSession, saveSession, notifyClients,
  withSessionLock, generateSessionId,
} from '../../sessions';
import { launchVoting, revokeVoterTokensForUserOnParent } from '../../lib/eventLifecycle';

const mockPrisma = prisma as unknown as DeepMockProxy<PrismaClient>;

beforeEach(() => {
  jest.clearAllMocks();
  (generateSessionId as jest.Mock).mockReturnValue('sess-mock-id');
  (withSessionLock as jest.Mock).mockImplementation((_id: string, fn: () => Promise<unknown>) => fn());
});

const baseEvent = {
  id: 10,
  status: 'OPEN' as const,
  voteMethod: 'SIMPLE' as const,
  scheduledFor: null,
  options: [
    { restaurantId: 1, restaurant: { id: 1, name: 'Pho 99',     cuisineType: 'Vietnamese', priceLevel: 2 } },
    { restaurantId: 2, restaurant: { id: 2, name: 'Sushi Bar',  cuisineType: 'Japanese',   priceLevel: 3 } },
  ],
};

describe('launchVoting', () => {
  it('claims OPEN→VOTING atomically before materializing the session in Redis', async () => {
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...baseEvent, groupId: 5, tripId: null,
    });
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ username: 'alice' });
    // Claim succeeds — updateMany reports 1 row flipped.
    (mockPrisma.groupEvent.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (createSession as jest.Mock).mockResolvedValue({ id: 'sess-mock-id' });

    const session = await launchVoting('group', 5, 10, 99);

    expect(session).toEqual({ id: 'sess-mock-id' });

    // Critical ordering: the DB claim runs BEFORE createSession. If the
    // order ever flips, a race between two callers can leave an orphan
    // session in Redis that nobody can vote on.
    const updateOrder  = (mockPrisma.groupEvent.updateMany as jest.Mock).mock.invocationCallOrder[0];
    const createOrder  = (createSession as jest.Mock).mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(createOrder);

    // The claim is guarded on status='OPEN' — that's the load-bearing part
    // of the race-safety contract.
    expect(mockPrisma.groupEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 10, status: 'OPEN' },
      data:  { status: 'VOTING', sessionId: 'sess-mock-id' },
    });
  });

  it('returns null and skips createSession when the claim loses a race', async () => {
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...baseEvent, groupId: 5, tripId: null,
    });
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ username: 'alice' });
    // Another caller already flipped OPEN→VOTING; our updateMany matches 0.
    (mockPrisma.groupEvent.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    const session = await launchVoting('group', 5, 10, 99);

    expect(session).toBeNull();
    // Zero Redis writes on a lost race — no orphan session to clean up.
    expect(createSession).not.toHaveBeenCalled();
  });

  it('returns null when the event has fewer than 2 candidates', async () => {
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...baseEvent, groupId: 5, tripId: null,
      options: [baseEvent.options[0]], // only one
    });

    const session = await launchVoting('group', 5, 10, 99);

    expect(session).toBeNull();
    // Don't waste the host-lookup or Redis materialize when the event
    // can't possibly support a vote.
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.groupEvent.updateMany).not.toHaveBeenCalled();
  });

  it('returns null when the parent does not match (group caller, trip event)', async () => {
    // Event belongs to trip 7, but caller asked for group 5 — wrong parent.
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...baseEvent, groupId: null, tripId: 7,
    });

    const session = await launchVoting('group', 5, 10, 99);

    expect(session).toBeNull();
    expect(mockPrisma.groupEvent.updateMany).not.toHaveBeenCalled();
  });

  it('returns null when the event status is not OPEN', async () => {
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...baseEvent, groupId: 5, tripId: null,
      status: 'VOTING', // already started
    });

    const session = await launchVoting('group', 5, 10, 99);
    expect(session).toBeNull();
    expect(mockPrisma.groupEvent.updateMany).not.toHaveBeenCalled();
  });

  it('returns null when the host user has been deleted between request and dispatch', async () => {
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...baseEvent, groupId: 5, tripId: null,
    });
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);

    const session = await launchVoting('group', 5, 10, 99);
    expect(session).toBeNull();
    // Bail before flipping status — otherwise we'd leave the event in
    // VOTING with no functional host.
    expect(mockPrisma.groupEvent.updateMany).not.toHaveBeenCalled();
  });

  it('routes trip parent through tripId (and leaves groupId zero in the session)', async () => {
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...baseEvent, groupId: null, tripId: 7,
    });
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ username: 'bob' });
    (mockPrisma.groupEvent.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    await launchVoting('trip', 7, 10, 42);

    // createSession positional args: (hostId, hostName, candidates,
    // restaurants, groupId, eventId, scheduledFor, voteMethod, hostUsername,
    // tripId, sessionId). Verify the polymorphism — groupId=0 for trip
    // sessions, tripId=7 set.
    expect(createSession).toHaveBeenCalledWith(
      42, 'bob',
      expect.any(Array), expect.any(Object),
      0,                                  // groupId — none for trip
      10,                                 // eventId
      null,                               // scheduledFor
      'simple',                           // voteMethod (lowercase)
      'bob',
      7,                                  // tripId
      'sess-mock-id',
    );
  });

  it('passes "ranked" through when the event voteMethod is RANKED', async () => {
    (mockPrisma.groupEvent.findUnique as jest.Mock).mockResolvedValue({
      ...baseEvent, groupId: 5, tripId: null, voteMethod: 'RANKED',
    });
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({ username: 'alice' });
    (mockPrisma.groupEvent.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    await launchVoting('group', 5, 10, 99);

    const args = (createSession as jest.Mock).mock.calls[0];
    expect(args[7]).toBe('ranked');
  });
});

describe('revokeVoterTokensForUserOnParent', () => {
  it('drops voter rows whose voterMeta.userId matches the removed user (group context)', async () => {
    (mockPrisma.groupEvent.findMany as jest.Mock).mockResolvedValue([{ sessionId: 'sess-1' }]);
    (getSession as jest.Mock).mockResolvedValue({
      id: 'sess-1',
      voters:       { alice: { 1: true }, bob: { 1: true } },
      rankings:     { alice: ['1'], bob: ['1'] },
      voterMeta:    {
        alice: { isGuest: false, username: 'alice', userId: 42 },
        bob:   { isGuest: false, username: 'bob',   userId: 7  },
      },
      voterTokens:  { alice: 'tok-a', bob: 'tok-b' },
      submitted:    ['alice', 'bob'],
    });

    await revokeVoterTokensForUserOnParent('group', 5, 42);
    // The inner `withSessionLock(...).catch(...)` is fire-and-forget by
    // design (member-removal response shouldn't block on per-session
    // cleanup). Flush one microtask tick so the queued work runs before
    // we assert on saveSession / notifyClients.
    await new Promise((r) => setImmediate(r));

    // findMany should filter by groupId + active VOTING + sessionId not null.
    expect(mockPrisma.groupEvent.findMany).toHaveBeenCalledWith({
      where: { groupId: 5, status: 'VOTING', sessionId: { not: null } },
      select: { sessionId: true },
    });

    // saveSession should have been called with alice scrubbed but bob intact.
    const saved = (saveSession as jest.Mock).mock.calls[0][0];
    expect(saved.voters).toEqual({ bob: { 1: true } });
    expect(saved.rankings).toEqual({ bob: ['1'] });
    expect(saved.voterMeta).toEqual({
      bob: { isGuest: false, username: 'bob', userId: 7 },
    });
    expect(saved.voterTokens).toEqual({ bob: 'tok-b' });
    expect(saved.submitted).toEqual(['bob']);

    // Clients on the session get notified so the live tally re-renders.
    expect(notifyClients).toHaveBeenCalledWith('sess-1', saved);
  });

  it('uses tripId when parent is "trip"', async () => {
    (mockPrisma.groupEvent.findMany as jest.Mock).mockResolvedValue([]);

    await revokeVoterTokensForUserOnParent('trip', 9, 42);

    expect(mockPrisma.groupEvent.findMany).toHaveBeenCalledWith({
      where: { tripId: 9, status: 'VOTING', sessionId: { not: null } },
      select: { sessionId: true },
    });
  });

  it('is a no-op when the removed user has no voter rows in any active session', async () => {
    (mockPrisma.groupEvent.findMany as jest.Mock).mockResolvedValue([{ sessionId: 'sess-1' }]);
    (getSession as jest.Mock).mockResolvedValue({
      id: 'sess-1',
      voters:    { bob: { 1: true } },
      rankings:  { bob: ['1'] },
      voterMeta: { bob: { isGuest: false, username: 'bob', userId: 7 } },
      voterTokens: { bob: 'tok-b' },
      submitted: ['bob'],
    });

    await revokeVoterTokensForUserOnParent('group', 5, 42);
    await new Promise((r) => setImmediate(r)); // fire-and-forget tick

    // The removed user (42) never voted — saveSession + notifyClients
    // should both skip rather than writing an identical blob.
    expect(saveSession).not.toHaveBeenCalled();
    expect(notifyClients).not.toHaveBeenCalled();
  });

  it('skips sessions whose blob is no longer in Redis (expired)', async () => {
    (mockPrisma.groupEvent.findMany as jest.Mock).mockResolvedValue([{ sessionId: 'sess-stale' }]);
    (getSession as jest.Mock).mockResolvedValue(null);

    await revokeVoterTokensForUserOnParent('group', 5, 42);
    await new Promise((r) => setImmediate(r));

    expect(saveSession).not.toHaveBeenCalled();
    expect(notifyClients).not.toHaveBeenCalled();
  });

  it('does not throw when an individual session lock rejects (failures are non-fatal)', async () => {
    (mockPrisma.groupEvent.findMany as jest.Mock).mockResolvedValue([{ sessionId: 'sess-1' }]);
    (withSessionLock as jest.Mock).mockImplementationOnce(() => Promise.reject(new Error('lock down')));

    // The promise resolves — failures here shouldn't block the calling
    // route's response. The session TTL is the worst-case backstop.
    await expect(revokeVoterTokensForUserOnParent('group', 5, 42)).resolves.toBeUndefined();
  });
});
