import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimits';

const router = Router();
router.use(requireAuth);
router.use(writeLimiter);

// Public profile shape — never expose password hashes or emails in search results
const publicUser = (u: { id: number; username: string; avatarUrl: string | null }) => ({
  id: u.id,
  username: u.username,
  avatarUrl: u.avatarUrl,
});

// Parse a positive-integer path param. Returns null when the value is missing,
// non-numeric, fractional, or zero/negative. Used to reject silly inputs like
// `/follow/abc` cleanly instead of running a no-op deleteMany on `NaN`.
function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── User search ───────────────────────────────────────────────

// GET /api/social/search?q=...
// Returns up to 10 users whose username matches the query, annotated with
// the current user's relationship to each result.
//
// Username only — searching by email substring lets anyone probe for partial
// email addresses (e.g. `q=@gmail.com` returns every Gmail user) and pair
// emails to usernames in the response. Removed for that reason.
router.get('/search', async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 1) {
    res.json({ users: [] });
    return;
  }

  const matches = await prisma.user.findMany({
    take: 10,
    where: {
      id: { not: req.userId },
      username: { contains: q, mode: 'insensitive' },
    },
    select: { id: true, username: true, avatarUrl: true },
  });

  if (matches.length === 0) {
    res.json({ users: [] });
    return;
  }

  const targetIds = matches.map((u) => u.id);

  // Batch-load relationship context so the UI can show the right buttons
  const [follows, requests] = await Promise.all([
    prisma.follow.findMany({
      where: { followerId: req.userId, followingId: { in: targetIds } },
    }),
    prisma.friendRequest.findMany({
      where: {
        OR: [
          { senderId: req.userId,   receiverId: { in: targetIds } },
          { senderId: { in: targetIds }, receiverId: req.userId },
        ],
      },
    }),
  ]);

  const followingSet = new Set(follows.map((f) => f.followingId));

  type FriendStatus = 'none' | 'pending_sent' | 'pending_received' | 'friends';
  const friendStatusMap = new Map<number, { status: FriendStatus; requestId?: number }>();
  for (const r of requests) {
    const otherId = r.senderId === req.userId ? r.receiverId : r.senderId;
    if (r.status === 'ACCEPTED') {
      friendStatusMap.set(otherId, { status: 'friends' });
    } else if (r.status === 'PENDING') {
      const status: FriendStatus = r.senderId === req.userId ? 'pending_sent' : 'pending_received';
      friendStatusMap.set(otherId, { status, requestId: r.id });
    }
  }

  const users = matches.map((u) => {
    const rel = friendStatusMap.get(u.id);
    return {
      ...publicUser(u),
      isFollowing:      followingSet.has(u.id),
      friendStatus:     rel?.status ?? 'none',
      pendingRequestId: rel?.requestId ?? null,
    };
  });

  res.json({ users });
});

// ── Social summary ────────────────────────────────────────────

// GET /api/social/me
router.get('/me', async (req: Request, res: Response) => {
  const [followersCount, followingCount, friendsCount, pendingRequestsCount] = await Promise.all([
    prisma.follow.count({ where: { followingId: req.userId } }),
    prisma.follow.count({ where: { followerId:  req.userId } }),
    prisma.friendRequest.count({ where: { status: 'ACCEPTED', OR: [{ senderId: req.userId }, { receiverId: req.userId }] } }),
    prisma.friendRequest.count({ where: { receiverId: req.userId, status: 'PENDING' } }),
  ]);

  res.json({ followersCount, followingCount, friendsCount, pendingRequestsCount });
});

// ── Follows ───────────────────────────────────────────────────

// POST /api/social/follow/:userId
router.post('/follow/:userId', async (req: Request, res: Response) => {
  const targetId = Number(req.params.userId);
  if (!targetId || targetId === req.userId) {
    res.status(400).json({ error: 'Invalid target user' });
    return;
  }

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) { res.status(404).json({ error: 'User not found' }); return; }

  await prisma.follow.upsert({
    where: { followerId_followingId: { followerId: req.userId, followingId: targetId } },
    create: { followerId: req.userId, followingId: targetId },
    update: {},
  });

  res.status(201).json({ message: 'Following' });
});

// DELETE /api/social/follow/:userId
router.delete('/follow/:userId', async (req: Request, res: Response) => {
  const targetId = parsePositiveInt(req.params.userId);
  if (!targetId) { res.status(400).json({ error: 'Invalid user ID' }); return; }
  await prisma.follow.deleteMany({
    where: { followerId: req.userId, followingId: targetId },
  });
  res.json({ message: 'Unfollowed' });
});

// GET /api/social/following
router.get('/following', async (req: Request, res: Response) => {
  const rows = await prisma.follow.findMany({
    where: { followerId: req.userId },
    include: { following: { select: { id: true, username: true, avatarUrl: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ following: rows.map((r) => publicUser(r.following)) });
});

// GET /api/social/followers
router.get('/followers', async (req: Request, res: Response) => {
  const rows = await prisma.follow.findMany({
    where: { followingId: req.userId },
    include: { follower: { select: { id: true, username: true, avatarUrl: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ followers: rows.map((r) => publicUser(r.follower)) });
});

// ── Friend requests ───────────────────────────────────────────

// POST /api/social/friend-request/:userId — send a request
router.post('/friend-request/:userId', async (req: Request, res: Response) => {
  const targetId = Number(req.params.userId);
  if (!targetId || targetId === req.userId) {
    res.status(400).json({ error: 'Invalid target user' });
    return;
  }

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) { res.status(404).json({ error: 'User not found' }); return; }

  // Check for an existing relationship in either direction
  const existing = await prisma.friendRequest.findFirst({
    where: {
      OR: [
        { senderId: req.userId, receiverId: targetId },
        { senderId: targetId,   receiverId: req.userId },
      ],
    },
  });

  if (existing) {
    if (existing.status === 'ACCEPTED') {
      res.status(409).json({ error: 'Already friends' });
      return;
    }
    if (existing.status === 'PENDING') {
      // If the other person already sent us a request, auto-accept it
      if (existing.senderId === targetId) {
        const updated = await prisma.friendRequest.update({
          where: { id: existing.id },
          data: { status: 'ACCEPTED' },
        });
        res.json({ request: updated });
        return;
      }
      res.status(409).json({ error: 'Request already sent' });
      return;
    }
    // REJECTED — allow re-sending by updating back to PENDING
    if (existing.senderId === req.userId) {
      const updated = await prisma.friendRequest.update({
        where: { id: existing.id },
        data: { status: 'PENDING' },
      });
      res.json({ request: updated });
      return;
    }
  }

  const request = await prisma.friendRequest.create({
    data: { senderId: req.userId, receiverId: targetId },
  });
  res.status(201).json({ request });
});

// PATCH /api/social/friend-request/:requestId — accept or reject
router.patch('/friend-request/:requestId', async (req: Request, res: Response) => {
  const id = Number(req.params.requestId);
  const { action } = req.body as { action?: 'accept' | 'reject' };

  if (action !== 'accept' && action !== 'reject') {
    res.status(400).json({ error: 'action must be "accept" or "reject"' });
    return;
  }

  const request = await prisma.friendRequest.findUnique({ where: { id } });
  if (!request) { res.status(404).json({ error: 'Request not found' }); return; }
  if (request.receiverId !== req.userId) {
    res.status(403).json({ error: 'Not your request to respond to' });
    return;
  }
  if (request.status !== 'PENDING') {
    res.status(409).json({ error: 'Request is no longer pending' });
    return;
  }

  const updated = await prisma.friendRequest.update({
    where: { id },
    data: { status: action === 'accept' ? 'ACCEPTED' : 'REJECTED' },
  });
  res.json({ request: updated });
});

// DELETE /api/social/friend-request/:userId — cancel outgoing request
router.delete('/friend-request/:userId', async (req: Request, res: Response) => {
  const targetId = parsePositiveInt(req.params.userId);
  if (!targetId) { res.status(400).json({ error: 'Invalid user ID' }); return; }
  await prisma.friendRequest.deleteMany({
    where: { senderId: req.userId, receiverId: targetId, status: 'PENDING' },
  });
  res.json({ message: 'Request cancelled' });
});

// DELETE /api/social/friends/:userId — unfriend
router.delete('/friends/:userId', async (req: Request, res: Response) => {
  const targetId = parsePositiveInt(req.params.userId);
  if (!targetId) { res.status(400).json({ error: 'Invalid user ID' }); return; }
  await prisma.friendRequest.deleteMany({
    where: {
      status: 'ACCEPTED',
      OR: [
        { senderId: req.userId,   receiverId: targetId },
        { senderId: targetId,     receiverId: req.userId },
      ],
    },
  });
  res.json({ message: 'Unfriended' });
});

// GET /api/social/friend-requests/incoming — pending requests received by me
router.get('/friend-requests/incoming', async (req: Request, res: Response) => {
  const requests = await prisma.friendRequest.findMany({
    where: { receiverId: req.userId, status: 'PENDING' },
    include: { sender: { select: { id: true, username: true, avatarUrl: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({
    requests: requests.map((r) => ({
      id: r.id,
      sender: publicUser(r.sender),
      createdAt: r.createdAt,
    })),
  });
});

// GET /api/social/friends — accepted friendships
router.get('/friends', async (req: Request, res: Response) => {
  const rows = await prisma.friendRequest.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ senderId: req.userId }, { receiverId: req.userId }],
    },
    include: {
      sender:   { select: { id: true, username: true, avatarUrl: true } },
      receiver: { select: { id: true, username: true, avatarUrl: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });

  const friends = rows.map((r) =>
    publicUser(r.senderId === req.userId ? r.receiver : r.sender)
  );
  res.json({ friends });
});

// ── Recommendations ───────────────────────────────────────────

// GET /api/social/recommendations/mine — all of the current user's recommendations
router.get('/recommendations/mine', async (req: Request, res: Response) => {
  const rows = await prisma.recommendation.findMany({
    where: { fromUserId: req.userId },
    include: {
      restaurant: { select: { id: true, name: true, cuisineType: true, priceLevel: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ recommendations: rows });
});

// GET /api/social/recommendations/:restaurantId/me — my recommendation for one restaurant
router.get('/recommendations/:restaurantId/me', async (req: Request, res: Response) => {
  const restaurantId = Number(req.params.restaurantId);
  const rec = await prisma.recommendation.findUnique({
    where: { fromUserId_restaurantId: { fromUserId: req.userId, restaurantId } },
  });
  res.json({ recommendation: rec ?? null });
});

// GET /api/social/recommendations/:restaurantId/social — friend + following recs for a restaurant
router.get('/recommendations/:restaurantId/social', async (req: Request, res: Response) => {
  const restaurantId = Number(req.params.restaurantId);

  const [following, friends] = await Promise.all([
    prisma.follow.findMany({ where: { followerId: req.userId }, select: { followingId: true }, take: 100 }),
    prisma.friendRequest.findMany({
      where: { status: 'ACCEPTED', OR: [{ senderId: req.userId }, { receiverId: req.userId }] },
      select: { senderId: true, receiverId: true },
      take: 100,
    }),
  ]);

  const connectionIds = new Set<number>();
  for (const f of following) connectionIds.add(f.followingId);
  for (const f of friends) {
    connectionIds.add(f.senderId === req.userId ? f.receiverId : f.senderId);
  }

  if (connectionIds.size === 0) {
    res.json({ recommendations: [] });
    return;
  }

  const recommendations = await prisma.recommendation.findMany({
    where: { restaurantId, fromUserId: { in: Array.from(connectionIds) } },
    include: { fromUser: { select: { id: true, username: true } } },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ recommendations });
});

// POST /api/social/recommendations/:restaurantId — upsert recommendation + optional tip
router.post('/recommendations/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = Number(req.params.restaurantId);
  if (!restaurantId) {
    res.status(400).json({ error: 'Invalid restaurant ID' });
    return;
  }

  const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) {
    res.status(404).json({ error: 'Restaurant not found in database' });
    return;
  }

  const { tip } = req.body as { tip?: string };
  const recommendation = await prisma.recommendation.upsert({
    where: { fromUserId_restaurantId: { fromUserId: req.userId, restaurantId } },
    create: { fromUserId: req.userId, restaurantId, tip: tip?.trim() || null },
    update: { tip: tip?.trim() || null },
  });

  res.status(201).json({ recommendation });
});

// DELETE /api/social/recommendations/:restaurantId — remove recommendation
router.delete('/recommendations/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = Number(req.params.restaurantId);
  await prisma.recommendation.deleteMany({
    where: { fromUserId: req.userId, restaurantId },
  });
  res.json({ message: 'Recommendation removed' });
});

// ── Friends' recent picks ─────────────────────────────────────

// GET /api/social/friends/recent-picks
// Returns the 20 most recent accepted restaurants across all friends.
router.get('/friends/recent-picks', async (req: Request, res: Response) => {
  // Collect friend IDs from accepted friend requests
  const acceptedRequests = await prisma.friendRequest.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ senderId: req.userId }, { receiverId: req.userId }],
    },
    select: { senderId: true, receiverId: true },
    take: 100,
  });
  const friendIds = acceptedRequests.map((fr) =>
    fr.senderId === req.userId ? fr.receiverId : fr.senderId
  );

  if (friendIds.length === 0) {
    res.json({ picks: [] });
    return;
  }

  const rows = await prisma.userAccepted.findMany({
    where: { userId: { in: friendIds } },
    orderBy: { acceptedAt: 'desc' },
    take: 20,
    include: {
      restaurant: {
        select: { id: true, name: true, cuisineType: true, priceLevel: true, googleRating: true },
      },
      user: { select: { id: true, username: true } },
    },
  });

  res.json({
    picks: rows.map((r) => ({
      id:          r.id,
      acceptedAt:  r.acceptedAt,
      user:        r.user,
      restaurant:  r.restaurant,
    })),
  });
});

export default router;
