// PATCH /api/users/me tests — covers the email/password change flow
// including the `currentPassword` re-authentication gate, the
// notification-to-old-address on password change, and the verification-
// email re-send on email change.
//
// Lives in its own file (separate from the larger users.test.ts) so the
// extra mocks needed here — bcrypt, email, emailTokens — don't bleed into
// the 80+ unrelated user-route tests in the main file. Each test
// resolves the supertest call against a fresh Express app mounting just
// the users router; the route's authentication is enforced by the
// requireAuth middleware inside that router.

import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { DeepMockProxy } from 'jest-mock-extended';

jest.mock('../../lib/prisma');

// bcrypt is mocked uniformly across the suite — `compare` is the only
// integration point for the currentPassword gate, and `hash` is asserted
// against the new password value when the change goes through.
jest.mock('bcryptjs', () => ({
  hash:    jest.fn().mockResolvedValue('$2a$12$newhashed'),
  compare: jest.fn(),
}));

// emailTokens — the route issues a verification token on email change and
// a password-reset token on password change (for the "if this wasn't you,
// reset" link in the notification). Mocking the boundary keeps Prisma
// emailToken interactions out of these tests; the token mechanics have
// their own dedicated test file.
jest.mock('../../lib/emailTokens', () => ({
  issueToken:   jest.fn().mockResolvedValue('raw-token'),
  consumeToken: jest.fn(),
  peekToken:    jest.fn(),
}));

// Email module — sendEmail is a jest.fn so each test can assert which
// template / which recipient was used. Templates are pass-through stubs
// because the real markup is exercised in email.test.ts.
jest.mock('../../lib/email', () => ({
  sendEmail:                jest.fn().mockResolvedValue(true),
  verifyEmailTemplate:      (url: string) => ({ subject: 'verify', html: url, text: url }),
  passwordResetTemplate:    (url: string) => ({ subject: 'reset',  html: url, text: url }),
  passwordChangedTemplate:  (url: string) => ({ subject: 'changed', html: url, text: url }),
  isEmailConfigured:        () => true,
}));

import prisma from '../../lib/prisma';
import usersRouter from '../../routes/users';
import bcrypt from 'bcryptjs';
import { sendEmail } from '../../lib/email';
import { issueToken } from '../../lib/emailTokens';

const mockPrisma  = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockBcrypt  = bcrypt as jest.Mocked<typeof bcrypt>;
const mockSend    = sendEmail as jest.Mock;
const mockIssue   = issueToken as jest.Mock;
const SECRET      = process.env.JWT_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/users', usersRouter);
  return app;
}

const authCookie = (userId = 1) => `token=${jwt.sign({ userId }, SECRET)}`;

// Stub identity row returned by the pre-update findUnique. Tests that
// need a specific email/username/passwordHash override the relevant
// fields per case.
const stubIdentity = {
  passwordHash: '$2a$12$existing',
  email:        'alice@example.com',
  username:     'alice',
};

beforeEach(() => {
  // Default: the pre-update identity lookup resolves to a real account
  // with a password set, and bcrypt.compare returns true (correct current
  // password). Tests override per case.
  (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue(stubIdentity);
  (mockPrisma.user.update     as jest.Mock).mockResolvedValue({
    id: 1, email: 'alice@example.com', username: 'alice',
  });
  (mockBcrypt.compare as jest.Mock).mockResolvedValue(true);
});

describe('PATCH /api/users/me — auth and validation', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).patch('/api/users/me').send({ username: 'newname' });
    expect(res.status).toBe(401);
  });

  it('returns 400 for oversized email (>254 chars)', async () => {
    const longEmail = `${'a'.repeat(255)}@example.com`;
    const res = await request(buildApp())
      .patch('/api/users/me').set('Cookie', authCookie())
      .send({ username: 'ok', email: longEmail, currentPassword: 'right' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email must be/i);
  });

  it('returns 400 for empty / oversized username', async () => {
    const empty = await request(buildApp())
      .patch('/api/users/me').set('Cookie', authCookie())
      .send({ username: '' });
    expect(empty.status).toBe(400);

    const long = await request(buildApp())
      .patch('/api/users/me').set('Cookie', authCookie())
      .send({ username: 'a'.repeat(100) });
    expect(long.status).toBe(400);
  });
});

describe('PATCH /api/users/me — username-only change (not sensitive)', () => {
  it('updates without requiring currentPassword', async () => {
    const res = await request(buildApp())
      .patch('/api/users/me').set('Cookie', authCookie())
      .send({ username: 'newname' });

    expect(res.status).toBe(200);
    // The route MUST NOT bcrypt-compare or issue any email here — a
    // username change is public info and re-prompting for password is
    // friction with no security benefit. Regression guard: bcrypt + email
    // mock-call counts both stay zero.
    expect(mockBcrypt.compare).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ username: 'newname' }) }),
    );
  });

  it('returns 409 with a username-specific message on P2002 collision', async () => {
    (mockPrisma.user.update as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002', meta: { target: ['username'] } }),
    );

    const res = await request(buildApp())
      .patch('/api/users/me').set('Cookie', authCookie())
      .send({ username: 'taken' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/username/i);
  });
});

describe('PATCH /api/users/me — sensitive changes require currentPassword', () => {
  it('returns 400 when changing email without currentPassword', async () => {
    const res = await request(buildApp())
      .patch('/api/users/me').set('Cookie', authCookie())
      .send({ email: 'new@example.com' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/currentPassword/i);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('returns 400 when changing password without currentPassword', async () => {
    const res = await request(buildApp())
      .patch('/api/users/me').set('Cookie', authCookie())
      .send({ password: 'newpassword123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/currentPassword/i);
  });

  it('returns 401 when currentPassword is wrong (bcrypt.compare false)', async () => {
    (mockBcrypt.compare as jest.Mock).mockResolvedValue(false);

    const res = await request(buildApp())
      .patch('/api/users/me').set('Cookie', authCookie())
      .send({ password: 'newpassword123', currentPassword: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/incorrect/i);
    // Critical: the update + side effects must not run when re-auth fails.
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 400 when account has no password (OAuth-only) — guides to reset flow', async () => {
    (mockPrisma.user.findUnique as jest.Mock).mockResolvedValue({
      ...stubIdentity, passwordHash: null,
    });

    const res = await request(buildApp())
      .patch('/api/users/me').set('Cookie', authCookie())
      .send({ email: 'new@example.com', currentPassword: 'doesntmatter' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reset/i);
    expect(mockBcrypt.compare).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/users/me — password change side effects', () => {
  it('runs validatePassword (rejects a weak new password) before updating', async () => {
    const res = await request(buildApp())
      .patch('/api/users/me').set('Cookie', authCookie())
      .send({ password: 'short', currentPassword: 'right' });

    expect(res.status).toBe(400);
    // The hash + update + notification-email must not fire when the new
    // password fails validation — otherwise an attacker who has a session
    // could weaken the password before exfiltrating it.
    expect(mockBcrypt.hash).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects a new password that contains the user identity (email)', async () => {
    // The identity context (email + username) flows from findUnique into
    // validatePassword, so a password containing the email local-part is
    // rejected even though it would clear the base length/letter+digit
    // rule. This is the integration that makes the strength gate useful
    // for change-password (vs. just registration).
    const res = await request(buildApp())
      .patch('/api/users/me').set('Cookie', authCookie())
      .send({ password: 'alicePower9', currentPassword: 'right' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email or username/i);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('hashes + updates the password and dispatches a notification to the OLD email', async () => {
    const res = await request(buildApp())
      .patch('/api/users/me').set('Cookie', authCookie())
      .send({ password: 'WinterStorm2026', currentPassword: 'right' });

    expect(res.status).toBe(200);
    expect(mockBcrypt.hash).toHaveBeenCalledWith('WinterStorm2026', 12);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ passwordHash: '$2a$12$newhashed' }),
      }),
    );

    // The notification fires async (the route returns immediately and
    // pushes to a fire-and-forget IIFE). Flush microtasks so we can
    // assert the side effects.
    await new Promise((r) => setImmediate(r));

    // Token issued for the reset link in the notification body
    expect(mockIssue).toHaveBeenCalledWith(1, 'PASSWORD_RESET');
    // Email goes to the OLD address (`stubIdentity.email`), not the
    // updated one — that's the whole point of the warning. A future
    // refactor that accidentally swapped to user.email post-update would
    // tell the attacker about their own change.
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].to).toBe(stubIdentity.email);
    expect(mockSend.mock.calls[0][0].subject).toBe('changed');
  });
});

describe('PATCH /api/users/me — email change side effects', () => {
  it('flips emailVerified to false and dispatches a verify email', async () => {
    (mockPrisma.user.update as jest.Mock).mockResolvedValue({
      id: 1, email: 'new@example.com', username: 'alice',
    });

    const res = await request(buildApp())
      .patch('/api/users/me').set('Cookie', authCookie())
      .send({ email: 'new@example.com', currentPassword: 'right' });

    expect(res.status).toBe(200);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'new@example.com',
          emailVerified: false,
          emailVerifiedAt: null,
        }),
      }),
    );

    // Async verify-email send after the response — flush microtasks.
    await new Promise((r) => setImmediate(r));
    expect(mockIssue).toHaveBeenCalledWith(1, 'VERIFY_EMAIL');
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'new@example.com', subject: 'verify' }),
    );
  });

  it('returns 409 with an email-specific message on P2002 collision', async () => {
    (mockPrisma.user.update as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002', meta: { target: ['email'] } }),
    );

    const res = await request(buildApp())
      .patch('/api/users/me').set('Cookie', authCookie())
      .send({ email: 'taken@example.com', currentPassword: 'right' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/email/i);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
