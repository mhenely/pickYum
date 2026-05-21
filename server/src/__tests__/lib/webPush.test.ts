// Tests for the web-push dispatch helper. We mock the `web-push`
// package + prisma so tests stay deterministic — the real network
// fan-out is the upstream lib's responsibility.

// Mock web-push before any imports — the module reads VAPID env vars
// at import time and calls setVapidDetails, which would throw on
// invalid keys. We sub in a controllable mock instead.
const mockSendNotification = jest.fn();
const mockSetVapidDetails  = jest.fn();
jest.mock('web-push', () => ({
  __esModule: true,
  default: {
    sendNotification: mockSendNotification,
    setVapidDetails:  mockSetVapidDetails,
  },
  setVapidDetails:    mockSetVapidDetails,
  sendNotification:   mockSendNotification,
}));

// Hoisted prisma mock object — referenced from the jest.mock factory
// (which jest hoists to the top of the file) and re-bound on every
// re-import via the same module path. Because we use `jest.resetModules()`
// in some tests to force a fresh webPush import, we need the prisma
// mock factory to return the SAME object each time so the assertions
// see the same jest.fn() instances.
const prismaMock = {
  pushSubscription: { findMany: jest.fn(), deleteMany: jest.fn() },
};
jest.mock('../../lib/prisma', () => ({
  __esModule: true,
  default: prismaMock,
}));

beforeEach(() => {
  jest.clearAllMocks();
  // The deleteMany cleanup is fire-and-forget; provide a default
  // resolved value so any test path that triggers it doesn't surface
  // an unhandled rejection.
  prismaMock.pushSubscription.deleteMany.mockResolvedValue({ count: 0 });
});

// All these tests run with VAPID env vars present (push enabled).
// The "push disabled" code path is checked separately by re-importing
// the module with env vars stripped.
describe('sendPushToUser (VAPID configured)', () => {
  beforeAll(() => {
    process.env.VAPID_PUBLIC_KEY  = 'public-test-key';
    process.env.VAPID_PRIVATE_KEY = 'private-test-key';
    process.env.VAPID_SUBJECT     = 'mailto:test@example.com';
  });

  // Force re-import per test so VAPID env changes between describe
  // blocks take effect on the next dynamic import.
  beforeEach(() => jest.resetModules());

  it('returns 0 when the user has no subscriptions', async () => {
    prismaMock.pushSubscription.findMany.mockResolvedValue([]);
    const { sendPushToUser } = await import('../../lib/webPush');
    const delivered = await sendPushToUser(42, { title: 't', body: 'b' });
    expect(delivered).toBe(0);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('fans out to every subscription and returns success count', async () => {
    prismaMock.pushSubscription.findMany.mockResolvedValue([
      { id: 1, endpoint: 'https://push.example/a', p256dh: 'pa', auth: 'aa' },
      { id: 2, endpoint: 'https://push.example/b', p256dh: 'pb', auth: 'ab' },
    ]);
    mockSendNotification.mockResolvedValue(undefined);

    const { sendPushToUser } = await import('../../lib/webPush');
    const delivered = await sendPushToUser(42, { title: 'Hi', body: 'msg', url: '/socials' });

    expect(delivered).toBe(2);
    expect(mockSendNotification).toHaveBeenCalledTimes(2);
    // Payload is JSON-stringified — service worker decodes on the other side.
    expect(mockSendNotification.mock.calls[0][1]).toBe(JSON.stringify({ title: 'Hi', body: 'msg', url: '/socials' }));
    // Each call gets the subscription's endpoint + keys in the W3C shape.
    expect(mockSendNotification.mock.calls[0][0]).toEqual({
      endpoint: 'https://push.example/a',
      keys: { p256dh: 'pa', auth: 'aa' },
    });
  });

  it('deletes 404/410 subscriptions and continues with the rest', async () => {
    prismaMock.pushSubscription.findMany.mockResolvedValue([
      { id: 1, endpoint: 'https://push.example/a', p256dh: 'pa', auth: 'aa' }, // 410 GONE
      { id: 2, endpoint: 'https://push.example/b', p256dh: 'pb', auth: 'ab' }, // OK
      { id: 3, endpoint: 'https://push.example/c', p256dh: 'pc', auth: 'ac' }, // 404 NOT FOUND
    ]);
    mockSendNotification
      .mockRejectedValueOnce({ statusCode: 410, message: 'Gone' })
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce({ statusCode: 404, message: 'Not Found' });

    const { sendPushToUser } = await import('../../lib/webPush');
    const delivered = await sendPushToUser(42, { title: 't', body: 'b' });
    expect(delivered).toBe(1);

    // Wait for the fire-and-forget cleanup promise to resolve before
    // asserting on it. The handler doesn't await it (so the cleanup
    // can't slow down the dispatch path), but tests need to flush.
    await new Promise((r) => setImmediate(r));
    expect(prismaMock.pushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [1, 3] } },
    });
  });

  it('does NOT delete transient failures (network, 5xx)', async () => {
    prismaMock.pushSubscription.findMany.mockResolvedValue([
      { id: 1, endpoint: 'https://push.example/a', p256dh: 'pa', auth: 'aa' },
    ]);
    mockSendNotification.mockRejectedValueOnce({ statusCode: 503, message: 'Bad Gateway' });

    const { sendPushToUser } = await import('../../lib/webPush');
    const delivered = await sendPushToUser(42, { title: 't', body: 'b' });
    expect(delivered).toBe(0);
    await new Promise((r) => setImmediate(r));
    // Transient failure → subscription stays so the next dispatch
    // retries. Otherwise a single push service outage would wipe
    // every subscription in the database.
    expect(prismaMock.pushSubscription.deleteMany).not.toHaveBeenCalled();
  });
});

describe('sendPushToUser (VAPID not configured)', () => {
  beforeAll(() => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });

  beforeEach(() => jest.resetModules());

  it('is a no-op and returns 0 without consulting the DB', async () => {
    const { sendPushToUser, isPushEnabled } = await import('../../lib/webPush');
    expect(isPushEnabled()).toBe(false);

    const delivered = await sendPushToUser(42, { title: 't', body: 'b' });
    expect(delivered).toBe(0);
    // No DB lookup — degraded mode short-circuits before any I/O.
    expect(prismaMock.pushSubscription.findMany).not.toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});
