import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimits';

const router = Router();
router.use(writeLimiter);

const parseId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// GET /api/restaurants — paginated list
router.get('/', async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const search = (req.query.search as string) || '';

  const where = search
    ? { name: { contains: search, mode: 'insensitive' as const } }
    : {};

  const [restaurants, total] = await Promise.all([
    prisma.restaurant.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { name: 'asc' },
    }),
    prisma.restaurant.count({ where }),
  ]);

  res.json({ restaurants, total, page, pages: Math.ceil(total / limit) });
});

// GET /api/restaurants/:id
router.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  const restaurant = await prisma.restaurant.findUnique({ where: { id } });
  if (!restaurant) {
    res.status(404).json({ error: 'Restaurant not found' });
    return;
  }
  res.json({ restaurant });
});

// POST /api/restaurants — find-or-create (never update). Any logged-in user can
// materialize a Google Place or a custom name into a Restaurant row, but they
// cannot overwrite fields on a row that already exists. Stale Google data is
// refreshed only via the authenticated `refreshPlaces` flow, which calls Google
// server-side rather than trusting client payloads.
//
// Caps text fields at conservative lengths so a hostile client can't push
// megabytes into a shared row that other users see.
const MAX_NAME       = 200;
const MAX_TEXT_FIELD = 500;

function clipString(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

// URL fields go to <a href> on the frontend. Reject anything that isn't a
// plain http(s) URL or a bare host string (we prepend https:// when missing).
// Blocks `javascript:`, `data:`, `vbscript:`, etc. at the storage boundary so
// no client-side `href` is ever asked to render a hostile scheme.
function clipUrl(v: unknown, max: number): string | undefined {
  const s = clipString(v, max);
  if (!s) return undefined;
  if (/^[a-z][a-z0-9+\-.]*:/i.test(s) && !/^https?:\/\//i.test(s)) {
    // Has a scheme, but it's not http/https — reject. We don't try to
    // sanitize; refusing is the only safe option.
    return undefined;
  }
  return s;
}

router.post('/', requireAuth, async (req: Request, res: Response) => {
  const body = req.body as {
    googlePlaceId?: unknown;
    name?: unknown;
    cuisineType?: unknown;
    priceLevel?: unknown;
    hours?: unknown;
    phone?: unknown;
    website?: unknown;
    address?: unknown;
    yelpUrl?: unknown;
    takeout?: unknown;
    delivery?: unknown;
    googleRating?: unknown;
  };

  const name = clipString(body.name, MAX_NAME);
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }

  const googlePlaceId = clipString(body.googlePlaceId, 200);

  // Find first — if the row already exists, return it untouched. This is the
  // security-relevant change: previously the upsert's `update` path let any
  // caller overwrite name/phone/website/etc. on shared Place rows.
  if (googlePlaceId) {
    const existing = await prisma.restaurant.findUnique({ where: { googlePlaceId } });
    if (existing) { res.status(200).json({ restaurant: existing }); return; }
  } else {
    const existing = await prisma.restaurant.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, googlePlaceId: null },
    });
    if (existing) { res.status(200).json({ restaurant: existing }); return; }
  }

  // Validate numeric fields cleanly — Prisma will reject NaN/Infinity but the
  // error surface is worse than an early 400.
  const priceLevel = (typeof body.priceLevel === 'number' && Number.isInteger(body.priceLevel) && body.priceLevel >= 1 && body.priceLevel <= 4)
    ? body.priceLevel : undefined;
  const googleRating = (typeof body.googleRating === 'number' && Number.isFinite(body.googleRating) && body.googleRating >= 0 && body.googleRating <= 5)
    ? body.googleRating : null;

  const restaurant = await prisma.restaurant.create({
    data: {
      googlePlaceId: googlePlaceId ?? null,
      name,
      cuisineType: clipString(body.cuisineType, MAX_TEXT_FIELD),
      priceLevel,
      hours:       clipString(body.hours,    MAX_TEXT_FIELD),
      phone:       clipString(body.phone,    MAX_TEXT_FIELD),
      website:     clipUrl(body.website,    MAX_TEXT_FIELD),
      address:     clipString(body.address, MAX_TEXT_FIELD),
      yelpUrl:     clipUrl(body.yelpUrl,    MAX_TEXT_FIELD),
      takeout:  body.takeout  === true,
      delivery: body.delivery === true,
      googleRating,
      createdBy: req.userId,
    },
  });
  res.status(201).json({ restaurant });
});

// GET /api/restaurants/:id/reviews — community reviews for a restaurant
router.get('/:id/reviews', async (req: Request, res: Response) => {
  const restaurantId = parseId(req.params.id);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }

  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const page  = Math.max(1, Number(req.query.page) || 1);

  const [reviews, aggregate, restaurant] = await Promise.all([
    prisma.review.findMany({
      where: { restaurantId },
      skip: (page - 1) * limit,
      take: limit,
      include: { user: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.review.aggregate({
      where: { restaurantId },
      _avg: { rating: true },
      _count: true,
    }),
    prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { communityRating: true },
    }),
  ]);

  const total = aggregate._count;
  const averageRating = aggregate._avg.rating ? Number(aggregate._avg.rating) : null;
  const communityRating = restaurant?.communityRating ? Number(restaurant.communityRating) : null;

  res.json({ reviews, averageRating, communityRating, total, page, pages: Math.ceil(total / limit) });
});

export default router;
