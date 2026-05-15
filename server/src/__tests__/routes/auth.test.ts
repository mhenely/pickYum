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
