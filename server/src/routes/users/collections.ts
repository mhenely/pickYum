// User-collection CRUD routes — the buckets a saved restaurant can
// live in. Grouped here because they share the same shape (per-row
// upsert/delete keyed by userId + restaurantId) and most of them
// also drive Insights / History UX.
//
//   - GET/POST/DELETE /me/options
//   - GET/POST/PATCH /me/accepted
//   - GET/POST/DELETE /me/archived
//   - GET/POST/PATCH/DELETE /me/reviews
//   - DELETE /me/history/:restaurantId    (atomic "remove from all collections")
//
// Auth + writeLimiter are applied by the parent router in ./index.ts.

import { Router, Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { parseNumericId } from '../../lib/validators';
import { loadVisibleRestaurant } from '../../lib/authHelpers';
import { MAX_REVIEW_CONTENT, recomputeCommunityRating } from './shared';

const router = Router();

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
  const restaurantId = parseNumericId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  if (!(await loadVisibleRestaurant(restaurantId, req.userId))) {
    res.status(404).json({ error: 'Restaurant not found' }); return;
  }
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
  const restaurantId = parseNumericId(req.params.restaurantId);
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
  const { restaurantId, optionsSnapshot, chooseMethod, excludeFromInsights } = req.body as {
    restaurantId?: number;
    optionsSnapshot?: unknown;
    chooseMethod?: unknown;
    excludeFromInsights?: unknown;
  };
  if (!restaurantId) {
    res.status(400).json({ error: 'restaurantId is required' });
    return;
  }
  if (!(await loadVisibleRestaurant(restaurantId, req.userId))) {
    res.status(404).json({ error: 'Restaurant not found' }); return;
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

  // Default false matches the column default. Allowing the create caller
  // to set it up-front saves a follow-up PATCH for clients that already
  // know a pick should be excluded (e.g. a future "I didn't really want
  // this" affordance on the group-vote result modal).
  let cleanExclude: boolean | undefined;
  if (excludeFromInsights !== undefined && excludeFromInsights !== null) {
    if (typeof excludeFromInsights !== 'boolean') {
      res.status(400).json({ error: 'excludeFromInsights must be a boolean' });
      return;
    }
    cleanExclude = excludeFromInsights;
  }

  const record = await prisma.userAccepted.create({
    data: {
      userId: req.userId,
      restaurantId,
      // Prisma's Json input type rejects `undefined` differently from `null`;
      // omitting via spread keeps legacy clients (no snapshot) working unchanged.
      ...(cleanSnapshot !== undefined && { optionsSnapshot: cleanSnapshot }),
      chooseMethod: cleanMethod ?? null,
      ...(cleanExclude !== undefined && { excludeFromInsights: cleanExclude }),
    },
    include: { restaurant: true },
  });
  res.status(201).json({ accepted: record });
});

// PATCH /api/users/me/accepted/:id
//
// Per-entry toggle for the InsightsPage opt-out. Body: `{ excludeFromInsights: boolean }`.
// Ownership is enforced via `updateMany` with a `userId` filter — using
// `update({ where: { id } })` alone would either succeed (wrong owner)
// or throw P2025 on missing; updateMany returns `{ count }` which we
// branch on to distinguish "missing" from "not yours" cleanly (we treat
// both as 404 to avoid leaking row existence to other users).
router.patch('/me/accepted/:id', async (req: Request, res: Response) => {
  const acceptedId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(acceptedId) || acceptedId <= 0) {
    res.status(400).json({ error: 'accepted id must be a positive integer' });
    return;
  }

  const { excludeFromInsights } = req.body as { excludeFromInsights?: unknown };
  if (typeof excludeFromInsights !== 'boolean') {
    res.status(400).json({ error: 'excludeFromInsights must be a boolean' });
    return;
  }

  const { count } = await prisma.userAccepted.updateMany({
    where: { id: acceptedId, userId: req.userId },
    data: { excludeFromInsights },
  });
  if (count === 0) {
    res.status(404).json({ error: 'Accepted entry not found' });
    return;
  }

  const updated = await prisma.userAccepted.findUnique({
    where: { id: acceptedId },
    include: { restaurant: true },
  });
  res.json({ accepted: updated });
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
  const restaurantId = parseNumericId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  if (!(await loadVisibleRestaurant(restaurantId, req.userId))) {
    res.status(404).json({ error: 'Restaurant not found' }); return;
  }
  await prisma.userArchive.upsert({
    where: { userId_restaurantId: { userId: req.userId, restaurantId } },
    create: { userId: req.userId, restaurantId },
    update: {},
  });
  res.status(201).json({ message: 'Archived' });
});

// DELETE /api/users/me/archived/:restaurantId
router.delete('/me/archived/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseNumericId(req.params.restaurantId);
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
  // Privacy gate: reviewing a private row owned by another user would
  // both expose the row through the review->restaurant join AND skew its
  // cached community rating with off-platform input.
  if (!(await loadVisibleRestaurant(restaurantId, req.userId))) {
    res.status(404).json({ error: 'Restaurant not found' }); return;
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

// PATCH /api/users/me/reviews/:reviewId — edit content + rating on an
// existing review. Useful for typo fixes and rating revisions without
// losing the original createdAt timestamp. Same validation rules as the
// POST handler; both fields are optional but at least one must change
// the row (no-op patches just succeed). Recomputes the cached community
// rating only when the rating actually changed.
router.patch('/me/reviews/:reviewId', async (req: Request, res: Response) => {
  const reviewId = parseInt(req.params.reviewId, 10);
  if (!Number.isInteger(reviewId) || reviewId <= 0) {
    res.status(400).json({ error: 'Invalid review ID' });
    return;
  }

  const existing = await prisma.review.findFirst({
    where: { id: reviewId, userId: req.userId },
    select: { restaurantId: true, rating: true },
  });
  if (!existing) { res.status(404).json({ error: 'Review not found' }); return; }

  const { rating, content } = req.body as { rating?: unknown; content?: unknown };

  const data: { rating?: number; content?: string | null } = {};

  if (rating !== undefined) {
    if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 1 || rating > 5) {
      res.status(400).json({ error: 'rating must be a finite number between 1 and 5' });
      return;
    }
    data.rating = rating;
  }

  if (content !== undefined) {
    if (content === null || content === '') {
      data.content = null;
    } else if (typeof content !== 'string') {
      res.status(400).json({ error: 'content must be a string' }); return;
    } else if (content.length > MAX_REVIEW_CONTENT) {
      res.status(400).json({ error: `content must be ${MAX_REVIEW_CONTENT} characters or fewer` }); return;
    } else {
      data.content = content;
    }
  }

  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: 'No editable fields provided' }); return;
  }

  const review = await prisma.review.update({
    where: { id: reviewId },
    data,
    include: { restaurant: true },
  });

  // Only recompute the community aggregate if the rating moved — content-only
  // edits don't affect any cached number.
  if (data.rating !== undefined && Number(existing.rating) !== data.rating) {
    recomputeCommunityRating(existing.restaurantId).catch((err) =>
      console.warn('[communityRating] recompute failed:', err));
  }

  res.json({ review });
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
  const restaurantId = parseNumericId(req.params.restaurantId);
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

export default router;
