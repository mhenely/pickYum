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

// emailTokens hides crypto + bcrypt + Prisma round-trips behind a tidy
// pair of issue/consume functions. For the reset-password / verify-email
// route tests we mock the boundary so each test can declare exactly what
// consumeToken returns — the actual token mechanics get their own
// dedicated test file. Without this, every reset/verify case would also
// have to mock prisma.emailToken.findUnique, bcrypt.compare, and the
// updateMany consume step.
jest.mock('../../lib/emailTokens', () => ({
  issueToken:   jest.fn(),
  consumeToken: jest.fn(),
}));

// audit + email writes are fire-and-forget side effects on the auth-recovery
// paths. Stub them so tests don't pull in the real audit-log write (which
// would try to hit the (mocked) prisma) or attempt a Resend HTTP call.
jest.mock('../../lib/audit', () => ({ audit: jest.fn() }));
jest.mock('../../lib/email', () => ({
  sendEmail:               jest.fn().mockResolvedValue(true),
  verifyEmailTemplate:     () => ({ subject: 's', html: 'h', text: 't' }),
  passwordResetTemplate:   () => ({ subject: 's', html: 'h', text: 't' }),
  isEmailConfigured:       () => true,
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

// ──────────────────────────────────────────────────────────────
// Account recovery
// ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tokensMock = require('../../lib/emailTokens') as {
  issueToken:   jest.Mock;
  consumeToken: jest.Mock;
};

describe('POST /api/auth/verify-email', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockPrisma.user.update as jest.Mock).mockResolvedValue({ id: 1, emailVerified: true });
  });

  it('flips emailVerified=true when the token resolves', async () => {
    tokensMock.consumeToken.mockResolvedValue(1);

    const res = await request(buildApp())
      .post('/api/auth/verify-email')
      .send({ token: 'a'.repeat(43) });

    expect(res.status).toBe(200);
    expect(tokensMock.consumeToken).toHaveBeenCalledWith('a'.repeat(43), 'VERIFY_EMAIL');
    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 1 },
      data: expect.objectContaining({ emailVerified: true }),
    }));
  });

  it('returns 400 with a generic message when the token is invalid/expired', async () => {
    tokensMock.consumeToken.mockResolvedValue(null);

    const res = await request(buildApp())
      .post('/api/auth/verify-email')
      .send({ token: 'expired-or-junk' });

    expect(res.status).toBe(400);
    // No leak about *why* the token failed — invalid / expired / consumed
    // all hit the same response so attackers can't probe for state.
    expect(res.body.error).toMatch(/invalid or expired/i);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('returns 400 when token is missing from the body', async () => {
    const res = await request(buildApp())
      .post('/api/auth/verify-email')
      .send({});

    expect(res.status).toBe(400);
    expect(tokensMock.consumeToken).not.toHaveBeenCalled();
  });

  it('does not flip emailVerified on a second submission of the same token', async () => {
    // First call: resolves user id; second call: consumeToken returns null
    // because the row's usedAt is set. Same endpoint behavior, just gated
    // by the consume helper's idempotency.
    tokensMock.consumeToken
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(null);

    const a = await request(buildApp())
      .post('/api/auth/verify-email')
      .send({ token: 't'.repeat(43) });
    const b = await request(buildApp())
      .post('/api/auth/verify-email')
      .send({ token: 't'.repeat(43) });

    expect(a.status).toBe(200);
    expect(b.status).toBe(400);
    // Only one user update — the second call short-circuits before reaching prisma.
    expect(mockPrisma.user.update).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/auth/reset-password', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockPrisma.user.update as jest.Mock).mockResolvedValue({ id: 1 });
    (mockBcrypt.hash as jest.Mock).mockResolvedValue('$2a$12$newhash');
  });

  it('hashes the new password, signs the user in, and audits the reset', async () => {
    tokensMock.consumeToken.mockResolvedValue(1);

    const res = await request(buildApp())
      .post('/api/auth/reset-password')
      .send({ token: 'a'.repeat(43), password: 'newpassword123' });

    expect(res.status).toBe(200);
    // Password was bcrypted at cost 12 (matches register/login parity).
    expect(mockBcrypt.hash).toHaveBeenCalledWith('newpassword123', 12);
    // User row received the new hash AND the failed-login lockout was cleared
    // (proving email control is at least as strong as proving the prior
    // password, so the lockout's purpose is served).
    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 1 },
      data: expect.objectContaining({
        passwordHash: '$2a$12$newhash',
        failedLoginCount: 0,
        failedLoginLockedUntil: null,
      }),
    }));
    // Session cookie issued so the user lands signed-in after reset.
    const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect(cookies?.some((c) => c.startsWith('token='))).toBe(true);
  });

  it('returns 400 when the token is invalid', async () => {
    tokensMock.consumeToken.mockResolvedValue(null);

    const res = await request(buildApp())
      .post('/api/auth/reset-password')
      .send({ token: 'bad', password: 'newpassword123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or expired/i);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects a reused token on the second submission', async () => {
    tokensMock.consumeToken
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(null);

    const a = await request(buildApp())
      .post('/api/auth/reset-password')
      .send({ token: 'x'.repeat(43), password: 'newpassword123' });
    const b = await request(buildApp())
      .post('/api/auth/reset-password')
      .send({ token: 'x'.repeat(43), password: 'differentpw456' });

    expect(a.status).toBe(200);
    expect(b.status).toBe(400);
    expect(mockPrisma.user.update).toHaveBeenCalledTimes(1);
  });

  it('rejects a weak password before consuming the token', async () => {
    const res = await request(buildApp())
      .post('/api/auth/reset-password')
      .send({ token: 'a'.repeat(43), password: 'short' });

    expect(res.status).toBe(400);
    // Password validation must run BEFORE consumeToken — otherwise a weak
    // password would burn the token and force the user to request another.
    expect(tokensMock.consumeToken).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('returns 400 when token is missing', async () => {
    const res = await request(buildApp())
      .post('/api/auth/reset-password')
      .send({ password: 'newpassword123' });

    expect(res.status).toBe(400);
    expect(tokensMock.consumeToken).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/forgot-password', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 + issues a token when the email matches an account with a password', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 1, email: 'alice@example.com', passwordHash: '$2a$12$existing',
    });
    tokensMock.issueToken.mockResolvedValue('raw-token-xyz');

    const res = await request(buildApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'alice@example.com' });

    expect(res.status).toBe(200);
    expect(tokensMock.issueToken).toHaveBeenCalledWith(1, 'PASSWORD_RESET');
  });

  it('returns 200 but does NOT issue a token for an unknown email (no enumeration)', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(buildApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'nope@example.com' });

    // Response shape is identical whether the email exists or not — this is
    // the load-bearing assertion. Account enumeration via response timing
    // is a separate concern handled by the rate limiter.
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if that email is registered/i);
    expect(tokensMock.issueToken).not.toHaveBeenCalled();
  });

  it('returns 200 but skips token issue for OAuth-only accounts (no passwordHash)', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 1, email: 'alice@example.com', passwordHash: null,
    });

    const res = await request(buildApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'alice@example.com' });

    expect(res.status).toBe(200);
    // OAuth-only users have no password to reset — issuing a token would
    // land them on a reset page that does nothing useful. Skipping the
    // issue (silently) maintains the no-enumeration contract.
    expect(tokensMock.issueToken).not.toHaveBeenCalled();
  });

  it('returns 400 when email is missing', async () => {
    const res = await request(buildApp())
      .post('/api/auth/forgot-password')
      .send({});
    expect(res.status).toBe(400);
  });
});
