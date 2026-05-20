import request from 'supertest';
import express from 'express';
import { DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

jest.mock('../../lib/prisma');

// The Redis client is a default export — usually null in tests since
// REDIS_URL isn't set. We replace it with a configurable mock so each
// test can switch between "redis available + responding", "redis errors
// on ping", and "redis not configured".
const mockRedis = {
  ping:      jest.fn(),
  duplicate: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  })),
};
let redisExport: typeof mockRedis | null = mockRedis;
jest.mock('../../lib/redis', () => ({
  __esModule: true,
  get default() { return redisExport; },
}));

jest.mock('../../lib/email', () => ({
  isEmailConfigured: jest.fn().mockReturnValue(true),
}));

jest.mock('../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import prisma from '../../lib/prisma';
import healthRouter from '../../routes/health';
import { isEmailConfigured } from '../../lib/email';

const mockPrisma = prisma as unknown as DeepMockProxy<PrismaClient>;

function buildApp() {
  const app = express();
  app.use('/api/health', healthRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  redisExport = mockRedis;
  mockRedis.ping.mockResolvedValue('PONG');
  (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ '?column?': 1 }]);
  (isEmailConfigured as jest.Mock).mockReturnValue(true);
});

describe('GET /api/health (liveness)', () => {
  it('returns 200 + uptime without touching the DB or Redis', async () => {
    const res = await request(buildApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    // Liveness must NOT depend on external deps — k8s liveness probes
    // restart the container on failure, so a transient DB blip would
    // cause restart loops.
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    expect(mockRedis.ping).not.toHaveBeenCalled();
  });
});

describe('GET /api/health/ready (readiness)', () => {
  it('returns 200 ready when DB and Redis are both responsive', async () => {
    const res = await request(buildApp()).get('/api/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks.database.ok).toBe(true);
    expect(typeof res.body.checks.database.latencyMs).toBe('number');
    expect(res.body.checks.redis.ok).toBe(true);
    // Email check is informational only — present in the report regardless
    // of provider state so observability tooling can graph it.
    expect(res.body.checks.email.ok).toBe(true);
  });

  it('returns 503 degraded when the database query throws', async () => {
    (mockPrisma.$queryRaw as jest.Mock).mockRejectedValue(new Error('connection refused'));

    const res = await request(buildApp()).get('/api/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.database.ok).toBe(false);
    expect(res.body.checks.database.detail).toMatch(/connection refused/);
  });

  it('returns 503 degraded when Redis ping rejects', async () => {
    mockRedis.ping.mockRejectedValue(new Error('READONLY'));

    const res = await request(buildApp()).get('/api/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.redis.ok).toBe(false);
    expect(res.body.checks.redis.detail).toMatch(/READONLY/);
  });

  it('returns 503 when Redis ping returns an unexpected payload', async () => {
    // ioredis sometimes returns 'PONG' but a misconfigured proxy can return
    // an empty string or 'OK'. The endpoint specifically checks for 'PONG'
    // — anything else is treated as degraded.
    mockRedis.ping.mockResolvedValue('OK' as never);

    const res = await request(buildApp()).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks.redis.ok).toBe(false);
  });

  it('reports Redis as "not configured" without failing when REDIS_URL is absent', async () => {
    redisExport = null;

    const res = await request(buildApp()).get('/api/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.checks.redis.ok).toBe(true);
    expect(res.body.checks.redis.detail).toMatch(/not configured/i);
  });

  it('reports email as informational only (does not flip overall status)', async () => {
    (isEmailConfigured as jest.Mock).mockReturnValue(false);

    const res = await request(buildApp()).get('/api/health/ready');

    // Email being unconfigured (no Resend API key) is documented as a
    // dev/staging fallback — it should NOT mark the deployment degraded.
    expect(res.status).toBe(200);
    expect(res.body.checks.email.ok).toBe(true);
    expect(res.body.checks.email.detail).toMatch(/not configured/i);
  });

  it('returns 503 when BOTH DB and Redis are down (reports both in the body)', async () => {
    (mockPrisma.$queryRaw as jest.Mock).mockRejectedValue(new Error('db down'));
    mockRedis.ping.mockRejectedValue(new Error('redis down'));

    const res = await request(buildApp()).get('/api/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.checks.database.ok).toBe(false);
    expect(res.body.checks.redis.ok).toBe(false);
    // Crucial: don't short-circuit on the first failure. The report should
    // include EVERY check so on-call sees the full picture in one alert.
    expect(res.body.checks.database.detail).toMatch(/db down/);
    expect(res.body.checks.redis.detail).toMatch(/redis down/);
  });
});
