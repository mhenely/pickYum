import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import passport from 'passport';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { DeepMockProxy } from 'jest-mock-extended';

jest.mock('../../lib/prisma');
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('$2a$12$hashed'),
  compare: jest.fn(),
}));

import prisma from '../../lib/prisma';
import authRouter from '../../routes/auth';
import bcrypt from 'bcryptjs';

const mockPrisma = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;
const SECRET = process.env.JWT_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(passport.initialize());
  app.use('/api/auth', authRouter);
  return app;
}

const fakeUser = {
  id: 1,
  email: 'alice@example.com',
  username: 'alice',
  passwordHash: '$2a$12$hashed',
  flipCount: 0,
  avatarUrl: null,
  // Failed-login lockout columns (default safe values match the
  // migration's NOT NULL DEFAULT 0 + NULL respectively).
  failedLoginCount: 0,
  failedLoginLockedUntil: null,
  createdAt: new Date(),
};

describe('POST /api/auth/register', () => {
  beforeEach(() => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPrisma.user.create as jest.Mock).mockResolvedValue(fakeUser);
  });

  it('creates a user and returns 201 with a token cookie', async () => {
    const res = await request(buildApp())
      .post('/api/auth/register')
      .send({ email: 'alice@example.com', username: 'alice', password: 'secret123' });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('alice@example.com');
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(buildApp())
      .post('/api/auth/register')
      .send({ email: 'alice@example.com' });

    expect(res.status).toBe(400);
  });

  // The register route no longer pre-checks uniqueness — it relies on the
  // DB's unique constraint and translates P2002 to 409 with the matching
  // field. These tests now simulate the violation by mocking `user.create`
  // to throw the typed Prisma error.
  const p2002 = (target: string) =>
    Object.assign(new Error('Unique constraint violation'), { code: 'P2002', meta: { target: [target] } });

  it('returns 409 when email is already taken', async () => {
    (mockPrisma.user.create as jest.Mock).mockRejectedValue(p2002('email'));

    const res = await request(buildApp())
      .post('/api/auth/register')
      .send({ email: 'alice@example.com', username: 'alice', password: 'secret123' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/email/i);
  });

  it('returns 409 when username is already taken', async () => {
    (mockPrisma.user.create as jest.Mock).mockRejectedValue(p2002('username'));

    const res = await request(buildApp())
      .post('/api/auth/register')
      .send({ email: 'new@example.com', username: 'alice', password: 'secret123' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/username/i);
  });

  it('returns 409 when username differs only in case', async () => {
    // citext catches the case-only difference at the DB layer; same P2002 path.
    (mockPrisma.user.create as jest.Mock).mockRejectedValue(p2002('username'));

    const res = await request(buildApp())
      .post('/api/auth/register')
      .send({ email: 'new@example.com', username: 'ALICE', password: 'secret123' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/username/i);
  });
});

describe('POST /api/auth/login', () => {
  // Login looks up the email case-insensitively via findFirst (not findUnique)
  // so users can sign in with any capitalization of their registered address.
  beforeEach(() => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(fakeUser);
  });

  it('returns 200 with user and token cookie on valid credentials', async () => {
    (mockBcrypt.compare as jest.Mock).mockResolvedValue(true);

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'secret123' });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('alice@example.com');
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('returns 401 when password is wrong', async () => {
    (mockBcrypt.compare as jest.Mock).mockResolvedValue(false);

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'wrong' });

    expect(res.status).toBe(401);
  });

  it('returns 401 when email is not found', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'pass' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when fields are missing', async () => {
    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'alice@example.com' });

    expect(res.status).toBe(400);
  });

  it('returns generic 401 when account has no password (OAuth-only) — does NOT reveal OAuth status', async () => {
    // Anti-enumeration: the response for an OAuth-only account must look
    // identical to "wrong password" and "no such user". Otherwise the body
    // text alone gives an attacker oracle access to "does an account exist
    // for this email AND does it have a password set?".
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ ...fakeUser, passwordHash: null });

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'anything' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid email or password/i);
    expect(res.body.error).not.toMatch(/social|google|facebook|oauth/i);
  });

  // ── Per-account lockout ──────────────────────────────────────
  // Tests the credential-stuffing defense: after N consecutive failures,
  // the account is locked for a window regardless of correct password
  // OR source IP. Locked-out attempts must still match the timing and
  // response shape of normal wrong-password (anti-enumeration).

  it('increments failedLoginCount on a wrong password', async () => {
    (mockBcrypt.compare as jest.Mock).mockResolvedValue(false);

    await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'wrong' });

    const updateCalls = (mockPrisma.user.update as jest.Mock).mock.calls;
    // The route writes failedLoginCount on failure. Find that update.
    const failCall = updateCalls.find((c) => 'failedLoginCount' in (c[0]?.data ?? {}));
    expect(failCall).toBeDefined();
    expect(failCall![0].data.failedLoginCount).toBe(1);
    // Below the lockout threshold — lockedUntil should NOT be set.
    expect(failCall![0].data.failedLoginLockedUntil).toBeNull();
  });

  it('locks the account once failedLoginCount reaches the threshold', async () => {
    (mockBcrypt.compare as jest.Mock).mockResolvedValue(false);
    // Threshold is 8 — seed the user at count=7 so the next failure trips it.
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ ...fakeUser, failedLoginCount: 7 });

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'wrong' });

    expect(res.status).toBe(401);
    const updateCalls = (mockPrisma.user.update as jest.Mock).mock.calls;
    const lockCall = updateCalls.find((c) => 'failedLoginLockedUntil' in (c[0]?.data ?? {}) && c[0].data.failedLoginLockedUntil instanceof Date);
    expect(lockCall).toBeDefined();
    expect(lockCall![0].data.failedLoginCount).toBe(8);
  });

  it('refuses login when the account is currently locked, even with the correct password', async () => {
    // Correct password (bcrypt returns true) — should STILL be rejected
    // because the lockout window is active. This is the actual defense.
    (mockBcrypt.compare as jest.Mock).mockResolvedValue(true);
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({
      ...fakeUser,
      failedLoginCount: 8,
      failedLoginLockedUntil: new Date(Date.now() + 10 * 60_000), // locked for 10 more min
    });

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'secret123' });

    expect(res.status).toBe(401);
    // Error message identical to other 401 paths — anti-enumeration.
    expect(res.body.error).toMatch(/invalid email or password/i);
  });

  it('resets failedLoginCount on a successful login', async () => {
    (mockBcrypt.compare as jest.Mock).mockResolvedValue(true);
    // User had a few prior failures but isn't locked — successful login
    // should clear the counter.
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ ...fakeUser, failedLoginCount: 3 });

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'secret123' });

    expect(res.status).toBe(200);
    const updateCalls = (mockPrisma.user.update as jest.Mock).mock.calls;
    const resetCall = updateCalls.find((c) => c[0]?.data?.failedLoginCount === 0);
    expect(resetCall).toBeDefined();
    expect(resetCall![0].data.failedLoginLockedUntil).toBeNull();
  });

  it('skips the reset write when the counter is already 0 (hot-path optimization)', async () => {
    (mockBcrypt.compare as jest.Mock).mockResolvedValue(true);
    // Fresh user — count=0, no lockout. The route should NOT write a
    // pointless "set count to 0" update on every successful login.
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(fakeUser);

    await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'secret123' });

    const updateCalls = (mockPrisma.user.update as jest.Mock).mock.calls;
    const resetCall = updateCalls.find((c) => 'failedLoginCount' in (c[0]?.data ?? {}));
    expect(resetCall).toBeUndefined();
  });
});

describe('POST /api/auth/logout', () => {
  it('returns 200 and clears the token cookie', async () => {
    const res = await request(buildApp()).post('/api/auth/logout');
    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect(cookies?.some((c) => c.startsWith('token=;') || c.includes('Expires=Thu, 01 Jan 1970'))).toBe(true);
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(buildApp()).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns 200 with user data when authenticated', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(fakeUser);
    const token = jwt.sign({ userId: 1 }, SECRET);

    const res = await request(buildApp())
      .get('/api/auth/me')
      .set('Cookie', `token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('alice@example.com');
  });

  it('returns 404 when user does not exist in db', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    const token = jwt.sign({ userId: 999 }, SECRET);

    const res = await request(buildApp())
      .get('/api/auth/me')
      .set('Cookie', `token=${token}`);

    expect(res.status).toBe(404);
  });
});
