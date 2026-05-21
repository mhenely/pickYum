import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { EventEmitter } from 'events';
import type { Request, Response } from 'express';

// Mock the SSE registry — we verify register/unregister are called rather
// than running real fan-out. The lib's own test covers the storage layer.
jest.mock('../../lib/userNotifications', () => ({
  registerUserClient:   jest.fn(),
  unregisterUserClient: jest.fn(),
}));

// Side-effect-free Redis mock so the import chain doesn't try to connect.
jest.mock('../../lib/redis', () => ({ __esModule: true, default: null }));

// Mock prisma for subscription endpoints — the SSE stream handler
// doesn't touch the DB, only the new /subscriptions endpoints do.
jest.mock('../../lib/prisma', () => ({
  __esModule: true,
  default: {
    pushSubscription: { upsert: jest.fn(), deleteMany: jest.fn() },
  },
}));

// Mock webPush so importing the routes file doesn't try to read
// VAPID env vars or initialize the web-push lib. Tests assert against
// these mock returns directly.
jest.mock('../../lib/webPush', () => ({
  getVapidPublicKey: jest.fn(() => 'test-public-key'),
  isPushEnabled:     jest.fn(() => true),
}));

import notificationsRouter from '../../routes/notifications';
import { registerUserClient, unregisterUserClient } from '../../lib/userNotifications';
import prisma from '../../lib/prisma';

const mockPrisma = prisma as unknown as {
  pushSubscription: { upsert: jest.Mock; deleteMany: jest.Mock };
};

const SECRET = process.env.JWT_SECRET!;
const authCookie = (userId = 1) => `token=${jwt.sign({ userId }, SECRET)}`;

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/notifications', notificationsRouter);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/notifications/stream — auth', () => {
  // Auth checks are short-circuit before the SSE handler runs, so supertest
  // handles them cleanly (the response ends with a status code, not a
  // long-lived stream).
  it('returns 401 with no auth cookie', async () => {
    const res = await request(buildApp()).get('/api/notifications/stream');
    expect(res.status).toBe(401);
    expect(registerUserClient).not.toHaveBeenCalled();
  });

  it('returns 401 with an invalid JWT', async () => {
    const res = await request(buildApp())
      .get('/api/notifications/stream')
      .set('Cookie', 'token=not-a-real-jwt');
    expect(res.status).toBe(401);
    expect(registerUserClient).not.toHaveBeenCalled();
  });

  it('returns 401 with a token signed by the wrong secret', async () => {
    const wrong = jwt.sign({ userId: 1 }, 'wrong-secret');
    const res = await request(buildApp())
      .get('/api/notifications/stream')
      .set('Cookie', `token=${wrong}`);
    expect(res.status).toBe(401);
  });
});

// For the SSE-specific behavior (headers, primer write, register, unregister)
// we drive the handler directly with a fake req/res. Supertest's long-lived
// stream handling is fragile and races with the `close` cleanup; the direct
// invocation lets us assert against deterministic state.
describe('GET /api/notifications/stream — handler behavior', () => {
  function getHandler() {
    // Pluck the /stream handler out of the router stack. Used to be
    // "first route layer" which broke when /vapid-key was added as a
    // public endpoint before the requireAuth gate — explicit path
    // match avoids future ordering issues.
    type Layer = { route?: { path?: string; stack: Array<{ handle: (req: Request, res: Response) => void }> } };
    const layers = (notificationsRouter as unknown as { stack: Layer[] }).stack;
    const streamLayer = layers.find((l) => l.route?.path === '/stream')!;
    return streamLayer.route!.stack[0].handle;
  }

  // Track every fake req we hand the handler so we can flush 'close' on
  // every one in afterEach. The handler starts a 25s heartbeat setInterval
  // that's only cleared in the close handler — if a test forgets to fire
  // 'close', the open interval keeps jest from exiting.
  const liveReqs: EventEmitter[] = [];

  function fakeReqRes(userId: number) {
    const req = new EventEmitter() as Request & EventEmitter;
    (req as unknown as { userId: number }).userId = userId;
    liveReqs.push(req);
    const written: string[] = [];
    const res = {
      setHeader:    jest.fn(),
      flushHeaders: jest.fn(),
      write:        jest.fn((chunk: string) => { written.push(chunk); return true; }),
      end:          jest.fn(),
    } as unknown as Response;
    return { req, res, written };
  }

  afterEach(() => {
    for (const r of liveReqs) r.emit('close');
    liveReqs.length = 0;
  });

  it('sets the SSE headers required to defeat proxy buffering', () => {
    const handler = getHandler();
    const { req, res } = fakeReqRes(7);

    handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type',    'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control',   'no-cache, no-transform');
    expect(res.setHeader).toHaveBeenCalledWith('Connection',      'keep-alive');
    // X-Accel-Buffering: no is the load-bearing header for nginx fronts —
    // without it, nginx buffers SSE writes until the connection closes.
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    expect(res.flushHeaders).toHaveBeenCalled();
  });

  it('writes a connection-primer comment so proxies do not idle-close', () => {
    const handler = getHandler();
    const { req, res, written } = fakeReqRes(7);

    handler(req, res);

    // Comment line (": ...") with double-newline terminator. Anything less
    // and EventSource buffers until the next data chunk lands.
    expect(written).toContain(': connected\n\n');
  });

  it('registers the user client immediately after the primer write', () => {
    const handler = getHandler();
    const { req, res } = fakeReqRes(42);

    handler(req, res);

    expect(registerUserClient).toHaveBeenCalledWith(42, res);
    // Register order matters — if it happened BEFORE primer write, a
    // publish that lands in the gap would write to a client that hasn't
    // yet received its primer (EventSource may discard).
    const primerOrder   = (res.write as jest.Mock).mock.invocationCallOrder[0];
    const registerOrder = (registerUserClient as jest.Mock).mock.invocationCallOrder[0];
    expect(primerOrder).toBeLessThan(registerOrder);
  });

  it('unregisters the user client when the request closes', () => {
    const handler = getHandler();
    const { req, res } = fakeReqRes(42);

    handler(req, res);
    expect(unregisterUserClient).not.toHaveBeenCalled();

    // Simulate the client disconnecting — express emits 'close' on req.
    (req as EventEmitter).emit('close');

    expect(unregisterUserClient).toHaveBeenCalledWith(42, res);
  });
});

// ── VAPID key endpoint ───────────────────────────────────────────

describe('GET /api/notifications/vapid-key', () => {
  it('returns the public key + enabled flag (publicly accessible)', async () => {
    // No auth cookie — vapid-key is intentionally open since the
    // public key is by definition public information, and the client
    // needs it before any subscribe handshake.
    const res = await request(buildApp()).get('/api/notifications/vapid-key');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ publicKey: 'test-public-key', enabled: true });
  });
});

// ── Subscribe / unsubscribe endpoints ────────────────────────────

describe('POST /api/notifications/subscriptions', () => {
  it('returns 401 with no auth cookie', async () => {
    const res = await request(buildApp())
      .post('/api/notifications/subscriptions')
      .send({ endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } });
    expect(res.status).toBe(401);
    expect(mockPrisma.pushSubscription.upsert).not.toHaveBeenCalled();
  });

  it('upserts the subscription keyed by endpoint', async () => {
    mockPrisma.pushSubscription.upsert.mockResolvedValue({});
    const res = await request(buildApp())
      .post('/api/notifications/subscriptions')
      .set('Cookie', authCookie(7))
      .send({
        endpoint:  'https://push.example/abc',
        keys:      { p256dh: 'public-key', auth: 'auth-secret' },
        userAgent: 'TestBrowser/1.0',
      });

    expect(res.status).toBe(204);
    expect(mockPrisma.pushSubscription.upsert).toHaveBeenCalledWith({
      where:  { endpoint: 'https://push.example/abc' },
      create: { userId: 7, endpoint: 'https://push.example/abc', p256dh: 'public-key', auth: 'auth-secret', userAgent: 'TestBrowser/1.0' },
      update: { userId: 7, p256dh: 'public-key', auth: 'auth-secret', userAgent: 'TestBrowser/1.0' },
    });
  });

  it('rejects an over-long endpoint (defense against payload abuse)', async () => {
    const res = await request(buildApp())
      .post('/api/notifications/subscriptions')
      .set('Cookie', authCookie(7))
      .send({ endpoint: 'x'.repeat(3000), keys: { p256dh: 'k', auth: 'a' } });
    expect(res.status).toBe(400);
    expect(mockPrisma.pushSubscription.upsert).not.toHaveBeenCalled();
  });

  it('rejects when keys are missing', async () => {
    const res = await request(buildApp())
      .post('/api/notifications/subscriptions')
      .set('Cookie', authCookie(7))
      .send({ endpoint: 'https://push.example/abc' });
    expect(res.status).toBe(400);
  });

  it('caps userAgent at 512 chars to prevent storage bloat', async () => {
    mockPrisma.pushSubscription.upsert.mockResolvedValue({});
    const longUa = 'x'.repeat(2000);
    await request(buildApp())
      .post('/api/notifications/subscriptions')
      .set('Cookie', authCookie(7))
      .send({ endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' }, userAgent: longUa });

    const call = mockPrisma.pushSubscription.upsert.mock.calls[0][0];
    expect(call.create.userAgent.length).toBe(512);
  });
});

describe('DELETE /api/notifications/subscriptions', () => {
  it('returns 401 with no auth cookie', async () => {
    const res = await request(buildApp())
      .delete('/api/notifications/subscriptions')
      .send({ endpoint: 'https://push.example/abc' });
    expect(res.status).toBe(401);
  });

  it('deletes only subscriptions belonging to the requester', async () => {
    mockPrisma.pushSubscription.deleteMany.mockResolvedValue({ count: 1 });
    const res = await request(buildApp())
      .delete('/api/notifications/subscriptions')
      .set('Cookie', authCookie(7))
      .send({ endpoint: 'https://push.example/abc' });
    expect(res.status).toBe(204);
    // The userId scope is the load-bearing part — without it, user A
    // could unsubscribe user B's device just by knowing the endpoint.
    expect(mockPrisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { endpoint: 'https://push.example/abc', userId: 7 },
    });
  });

  it('rejects missing endpoint', async () => {
    const res = await request(buildApp())
      .delete('/api/notifications/subscriptions')
      .set('Cookie', authCookie(7))
      .send({});
    expect(res.status).toBe(400);
  });
});
