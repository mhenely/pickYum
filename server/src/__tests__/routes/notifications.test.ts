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

import notificationsRouter from '../../routes/notifications';
import { registerUserClient, unregisterUserClient } from '../../lib/userNotifications';

const SECRET = process.env.JWT_SECRET!;
const authCookie = (userId = 1) => `token=${jwt.sign({ userId }, SECRET)}`;

function buildApp() {
  const app = express();
  app.use(cookieParser());
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
    // The stream handler is the last layer registered on the sub-router.
    // We pluck it out by walking the router stack rather than re-exporting.
    type Layer = { route?: { stack: Array<{ handle: (req: Request, res: Response) => void }> } };
    const layers = (notificationsRouter as unknown as { stack: Layer[] }).stack;
    const streamLayer = layers.find((l) => l.route)!;
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
