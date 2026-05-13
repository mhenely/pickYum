import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { writeLimiter, externalApiLimiter } from '../middleware/rateLimits';
import { validatePassword } from './auth';
import { issueToken } from '../lib/emailTokens';
import { sendEmail, verifyEmailTemplate } from '../lib/email';
import { logger } from '../lib/logger';

const router = Router();

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

// All user routes require authentication and are rate-limited on writes
router.use(requireAuth);
router.use(writeLimiter);

const parseRestaurantId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// String-input caps. Picked generously enough for real usernames / addresses
// / review text, tight enough that a hostile client can't store megabytes per
// row. Username/email match what the registration UI already constrains.
const MAX_USERNAME_LEN   = 32;
const MAX_EMAIL_LEN      = 254; // RFC 5321 maximum
const MAX_REVIEW_CONTENT = 4000;

async function recomputeCommunityRating(restaurantId: number): Promise<void> {
  const userAvgs = await prisma.review.groupBy({
    by: ['userId'],
    where: { restaurantId },
    _avg: { rating: true },
  });
  const communityRating =
    userAvgs.length > 0
      ? userAvgs.reduce((sum, u) => sum + Number(u._avg.rating ?? 0), 0) / userAvgs.length
      : null;
  await prisma.restaurant.update({ where: { id: restaurantId }, data: { communityRating } });
}

// ── Profile ───────────────────────────────────────────────────

// PATCH /api/users/me
// Sensitive updates (password, email) require re-authentication via
// `currentPassword`. Username-only updates are not gated — they're public info
// already and re-prompting for a password for a username change is friction
// without security benefit.
//
// Password changes additionally run the same complexity check as registration
// (validatePassword); the old code skipped this, letting an attacker who
// already has a session weaken the password before exfiltrating it.
//
// Email changes flip emailVerified=false and fire a fresh verification email
// so an attacker can't change the recovery address and have password-reset
// links go to them. The session cookie is preserved (we don't sign out the
// caller) since they just proved current-password control.
router.patch('/me', async (req: Request, res: Response) => {
  const { email, username, password, currentPassword } = req.body as {
    email?: string;
    username?: string;
    password?: string;
    currentPassword?: string;
  };

  // Reject obviously oversized inputs early — Prisma would 500 on overflow,
  // and storing 10MB usernames isn't a feature anyone needs.
  if (typeof email === 'string' && email.length > MAX_EMAIL_LEN) {
    res.status(400).json({ error: `email must be ${MAX_EMAIL_LEN} characters or fewer` }); return;
  }
  if (typeof username === 'string' && (username.length === 0 || username.length > MAX_USERNAME_LEN)) {
    res.status(400).json({ error: `username must be 1-${MAX_USERNAME_LEN} characters` }); return;
  }

  const wantsSensitiveChange = Boolean(email || password);

  if (wantsSensitiveChange) {
    if (typeof currentPassword !== 'string' || !currentPassword) {
      res.status(400).json({ error: 'currentPassword is required to change email or password' });
      return;
    }
    const me = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { passwordHash: true },
    });
    if (!me?.passwordHash) {
      // OAuth-only accounts have no password — they can't re-authenticate this
      // way. Direct them to set one first (via the reset flow) before changing
      // email. Avoids silently allowing email change on accounts that have no
      // local password gate.
      res.status(400).json({ error: 'Set a password first before changing email — use the password reset flow' });
      return;
    }
    const ok = await bcrypt.compare(currentPassword, me.passwordHash);
    if (!ok) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
  }

  if (password) {
    const pwError = validatePassword(password);
    if (pwError) { res.status(400).json({ error: pwError }); return; }
  }

  if (email) {
    const taken = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, NOT: { id: req.userId } } });
    if (taken) { res.status(409).json({ error: 'That email is already in use' }); return; }
  }
  if (username) {
    const taken = await prisma.user.findFirst({ where: { username: { equals: username, mode: 'insensitive' }, NOT: { id: req.userId } } });
    if (taken) { res.status(409).json({ error: 'That username is already taken' }); return; }
  }

  const data: Record<string, unknown> = {};
  if (email) {
    data.email = email;
    // Force re-verification after an email change so an attacker who hijacks a
    // session can't move the account to an address they control without owning
    // the new inbox.
    data.emailVerified = false;
    data.emailVerifiedAt = null;
  }
  if (username) data.username = username;
  if (password) data.passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.update({
    where: { id: req.userId },
    data,
    select: { id: true, email: true, username: true },
  });

  // Fire-and-forget the verification email when the address changed. A failed
  // send isn't fatal (the user can request a resend from the profile page).
  if (email) {
    (async () => {
      try {
        const raw = await issueToken(user.id, 'VERIFY_EMAIL');
        const url = `${CLIENT_URL}/verify-email?token=${encodeURIComponent(raw)}`;
        await sendEmail({ to: user.email, ...verifyEmailTemplate(url) });
      } catch (err) {
        logger.error({ err, userId: user.id }, 'failed to send verification email after email change');
      }
    })();
  }

  res.json({ user });
});

// DELETE /api/users/me — permanently delete the authenticated user's account
router.delete('/me', async (req: Request, res: Response) => {
  await prisma.user.delete({ where: { id: req.userId } });
  // Match the cookie set by auth.ts so the session is actually cleared
  res.clearCookie('token', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
  res.json({ message: 'Account deleted' });
});

// ── Batch load ────────────────────────────────────────────────

// GET /api/users/me/all — returns all user collections in one round-trip
router.get('/me/all', async (req: Request, res: Response) => {
  const [favRows, optRows, accRows, arcRows, revRows] = await Promise.all([
    prisma.userFavorite.findMany({
      where: { userId: req.userId },
      include: { restaurant: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.userOption.findMany({
      where: { userId: req.userId },
      include: { restaurant: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.userAccepted.findMany({
      where: { userId: req.userId },
      include: { restaurant: true },
      orderBy: { acceptedAt: 'desc' },
    }),
    prisma.userArchive.findMany({
      where: { userId: req.userId },
      include: { restaurant: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.review.findMany({
      where: { userId: req.userId },
      include: { restaurant: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  res.json({
    favorites: favRows.map((f) => f.restaurant),
    options: optRows.map((o) => o.restaurant),
    accepted: accRows,
    archived: arcRows.map((a) => a.restaurant),
    reviews: revRows,
  });
});

// ── Favorites ─────────────────────────────────────────────────

// GET /api/users/me/favorites
router.get('/me/favorites', async (req: Request, res: Response) => {
  const favorites = await prisma.userFavorite.findMany({
    where: { userId: req.userId },
    include: { restaurant: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ favorites: favorites.map((f) => f.restaurant) });
});

// POST /api/users/me/favorites/:restaurantId
router.post('/me/favorites/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseRestaurantId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  try {
    await prisma.userFavorite.upsert({
      where: { userId_restaurantId: { userId: req.userId, restaurantId } },
      create: { userId: req.userId, restaurantId },
      update: {},
    });
    res.status(201).json({ message: 'Added to favorites' });
  } catch (err: any) {
    if (err?.code === 'P2003') {
      res.status(422).json({ error: 'Restaurant not found in database' });
    } else {
      throw err;
    }
  }
});

// DELETE /api/users/me/favorites/:restaurantId
router.delete('/me/favorites/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseRestaurantId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  await prisma.userFavorite.deleteMany({
    where: { userId: req.userId, restaurantId },
  });
  res.json({ message: 'Removed from favorites' });
});

// ── Options ───────────────────────────────────────────────────

// GET /api/users/me/options
router.get('/me/options', async (req: Request, res: Response) => {
  const options = await prisma.userOption.findMany({
    where: { userId: req.userId },
    include: { restaurant: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ options: options.map((o) => o.restaurant) });
});

// POST /api/users/me/options/:restaurantId
router.post('/me/options/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseRestaurantId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  try {
    await prisma.userOption.upsert({
      where: { userId_restaurantId: { userId: req.userId, restaurantId } },
      create: { userId: req.userId, restaurantId },
      update: {},
    });
    res.status(201).json({ message: 'Added to options' });
  } catch (err: any) {
    if (err?.code === 'P2003') {
      res.status(422).json({ error: 'Restaurant not found in database' });
    } else {
      throw err;
    }
  }
});

// DELETE /api/users/me/options/:restaurantId
router.delete('/me/options/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseRestaurantId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  await prisma.userOption.deleteMany({
    where: { userId: req.userId, restaurantId },
  });
  res.json({ message: 'Removed from options' });
});

// ── Accepted history ──────────────────────────────────────────

// GET /api/users/me/accepted
router.get('/me/accepted', async (req: Request, res: Response) => {
  const accepted = await prisma.userAccepted.findMany({
    where: { userId: req.userId },
    include: { restaurant: true },
    orderBy: { acceptedAt: 'desc' },
  });
  res.json({ accepted });
});

const VALID_CHOOSE_METHODS = new Set(['flip', 'spin', 'vote', 'surprise', 'direct']);

// POST /api/users/me/accepted
router.post('/me/accepted', async (req: Request, res: Response) => {
  const { restaurantId, optionsSnapshot, chooseMethod } = req.body as {
    restaurantId?: number;
    optionsSnapshot?: unknown;
    chooseMethod?: unknown;
  };
  if (!restaurantId) {
    res.status(400).json({ error: 'restaurantId is required' });
    return;
  }

  // Snapshot is an array of stringy IDs, capped — a Json column is forgiving
  // but we don't want a misbehaving client pushing megabytes of payload here.
  let cleanSnapshot: string[] | undefined;
  if (optionsSnapshot !== undefined && optionsSnapshot !== null) {
    if (!Array.isArray(optionsSnapshot) || optionsSnapshot.length > 100) {
      res.status(400).json({ error: 'optionsSnapshot must be an array of ≤100 IDs' });
      return;
    }
    cleanSnapshot = optionsSnapshot
      .map((v) => String(v))
      .filter((s) => s.length > 0 && s.length <= 64);
  }

  let cleanMethod: string | undefined;
  if (chooseMethod !== undefined && chooseMethod !== null) {
    if (typeof chooseMethod !== 'string' || !VALID_CHOOSE_METHODS.has(chooseMethod)) {
      res.status(400).json({ error: `chooseMethod must be one of: ${[...VALID_CHOOSE_METHODS].join(', ')}` });
      return;
    }
    cleanMethod = chooseMethod;
  }

  const record = await prisma.userAccepted.create({
    data: {
      userId: req.userId,
      restaurantId,
      // Prisma's Json input type rejects `undefined` differently from `null`;
      // omitting via spread keeps legacy clients (no snapshot) working unchanged.
      ...(cleanSnapshot !== undefined && { optionsSnapshot: cleanSnapshot }),
      chooseMethod: cleanMethod ?? null,
    },
    include: { restaurant: true },
  });
  res.status(201).json({ accepted: record });
});

// ── Insights ──────────────────────────────────────────────────
//
// Aggregate analytics over the user's acceptance history. Compute in one pass
// over UserAccepted: a single findMany + an in-memory rollup, which is fine
// for any realistic per-user history size (acceptances are sparse).

// GET /api/users/me/insights
router.get('/me/insights', async (req: Request, res: Response) => {
  const userId = req.userId;

  const rows = await prisma.userAccepted.findMany({
    where: { userId },
    select: {
      restaurantId: true,
      acceptedAt: true,
      optionsSnapshot: true,
      chooseMethod: true,
      restaurant: { select: { id: true, name: true, cuisineType: true } },
    },
    orderBy: { acceptedAt: 'desc' },
  });

  // First pass: build a map of restaurantId → consideration / win counts.
  // Considerations come from optionsSnapshot entries; wins from the
  // acceptance itself (one per row).
  type RestStat = { name: string | null; cuisineType: string | null; considered: number; wins: number };
  const stats = new Map<string, RestStat>();

  const bump = (id: string, key: 'considered' | 'wins', name?: string | null, cuisineType?: string | null) => {
    const entry = stats.get(id) ?? { name: name ?? null, cuisineType: cuisineType ?? null, considered: 0, wins: 0 };
    entry[key] += 1;
    if (name && !entry.name) entry.name = name;
    if (cuisineType && !entry.cuisineType) entry.cuisineType = cuisineType;
    stats.set(id, entry);
  };

  const methodCounts: Record<string, number> = {};
  const cuisineConsidered: Record<string, number> = {};
  const cuisineChosen: Record<string, number> = {};

  for (const row of rows) {
    const winnerId = String(row.restaurantId);
    bump(winnerId, 'wins', row.restaurant?.name, row.restaurant?.cuisineType);

    if (row.restaurant?.cuisineType) {
      cuisineChosen[row.restaurant.cuisineType] = (cuisineChosen[row.restaurant.cuisineType] ?? 0) + 1;
    }

    if (Array.isArray(row.optionsSnapshot)) {
      for (const id of row.optionsSnapshot as unknown[]) {
        const idStr = String(id);
        if (!idStr) continue;
        bump(idStr, 'considered');
      }
    }

    const method = row.chooseMethod ?? 'unknown';
    methodCounts[method] = (methodCounts[method] ?? 0) + 1;
  }

  // Fill in names + cuisine for restaurants that appeared in snapshots but
  // were never winners — they aren't joined on UserAccepted.restaurant.
  const missingIds = [...stats.entries()]
    .filter(([, v]) => !v.name)
    .map(([id]) => Number(id))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (missingIds.length > 0) {
    const fillers = await prisma.restaurant.findMany({
      where: { id: { in: missingIds } },
      select: { id: true, name: true, cuisineType: true },
    });
    for (const r of fillers) {
      const entry = stats.get(String(r.id));
      if (entry) {
        entry.name = r.name;
        entry.cuisineType = r.cuisineType;
      }
    }
  }

  // Second pass: derive cuisine-considered totals using the now-filled names.
  // We rebuild this here rather than during the first pass so cuisines on
  // not-yet-resolved snapshot entries get counted too.
  for (const row of rows) {
    if (!Array.isArray(row.optionsSnapshot)) continue;
    for (const id of row.optionsSnapshot as unknown[]) {
      const entry = stats.get(String(id));
      if (entry?.cuisineType) {
        cuisineConsidered[entry.cuisineType] = (cuisineConsidered[entry.cuisineType] ?? 0) + 1;
      }
    }
  }

  // ── Roll-ups ──
  const all = [...stats.entries()]
    .filter(([, v]) => v.considered > 0 || v.wins > 0)
    .map(([id, v]) => ({
      restaurantId: id,
      name: v.name ?? `Restaurant #${id}`,
      cuisineType: v.cuisineType,
      considered: v.considered,
      wins: v.wins,
      winRate: v.considered > 0 ? v.wins / v.considered : (v.wins > 0 ? 1 : 0),
    }));

  const topConsidered = [...all]
    .filter((r) => r.considered > 0)
    .sort((a, b) => b.considered - a.considered)
    .slice(0, 5);

  // "Often considered, never chosen" — entries with ≥ 2 considerations and 0 wins.
  // A threshold of 2 filters out one-off pool entries and surfaces real avoidance.
  const oftenSkipped = [...all]
    .filter((r) => r.considered >= 2 && r.wins === 0)
    .sort((a, b) => b.considered - a.considered)
    .slice(0, 5);

  const recent = rows.slice(0, 8).map((r) => ({
    restaurantId: String(r.restaurantId),
    name: r.restaurant?.name ?? `Restaurant #${r.restaurantId}`,
    acceptedAt: r.acceptedAt,
    chooseMethod: r.chooseMethod ?? null,
    competing: Array.isArray(r.optionsSnapshot)
      ? (r.optionsSnapshot as unknown[])
          .map(String)
          .filter((id) => id !== String(r.restaurantId))
          .map((id) => stats.get(id)?.name ?? `Restaurant #${id}`)
      : [],
  }));

  res.json({
    totalDecisions: rows.length,
    distinctChosen: new Set(rows.map((r) => r.restaurantId)).size,
    methodCounts,
    cuisineConsidered,
    cuisineChosen,
    topConsidered,
    oftenSkipped,
    recent,
  });
});

// ── Archives ──────────────────────────────────────────────────

// GET /api/users/me/archived
router.get('/me/archived', async (req: Request, res: Response) => {
  const archived = await prisma.userArchive.findMany({
    where: { userId: req.userId },
    include: { restaurant: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ archived: archived.map((a) => a.restaurant) });
});

// POST /api/users/me/archived/:restaurantId
router.post('/me/archived/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseRestaurantId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  await prisma.userArchive.upsert({
    where: { userId_restaurantId: { userId: req.userId, restaurantId } },
    create: { userId: req.userId, restaurantId },
    update: {},
  });
  res.status(201).json({ message: 'Archived' });
});

// DELETE /api/users/me/archived/:restaurantId
router.delete('/me/archived/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseRestaurantId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  await prisma.userArchive.deleteMany({
    where: { userId: req.userId, restaurantId },
  });
  res.json({ message: 'Unarchived' });
});

// ── Reviews ───────────────────────────────────────────────────

// GET /api/users/me/reviews — all of the current user's reviews, optionally filtered by restaurant
router.get('/me/reviews', async (req: Request, res: Response) => {
  const restaurantId = req.query.restaurantId ? Number(req.query.restaurantId) : undefined;
  const reviews = await prisma.review.findMany({
    where: { userId: req.userId, ...(restaurantId && { restaurantId }) },
    include: { restaurant: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ reviews });
});

// POST /api/users/me/reviews
router.post('/me/reviews', async (req: Request, res: Response) => {
  const { restaurantId, rating, content } = req.body as {
    restaurantId?: unknown;
    rating?: unknown;
    content?: unknown;
  };

  // restaurantId must be a positive integer — pass NaN/3.14/"5" through to
  // Prisma and you get a confusing 500 instead of a clean 400.
  if (typeof restaurantId !== 'number' || !Number.isInteger(restaurantId) || restaurantId <= 0) {
    res.status(400).json({ error: 'restaurantId must be a positive integer' });
    return;
  }
  // rating must be a finite number in 1..5. The old check `rating < 1 || rating > 5`
  // accepts NaN (NaN compares false in both directions) and Infinity (Infinity > 5 — fine
  // but Decimal storage rejects it later anyway). Tighten here so the error is the
  // caller's, not Prisma's.
  if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 1 || rating > 5) {
    res.status(400).json({ error: 'rating must be a finite number between 1 and 5' });
    return;
  }
  // Content is optional but capped — storing megabyte reviews is not a feature.
  let cleanContent: string | undefined;
  if (content !== undefined && content !== null) {
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content must be a string' }); return;
    }
    if (content.length > MAX_REVIEW_CONTENT) {
      res.status(400).json({ error: `content must be ${MAX_REVIEW_CONTENT} characters or fewer` }); return;
    }
    cleanContent = content;
  }

  const review = await prisma.review.create({
    data: { userId: req.userId, restaurantId, rating, content: cleanContent ?? null },
    include: { restaurant: true },
  });
  recomputeCommunityRating(restaurantId).catch((err) => console.warn('[communityRating] recompute failed:', err));
  res.status(201).json({ review });
});

// DELETE /api/users/me/reviews/:reviewId
router.delete('/me/reviews/:reviewId', async (req: Request, res: Response) => {
  const reviewId = parseInt(req.params.reviewId, 10);
  if (!Number.isInteger(reviewId) || reviewId <= 0) {
    res.status(400).json({ error: 'Invalid review ID' });
    return;
  }

  const review = await prisma.review.findFirst({ where: { id: reviewId, userId: req.userId }, select: { restaurantId: true } });
  if (!review) { res.status(404).json({ error: 'Review not found' }); return; }

  await prisma.review.deleteMany({ where: { id: reviewId, userId: req.userId } });
  recomputeCommunityRating(review.restaurantId).catch((err) => console.warn('[communityRating] recompute failed:', err));
  res.json({ message: 'Review deleted' });
});

// ── History wipe ──────────────────────────────────────────────

// DELETE /api/users/me/history/:restaurantId
// Removes ALL of this user's traces of one restaurant: favorites, options,
// archives, accepted history, and reviews. Used by the History page's "delete"
// action. Atomic so the UI's local optimistic update can't drift from the DB.
router.delete('/me/history/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseRestaurantId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }

  const hadReviews = await prisma.review.count({ where: { userId: req.userId, restaurantId } });

  await prisma.$transaction([
    prisma.userFavorite.deleteMany({ where: { userId: req.userId, restaurantId } }),
    prisma.userOption.deleteMany({ where: { userId: req.userId, restaurantId } }),
    prisma.userArchive.deleteMany({ where: { userId: req.userId, restaurantId } }),
    prisma.userAccepted.deleteMany({ where: { userId: req.userId, restaurantId } }),
    prisma.review.deleteMany({ where: { userId: req.userId, restaurantId } }),
  ]);

  if (hadReviews > 0) {
    recomputeCommunityRating(restaurantId).catch((err) => console.warn('[communityRating] recompute failed:', err));
  }
  res.json({ message: 'Removed from history' });
});

// ── Flip counter ─────────────────────────────────────────────

// POST /api/users/me/flip
router.post('/me/flip', async (req: Request, res: Response) => {
  const user = await prisma.user.update({
    where: { id: req.userId },
    data: { flipCount: { increment: 1 } },
    select: { flipCount: true },
  });
  res.json({ flipCount: user.flipCount });
});

// ── Stale Google Places data refresh ─────────────────────────

const PLACE_PRICE_LEVEL_MAP: Record<string, number | null> = {
  PRICE_LEVEL_FREE:           null,
  PRICE_LEVEL_INEXPENSIVE:    1,
  PRICE_LEVEL_MODERATE:       2,
  PRICE_LEVEL_EXPENSIVE:      3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

const DETAIL_FIELD_MASK = 'rating,priceLevel,takeout,delivery,internationalPhoneNumber,websiteUri';
const STALE_DAYS = 30;
const MAX_PER_SESSION = 20; // cap API calls per login

// POST /api/users/me/refresh-places
// Finds this user's Google-sourced restaurants not updated in the last 30 days and refreshes them.
// Hits the paid Google Places API per record, so it gets the stricter external limiter.
router.post('/me/refresh-places', externalApiLimiter, async (req: Request, res: Response) => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    res.json({ updated: [] });
    return;
  }

  const staleThreshold = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

  const userLinks = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      favorites: { select: { restaurantId: true } },
      options:   { select: { restaurantId: true } },
      accepted:  { select: { restaurantId: true } },
    },
  });

  if (!userLinks) { res.json({ updated: [] }); return; }

  const linkedIds = [...new Set([
    ...userLinks.favorites.map((f) => f.restaurantId),
    ...userLinks.options.map((o) => o.restaurantId),
    ...userLinks.accepted.map((a) => a.restaurantId),
  ])];

  if (linkedIds.length === 0) { res.json({ updated: [] }); return; }

  const stale = await prisma.restaurant.findMany({
    take: MAX_PER_SESSION,
    where: {
      id: { in: linkedIds },
      googlePlaceId: { not: null },
      OR: [
        { googleDataUpdatedAt: null },
        { googleDataUpdatedAt: { lt: staleThreshold } },
      ],
    },
    orderBy: { googleDataUpdatedAt: 'asc' }, // refresh oldest first
  });

  if (stale.length === 0) { res.json({ updated: [] }); return; }

  console.log(`[refresh] Refreshing ${stale.length} stale restaurant(s)`);

  const updated = [];
  for (const r of stale) {
    try {
      const detailRes = await fetch(
        `https://places.googleapis.com/v1/places/${r.googlePlaceId}`,
        { headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': DETAIL_FIELD_MASK } },
      );
      if (!detailRes.ok) {
        console.warn(`[refresh] Place Details failed for ${r.googlePlaceId}: ${detailRes.status}`);
        continue;
      }
      const detail = await detailRes.json() as Record<string, unknown>;

      const patch: Prisma.RestaurantUpdateInput = { googleDataUpdatedAt: new Date() };
      if (typeof detail.rating === 'number')           patch.googleRating = detail.rating;
      if (typeof detail.priceLevel === 'string' && detail.priceLevel in PLACE_PRICE_LEVEL_MAP)
                                                        patch.priceLevel = PLACE_PRICE_LEVEL_MAP[detail.priceLevel];
      if (typeof detail.takeout === 'boolean')          patch.takeout = detail.takeout;
      if (typeof detail.delivery === 'boolean')         patch.delivery = detail.delivery;
      if (typeof detail.internationalPhoneNumber === 'string') patch.phone = detail.internationalPhoneNumber;
      if (typeof detail.websiteUri === 'string')        patch.website = detail.websiteUri;

      const refreshed = await prisma.restaurant.update({ where: { id: r.id }, data: patch });
      updated.push(refreshed);
    } catch (err) {
      console.warn(`[refresh] Error refreshing restaurant ${r.id} (${r.googlePlaceId}):`, err);
    }
  }

  console.log(`[refresh] Updated ${updated.length} restaurant(s)`);
  res.json({ updated });
});

export default router;
