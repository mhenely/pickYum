import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';

// E2E test support endpoints.
//
// ────────────────────────────────────────────────────────────────────
// MOUNTED ONLY WHEN `E2E_TEST_HOOKS=true`. NEVER IN PRODUCTION.
//
// app.ts gates the mount on this env var. Production deployments must
// leave it unset. Setting it in prod would expose a destructive endpoint
// that wipes user state — an obvious attack surface.
// ────────────────────────────────────────────────────────────────────
//
// Why these exist:
// - Real E2E tests need to assert observable user-visible behavior
//   against a running stack, not unit-mocked code paths. To do that
//   they need a predictable starting state.
// - The cheapest way to give Playwright a clean slate is a dedicated
//   test user whose data the test can reset between specs. These hooks
//   are that reset surface, plus a few read-back hooks for assertions
//   that would otherwise require parsing the UI (e.g. "what's the
//   current failed-login-count?").
// - Build a separate test DB if you want stronger isolation. These
//   hooks are designed to be safe enough for shared dev DBs by being
//   scoped to a single test email per call.

const router = Router();

// Reset a test user's collections. Identified by email, not by an auth
// cookie — the test fixture sets up state for a known account before
// logging that account in. Idempotent: returns 200 even if the user
// doesn't exist (the next test spec creates it).
router.post('/reset-user', async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string };
  if (typeof email !== 'string' || !email.endsWith('@pickyum.test')) {
    // Guard: refuse to reset anything that isn't an obvious test email.
    // Real users have real domains; the .test TLD is reserved by RFC
    // 2606 for testing and never resolves on the internet.
    res.status(400).json({ error: 'Test reset only works for *@pickyum.test emails' });
    return;
  }

  const user = await prisma.user.findFirst({ where: { email: { equals: email } } });
  if (!user) {
    res.json({ message: 'No such user; nothing to reset' });
    return;
  }

  // Wipe everything the user could have written. Ordering matters
  // only where there are foreign keys that don't cascade — we let
  // Cascade handle relations and only touch tables where it doesn't
  // (e.g. UserAccepted's optionsSnapshot JSON is just dropped with
  // the row).
  await prisma.$transaction([
    prisma.userFavorite.deleteMany({ where: { userId: user.id } }),
    prisma.userOption.deleteMany({ where: { userId: user.id } }),
    prisma.userAccepted.deleteMany({ where: { userId: user.id } }),
    prisma.userArchive.deleteMany({ where: { userId: user.id } }),
    prisma.review.deleteMany({ where: { userId: user.id } }),
    prisma.savedAddress.deleteMany({ where: { userId: user.id } }),
    prisma.favoriteListEntry.deleteMany({ where: { list: { userId: user.id } } }),
    prisma.favoriteList.deleteMany({ where: { userId: user.id } }),
    prisma.user.update({
      where: { id: user.id },
      data: {
        flipCount: 0,
        failedLoginCount: 0,
        failedLoginLockedUntil: null,
      },
    }),
  ]);
  res.json({ message: 'Reset', userId: user.id });
});

// Create a test user if it doesn't exist. Useful as a setup step in a
// global Playwright fixture so each spec doesn't have to register first.
router.post('/ensure-user', async (req: Request, res: Response) => {
  const { email, password, username } = req.body as { email?: string; password?: string; username?: string };
  if (typeof email !== 'string' || !email.endsWith('@pickyum.test')) {
    res.status(400).json({ error: 'Test user emails must end in @pickyum.test' });
    return;
  }
  if (typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'Password must be ≥8 chars' });
    return;
  }
  const existing = await prisma.user.findFirst({ where: { email: { equals: email } } });
  if (existing) {
    res.json({ message: 'User already exists', userId: existing.id });
    return;
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const created = await prisma.user.create({
    data: {
      email,
      username: username ?? email.split('@')[0],
      passwordHash,
      emailVerified: true,
      favoriteLists: {
        create: { name: 'My Favorites', isDefault: true, position: 0 },
      },
    },
  });
  res.status(201).json({ message: 'Created', userId: created.id });
});

// Read-back hook: inspect a user's failed-login state. Used by the
// lockout spec to assert the counter increments without scraping the
// UI for invisible state.
router.get('/user-state', async (req: Request, res: Response) => {
  const email = typeof req.query.email === 'string' ? req.query.email : '';
  if (!email.endsWith('@pickyum.test')) {
    res.status(400).json({ error: 'Test queries only for *@pickyum.test' });
    return;
  }
  const user = await prisma.user.findFirst({
    where: { email: { equals: email } },
    select: { id: true, failedLoginCount: true, failedLoginLockedUntil: true, flipCount: true },
  });
  if (!user) {
    res.status(404).json({ error: 'No such user' });
    return;
  }
  res.json({ user });
});

// Manually unlock a test user (helps when the lockout spec sets up
// state that subsequent specs need cleared). Could just call /reset-user,
// but this is more surgical and faster.
router.post('/unlock-user', async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string };
  if (typeof email !== 'string' || !email.endsWith('@pickyum.test')) {
    res.status(400).json({ error: 'Test unlock only for *@pickyum.test' });
    return;
  }
  const user = await prisma.user.findFirst({ where: { email: { equals: email } } });
  if (!user) {
    res.json({ message: 'No such user' });
    return;
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, failedLoginLockedUntil: null },
  });
  res.json({ message: 'Unlocked' });
});

logger.info('E2E test hooks loaded — DO NOT USE IN PRODUCTION');

export default router;
