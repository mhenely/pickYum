import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { DeepMockProxy } from 'jest-mock-extended';

jest.mock('../../lib/prisma');

import prisma from '../../lib/prisma';
import socialRouter from '../../routes/social';

const mockPrisma = prisma as unknown as DeepMockProxy<PrismaClient>;
const SECRET = process.env.JWT_SECRET!;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/social', socialRouter);
  return app;
}

const authCookie = (userId = 1) => `token=${jwt.sign({ userId }, SECRET)}`;

describe('GET /api/social/search', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/social/search?q=alice');
    expect(res.status).toBe(401);
  });

  it('returns empty array for an empty or missing query', async () => {
    const res = await request(buildApp())
      .get('/api/social/search?q=')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
  });

  it('returns users with relationship context for a matching query', async () => {
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
      { id: 2, username: 'bob', avatarUrl: null },
    ]);
    (mockPrisma.follow.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.friendRequest.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(buildApp())
      .get('/api/social/search?q=bob')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].username).toBe('bob');
    expect(res.body.users[0].isFollowing).toBe(false);
    expect(res.body.users[0].friendStatus).toBe('none');
  });

  it('marks a user as isFollowing when a Follow record exists', async () => {
    (mockPrisma.user.findMany as jest.Mock).mockResolvedValue([
      { id: 2, username: 'bob', avatarUrl: null },
    ]);
    (mockPrisma.follow.findMany as jest.Mock).mockResolvedValue([
      { followerId: 1, followingId: 2 },
    ]);
    (mockPrisma.friendRequest.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(buildApp())
      .get('/api/social/search?q=bob')
      .set('Cookie', authCookie(1));

    expect(res.status).toBe(200);
    expect(res.body.users[0].isFollowing).toBe(true);
  });
});

describe('GET /api/social/followers', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/social/followers');
    expect(res.status).toBe(401);
  });

  it('returns the list of followers', async () => {
    (mockPrisma.follow.findMany as jest.Mock).mockResolvedValue([
      { follower: { id: 2, username: 'bob', avatarUrl: null } },
    ]);

    const res = await request(buildApp())
      .get('/api/social/followers')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.followers).toHaveLength(1);
    expect(res.body.followers[0].username).toBe('bob');
  });
});

describe('GET /api/social/following', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/social/following');
    expect(res.status).toBe(401);
  });

  it('returns the list of users being followed', async () => {
    (mockPrisma.follow.findMany as jest.Mock).mockResolvedValue([
      { following: { id: 3, username: 'carol', avatarUrl: null } },
    ]);

    const res = await request(buildApp())
      .get('/api/social/following')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.following).toHaveLength(1);
    expect(res.body.following[0].username).toBe('carol');
  });
});

describe('GET /api/social/friends', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/social/friends');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/social/friend-requests/incoming', () => {
  it('returns 401 without auth', async () => {
    const res = await request(buildApp()).get('/api/social/friend-requests/incoming');
    expect(res.status).toBe(401);
  });
});
