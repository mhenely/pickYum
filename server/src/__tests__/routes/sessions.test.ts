import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

jest.mock('../../sessions', () => ({
  createSession: jest.fn(),
  getSession:    jest.fn(),
  saveSession:   jest.fn().mockResolvedValue(undefined),
  registerClient:   jest.fn(),
  unregisterClient: jest.fn(),
  notifyClients:    jest.fn(),
}));

import * as sessions from '../../sessions';
import sessionsRouter from '../../routes/sessions';

const mockSessions = sessions as jest.Mocked<typeof sessions>;
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
  voters: {},
  submitted: [],
  status: 'lobby' as const,
  scores: null,
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

  it('records a vote from the host', async () => {
    const voting = { ...baseSession, status: 'voting' as const, voters: {} };
    mockSessions.getSession.mockResolvedValue(voting);
    const res = await request(buildApp())
      .post('/api/sessions/sess-abc/vote')
      .send({ voterName: 'alice', votes: { '1': true, '2': false } });
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
