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

// POST /api/restaurants — upsert by googlePlaceId; falls back to create for custom entries
// Requires auth so we can record who created custom entries
router.post('/', requireAuth, async (req: Request, res: Response) => {
  const {
    googlePlaceId,
    name,
    cuisineType,
    priceLevel,
    hours,
    phone,
    website,
    address,
    yelpUrl,
    takeout,
    delivery,
    googleRating,
  } = req.body as {
    googlePlaceId?: string;
    name: string;
    cuisineType?: string;
    priceLevel?: number;
    hours?: string;
    phone?: string;
    website?: string;
    address?: string;
    yelpUrl?: string;
    takeout?: boolean;
    delivery?: boolean;
    googleRating?: number;
  };

  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const data = {
    name,
    cuisineType,
    priceLevel,
    hours,
    phone,
    website,
    address,
    yelpUrl,
    takeout: takeout ?? false,
    delivery: delivery ?? false,
    googleRating: googleRating ?? null,
    createdBy: req.userId,
  };

  // If a Google Place ID was supplied, upsert so we never duplicate a real place.
  // For custom entries (no googlePlaceId), find-or-create by name (case-insensitive) so
  // the same restaurant name always maps to the same DB row across sessions.
  let restaurant;
  if (googlePlaceId) {
    restaurant = await prisma.restaurant.upsert({
      where: { googlePlaceId },
      create: { googlePlaceId, ...data },
      update: { name, cuisineType, priceLevel, hours, phone, website, address, yelpUrl, takeout, delivery, googleRating },
    });
  } else {
    const existing = await prisma.restaurant.findFirst({
      where: { name: { equals: name.trim(), mode: 'insensitive' }, googlePlaceId: null },
    });
    restaurant = existing ?? await prisma.restaurant.create({ data });
  }

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
