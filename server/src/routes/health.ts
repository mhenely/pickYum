import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import redis from '../lib/redis';
import { isEmailConfigured } from '../lib/email';
import { logger } from '../lib/logger';

const router = Router();

// GET /api/health — liveness check. Cheap, never hits the DB. Always 200 if
// the process is up. Use this for Kubernetes liveness probes / load-balancer
// "is the container alive" checks.
router.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// GET /api/health/ready — readiness check. Verifies the dependencies the app
// actually needs to serve requests. Use this for Kubernetes readiness probes
// and uptime monitors. Returns 503 if anything is degraded so traffic stops.
router.get('/ready', async (_req: Request, res: Response) => {
  const checks: Record<string, { ok: boolean; latencyMs?: number; detail?: string }> = {};
  let allOk = true;

  // ── Database ──
  const dbStart = performance.now();
  try {
    // SELECT 1 — minimal round-trip to confirm the connection pool works.
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { ok: true, latencyMs: Math.round(performance.now() - dbStart) };
  } catch (err) {
    allOk = false;
    checks.database = { ok: false, detail: (err as Error).message };
    logger.error({ err }, 'health check: database unreachable');
  }

  // ── Redis (optional — if not configured, report as not_configured rather than failing) ──
  if (redis) {
    const redisStart = performance.now();
    try {
      const pong = await redis.ping();
      const ok = pong === 'PONG';
      if (!ok) allOk = false;
      checks.redis = { ok, latencyMs: Math.round(performance.now() - redisStart) };
    } catch (err) {
      allOk = false;
      checks.redis = { ok: false, detail: (err as Error).message };
      logger.error({ err }, 'health check: redis unreachable');
    }
  } else {
    checks.redis = { ok: true, detail: 'not configured (in-memory fallback)' };
  }

  // ── Email provider (informational — degraded but not failing) ──
  checks.email = { ok: true, detail: isEmailConfigured() ? 'configured' : 'not configured (no-op)' };

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ready' : 'degraded',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    checks,
  });
});

export default router;
