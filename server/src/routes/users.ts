import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { writeLimiter, externalApiLimiter } from '../middleware/rateLimits';

const router = Router();

// All user routes require authentication and are rate-limited on writes
router.use(requireAuth);
router.use(writeLimiter);

const parseRestaurantId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

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
router.patch('/me', async (req: Request, res: Response) => {
  const { email, username, password } = req.body as {
    email?: string;
    username?: string;
    password?: string;
  };

  if (email) {
    const taken = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, NOT: { id: req.userId } } });
    if (taken) { res.status(409).json({ error: 'That email is already in use' }); return; }
  }
  if (username) {
    const taken = await prisma.user.findFirst({ where: { username: { equals: username, mode: 'insensitive' }, NOT: { id: req.userId } } });
    if (taken) { res.status(409).json({ error: 'That username is already taken' }); return; }
  }

  const data: Record<string, unknown> = {};
  if (email) data.email = email;
  if (username) data.username = username;
  if (password) data.passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.update({
    where: { id: req.userId },
    data,
    select: { id: true, email: true, username: true },
  });
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
  const [favRows, selRows, accRows, arcRows, revRows] = await Promise.all([
    prisma.userFavorite.findMany({
      where: { userId: req.userId },
      include: { restaurant: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.userSelection.findMany({
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
    selections: selRows.map((s) => s.restaurant),
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

// ── Selections ────────────────────────────────────────────────

// GET /api/users/me/selections
router.get('/me/selections', async (req: Request, res: Response) => {
  const selections = await prisma.userSelection.findMany({
    where: { userId: req.userId },
    include: { restaurant: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ selections: selections.map((s) => s.restaurant) });
});

// POST /api/users/me/selections/:restaurantId
router.post('/me/selections/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseRestaurantId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  try {
    await prisma.userSelection.upsert({
      where: { userId_restaurantId: { userId: req.userId, restaurantId } },
      create: { userId: req.userId, restaurantId },
      update: {},
    });
    res.status(201).json({ message: 'Added to selections' });
  } catch (err: any) {
    if (err?.code === 'P2003') {
      res.status(422).json({ error: 'Restaurant not found in database' });
    } else {
      throw err;
    }
  }
});

// DELETE /api/users/me/selections/:restaurantId
router.delete('/me/selections/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseRestaurantId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  await prisma.userSelection.deleteMany({
    where: { userId: req.userId, restaurantId },
  });
  res.json({ message: 'Removed from selections' });
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

// POST /api/users/me/accepted
router.post('/me/accepted', async (req: Request, res: Response) => {
  const { restaurantId } = req.body as { restaurantId?: number };
  if (!restaurantId) {
    res.status(400).json({ error: 'restaurantId is required' });
    return;
  }
  const record = await prisma.userAccepted.create({
    data: { userId: req.userId, restaurantId },
    include: { restaurant: true },
  });
  res.status(201).json({ accepted: record });
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
    restaurantId?: number;
    rating?: number;
    content?: string;
  };

  if (!restaurantId || rating == null) {
    res.status(400).json({ error: 'restaurantId and rating are required' });
    return;
  }
  if (rating < 1 || rating > 5) {
    res.status(400).json({ error: 'rating must be between 1 and 5' });
    return;
  }

  const review = await prisma.review.create({
    data: { userId: req.userId, restaurantId, rating, content },
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
// Removes ALL of this user's traces of one restaurant: favorites, selections,
// archives, accepted history, and reviews. Used by the History page's "delete"
// action. Atomic so the UI's local optimistic update can't drift from the DB.
router.delete('/me/history/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseRestaurantId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }

  const hadReviews = await prisma.review.count({ where: { userId: req.userId, restaurantId } });

  await prisma.$transaction([
    prisma.userFavorite.deleteMany({ where: { userId: req.userId, restaurantId } }),
    prisma.userSelection.deleteMany({ where: { userId: req.userId, restaurantId } }),
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
      favorites:  { select: { restaurantId: true } },
      selections: { select: { restaurantId: true } },
      accepted:   { select: { restaurantId: true } },
    },
  });

  if (!userLinks) { res.json({ updated: [] }); return; }

  const linkedIds = [...new Set([
    ...userLinks.favorites.map((f) => f.restaurantId),
    ...userLinks.selections.map((s) => s.restaurantId),
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
