import type { Response } from 'express';

// Mock the redis client BEFORE importing the module under test so the
// in-module `if (redis)` subscriber-setup branch sees our fake. We control
// `status` per-test to switch between the "publish to Redis" path and the
// "in-memory fallback" path.
const mockRedis = {
  status: 'ready' as 'ready' | 'connecting',
  publish: jest.fn(),
  duplicate: jest.fn(),
};

// Subscriber connection mock — userNotifications calls redis.duplicate()
// at module load when redis is present. The .connect() + .subscribe() + .on()
// chain has to resolve so the module doesn't blow up at import.
const mockSubscriber = {
  connect:   jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn().mockResolvedValue(undefined),
  on:        jest.fn(),
};
mockRedis.duplicate.mockReturnValue(mockSubscriber);

jest.mock('../../lib/redis', () => ({
  __esModule: true,
  default: mockRedis,
}));

jest.mock('../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  notifyUser, registerUserClient, unregisterUserClient, closeAllUserClients,
} from '../../lib/userNotifications';

// Snapshot the module-load side effects after the async chain (connect →
// subscribe → on) settles. The setup is `connect().then(subscribe().then(...))`
// so a synchronous snapshot misses everything inside the .then callbacks.
// beforeAll runs once before the first beforeEach, so the snapshot survives
// the per-test `clearAllMocks()`.
const moduleLoadCalls: {
  duplicate?: number;
  connect?: number;
  subscribeArgs?: unknown[];
  onArgs?: unknown[];
} = {};

beforeAll(async () => {
  // Flush the microtask queue twice — connect.then → subscribe.then chains
  // two levels deep, so a single tick only resolves the first link.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  moduleLoadCalls.duplicate     = mockRedis.duplicate.mock.calls.length;
  moduleLoadCalls.connect       = mockSubscriber.connect.mock.calls.length;
  moduleLoadCalls.subscribeArgs = mockSubscriber.subscribe.mock.calls.map((c) => c[0]);
  moduleLoadCalls.onArgs        = mockSubscriber.on.mock.calls.map((c) => [c[0], typeof c[1]]);
});

// Mock Response just enough to capture writes + end() calls. We're not
// exercising the full express Response surface — just `write` + `end`.
function fakeRes() {
  const writes: string[] = [];
  let ended = false;
  const res = {
    write: jest.fn((chunk: string) => { writes.push(chunk); return true; }),
    end:   jest.fn(() => { ended = true; }),
  } as unknown as Response;
  return { res, writes, isEnded: () => ended };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.status = 'ready';
  mockRedis.publish.mockResolvedValue(1);
  // Wipe any clients leaked from prior tests by closing through the public
  // helper — keeps the in-module Map clean without exposing it.
  closeAllUserClients();
});

describe('notifyUser (Redis publish path)', () => {
  it('publishes a refresh frame to the user-notifications channel when Redis is ready', () => {
    notifyUser(42, 'group-invite');

    expect(mockRedis.publish).toHaveBeenCalledTimes(1);
    const [channel, raw] = mockRedis.publish.mock.calls[0];
    expect(channel).toBe('pickyum:user-notifications');

    // The payload shape is `{ userId, frame }` — the frame is the literal
    // SSE bytes a subscriber will write. Verify both halves.
    const msg = JSON.parse(raw);
    expect(msg.userId).toBe(42);
    expect(msg.frame).toContain('event: refresh');
    expect(msg.frame).toContain('"reason":"group-invite"');
  });

  it('does NOT also write to local clients on the publish path (avoids double-delivery)', () => {
    const { res, writes } = fakeRes();
    registerUserClient(42, res);

    notifyUser(42, 'trip-invite');

    // The Redis subscriber (this same instance) will receive the publish
    // and route to local clients via the on('message') handler — writing
    // locally too would double-fire. The current implementation only
    // writes locally when Redis isn't ready OR the publish rejects.
    expect(writes).toHaveLength(0);
  });

  it('falls back to local writes when Redis.publish rejects', async () => {
    mockRedis.publish.mockRejectedValueOnce(new Error('connection reset'));
    const { res, writes } = fakeRes();
    registerUserClient(42, res);

    notifyUser(42, 'friend-request');
    // notifyUser is fire-and-forget; flush the microtask queue so the
    // .catch handler runs and the fallback write completes.
    await new Promise((r) => setImmediate(r));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"reason":"friend-request"');
  });
});

describe('notifyUser (in-memory fallback path)', () => {
  it('writes directly to local clients when Redis is not ready', () => {
    mockRedis.status = 'connecting';
    const { res, writes } = fakeRes();
    registerUserClient(42, res);

    notifyUser(42, 'meal-participant');

    expect(mockRedis.publish).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('event: refresh');
    expect(writes[0]).toContain('"reason":"meal-participant"');
  });

  it('delivers the frame to every connection registered for the user (multi-tab)', () => {
    mockRedis.status = 'connecting';
    const a = fakeRes(); const b = fakeRes();
    registerUserClient(42, a.res);
    registerUserClient(42, b.res);

    notifyUser(42, 'group-invite');

    // Two tabs = two writes, identical content. Single source of truth for
    // a user's notifications regardless of how many surfaces they have open.
    expect(a.writes).toHaveLength(1);
    expect(b.writes).toHaveLength(1);
    expect(a.writes[0]).toEqual(b.writes[0]);
  });

  it('does not deliver to other users', () => {
    mockRedis.status = 'connecting';
    const target = fakeRes();
    const other  = fakeRes();
    registerUserClient(42, target.res);
    registerUserClient(99, other.res);

    notifyUser(42, 'group-invite');

    expect(target.writes).toHaveLength(1);
    expect(other.writes).toHaveLength(0);
  });

  it('is a no-op when the user has no connected clients (and not ready)', () => {
    mockRedis.status = 'connecting';
    // No registerUserClient call at all — simulates a user who is offline
    // when the notification fires. We expect zero writes and zero throws.
    expect(() => notifyUser(42, 'group-invite')).not.toThrow();
  });

  it('survives a client whose write() throws (treat as already-disconnected)', () => {
    mockRedis.status = 'connecting';
    const live = fakeRes();
    const dead = fakeRes();
    (dead.res.write as jest.Mock).mockImplementation(() => { throw new Error('socket closed'); });
    registerUserClient(42, live.res);
    registerUserClient(42, dead.res);

    // The dead-client throw must not prevent the live client from receiving.
    expect(() => notifyUser(42, 'group-invite')).not.toThrow();
    expect(live.writes).toHaveLength(1);
  });
});

describe('client lifecycle', () => {
  it('unregisterUserClient removes the specific connection without affecting siblings', () => {
    mockRedis.status = 'connecting';
    const a = fakeRes(); const b = fakeRes();
    registerUserClient(42, a.res);
    registerUserClient(42, b.res);

    unregisterUserClient(42, a.res);
    notifyUser(42, 'group-invite');

    // Only `b` should see the frame after `a` unregisters.
    expect(a.writes).toHaveLength(0);
    expect(b.writes).toHaveLength(1);
  });

  it('unregisterUserClient is a no-op for an unknown userId / connection (idempotent)', () => {
    const { res } = fakeRes();
    expect(() => unregisterUserClient(999, res)).not.toThrow();
  });

  it('closeAllUserClients writes a close event and end()s every connection', () => {
    mockRedis.status = 'connecting';
    const a = fakeRes(); const b = fakeRes();
    registerUserClient(42, a.res);
    registerUserClient(99, b.res);

    closeAllUserClients();

    expect(a.writes.some((w) => w.startsWith('event: close'))).toBe(true);
    expect(b.writes.some((w) => w.startsWith('event: close'))).toBe(true);
    expect(a.isEnded()).toBe(true);
    expect(b.isEnded()).toBe(true);

    // The registry is wiped — a subsequent notifyUser should be a no-op,
    // not deliver to the closed connections.
    a.writes.length = 0;
    notifyUser(42, 'group-invite');
    expect(a.writes).toHaveLength(0);
  });
});

describe('Redis subscriber setup', () => {
  it('duplicates the redis connection and subscribes to the user channel at module load', () => {
    // Asserts against the snapshot taken right after import (the actual
    // call mocks get cleared in beforeEach). Without these side effects,
    // a publish from another instance wouldn't reach this instance's
    // local clients — the whole multi-instance contract relies on it.
    expect(moduleLoadCalls.duplicate).toBe(1);
    expect(moduleLoadCalls.connect).toBeGreaterThan(0);
    expect(moduleLoadCalls.subscribeArgs).toContain('pickyum:user-notifications');
    expect(moduleLoadCalls.onArgs).toContainEqual(['message', 'function']);
  });
});

describe('reason coverage — each UserNotificationReason produces a valid frame', () => {
  // Sanity check that every reason in the union type round-trips through
  // notifyUser without throwing AND that the frame contains the reason
  // string. The map covers reasons added at different times — `list-shared`
  // is the newest and easy to forget when extending notifyUser; this
  // test would have caught a missed buildPushPayload case (which throws
  // a TypeScript exhaustiveness error at compile time, but a runtime
  // miss would silently drop the push).
  //
  // The SSE frame is asserted via the in-memory fallback path so we
  // don't need to JSON.parse a Redis publish payload per case.
  const REASONS = [
    'group-invite',
    'trip-invite',
    'meal-participant',
    'friend-request',
    'vote-result',
    'list-shared',
  ] as const;

  it.each(REASONS)('routes %s to the local SSE frame with the matching reason', (reason) => {
    mockRedis.status = 'connecting';
    const { res, writes } = fakeRes();
    registerUserClient(42, res);

    notifyUser(42, reason);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('event: refresh');
    expect(writes[0]).toContain(`"reason":"${reason}"`);
  });
});
