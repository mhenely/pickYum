import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimits';
import { notifyUser } from '../lib/userNotifications';

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
      notifyUser(targetId, 'friend-request');
      res.json({ request: updated });
      return;
    }
  }

  const request = await prisma.friendRequest.create({
    data: { senderId: req.userId, receiverId: targetId },
  });
  notifyUser(targetId, 'friend-request');
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
// Each row carries a `friendCount` = how many of the user's friends OR
// follows also recommend the same restaurant. Powers the social-proof
// chip on the Recommendations tab ("Also recommended by 3 friends").
router.get('/recommendations/mine', async (req: Request, res: Response) => {
  const rows = await prisma.recommendation.findMany({
    where: { fromUserId: req.userId },
    include: {
      restaurant: { select: { id: true, name: true, cuisineType: true, priceLevel: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  if (rows.length === 0) { res.json({ recommendations: [] }); return; }

  // Resolve the user's "network" (friends ∪ follows) in parallel, then a
  // single groupBy to count overlap per restaurant.
  const [following, friends] = await Promise.all([
    prisma.follow.findMany({ where: { followerId: req.userId }, select: { followingId: true }, take: 200 }),
    prisma.friendRequest.findMany({
      where: { status: 'ACCEPTED', OR: [{ senderId: req.userId }, { receiverId: req.userId }] },
      select: { senderId: true, receiverId: true },
      take: 200,
    }),
  ]);
  const networkIds = new Set<number>();
  for (const f of following) networkIds.add(f.followingId);
  for (const f of friends) networkIds.add(f.senderId === req.userId ? f.receiverId : f.senderId);
  networkIds.delete(req.userId);

  const friendCountByRestaurant = new Map<number, number>();
  if (networkIds.size > 0) {
    const restaurantIds = rows.map((r) => r.restaurantId);
    const overlap = await prisma.recommendation.groupBy({
      by: ['restaurantId'],
      where: { restaurantId: { in: restaurantIds }, fromUserId: { in: Array.from(networkIds) } },
      _count: { _all: true },
    });
    for (const o of overlap) friendCountByRestaurant.set(o.restaurantId, o._count._all);
  }

  res.json({
    recommendations: rows.map((r) => ({
      ...r,
      friendCount: friendCountByRestaurant.get(r.restaurantId) ?? 0,
    })),
  });
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

  // Privacy: a private restaurant can only be recommended by its creator
  // (analogous to the group-share rule). Other users guessing the id get the
  // same 404 as a missing row — never reveal that a private restaurant exists.
  // And recommending implies "I want my network to see this," so we auto-
  // publish the row at the same time — friends who follow the recommendation
  // link need to be able to open the restaurant detail.
  const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant || (restaurant.private && restaurant.createdBy !== req.userId)) {
    res.status(404).json({ error: 'Restaurant not found in database' });
    return;
  }
  if (restaurant.private && restaurant.createdBy === req.userId) {
    await prisma.restaurant.update({ where: { id: restaurantId }, data: { private: false } });
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

// ── Recommendation lists ──────────────────────────────────────
//
// Curated, named, shareable groupings of recommendations the caller owns.
// Visibility on each list controls who can see it on the owner's recs
// surface (NETWORK = friends ∪ follows by default, matching individual
// recommendation visibility). Lists never leak rows the viewer wouldn't
// otherwise see — the include + visibility check enforce ownership and
// audience in a single query.

const MAX_LIST_NAME_LEN        = 60;
const MAX_LIST_DESCRIPTION_LEN = 280;
const MAX_LISTS_PER_USER       = 50;
const VALID_LIST_VISIBILITIES  = ['FRIENDS', 'FOLLOWERS', 'NETWORK'] as const;
type ListVisibility = typeof VALID_LIST_VISIBILITIES[number];
// #RRGGBB hex (case-insensitive). Mirrors the FavoriteList color shape.
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

// Shared include — what we return for every list shape (mine + others').
// `entries` is filtered + ordered server-side so the client just renders
// the array.
const listInclude = {
  entries: {
    orderBy: [{ position: 'asc' as const }, { addedAt: 'asc' as const }],
    include: {
      recommendation: {
        include: {
          restaurant: { select: { id: true, name: true, cuisineType: true, priceLevel: true, googlePlaceId: true } },
        },
      },
    },
  },
};

// Returns true iff `viewerId` is in `ownerId`'s audience for a list with
// the given visibility. Used by every endpoint that returns lists owned
// by someone other than the caller.
//   FRIENDS   → accepted mutual friendship required
//   FOLLOWERS → viewer follows the owner
//   NETWORK   → either of the above
async function viewerCanSeeList(viewerId: number, ownerId: number, visibility: ListVisibility): Promise<boolean> {
  if (viewerId === ownerId) return true;
  if (visibility === 'FRIENDS' || visibility === 'NETWORK') {
    const friend = await prisma.friendRequest.findFirst({
      where: {
        status: 'ACCEPTED',
        OR: [
          { senderId: viewerId, receiverId: ownerId },
          { senderId: ownerId,  receiverId: viewerId },
        ],
      },
      select: { id: true },
    });
    if (friend) return true;
    if (visibility === 'FRIENDS') return false;
  }
  // FOLLOWERS or NETWORK (after the friend-check fell through)
  // Follow has a composite PK (followerId, followingId) — no `id` column —
  // so select one of the FK columns to confirm existence.
  const follow = await prisma.follow.findFirst({
    where: { followerId: viewerId, followingId: ownerId },
    select: { followerId: true },
  });
  return Boolean(follow);
}

// GET /api/social/lists/mine — every list the caller owns, with entries.
router.get('/lists/mine', async (req: Request, res: Response) => {
  const lists = await prisma.recommendationList.findMany({
    where: { userId: req.userId },
    include: listInclude,
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  res.json({ lists });
});

// POST /api/social/lists — create a list. Visibility defaults to NETWORK
// (matches single-rec visibility today). Body: { name, description?,
// color?, visibility? }.
router.post('/lists', async (req: Request, res: Response) => {
  const { name, description, color, visibility } = req.body as {
    name?: string; description?: string | null; color?: string | null; visibility?: string;
  };

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName)                                  { res.status(400).json({ error: 'name is required' }); return; }
  if (trimmedName.length > MAX_LIST_NAME_LEN)        { res.status(400).json({ error: `name must be ${MAX_LIST_NAME_LEN} characters or fewer` }); return; }

  if (description != null && (typeof description !== 'string' || description.length > MAX_LIST_DESCRIPTION_LEN)) {
    res.status(400).json({ error: `description must be a string of ${MAX_LIST_DESCRIPTION_LEN} characters or fewer` });
    return;
  }
  if (color != null && (typeof color !== 'string' || !HEX_COLOR_RE.test(color))) {
    res.status(400).json({ error: 'color must be a #RRGGBB hex string' });
    return;
  }
  let parsedVisibility: ListVisibility = 'NETWORK';
  if (visibility !== undefined) {
    if (typeof visibility !== 'string' || !VALID_LIST_VISIBILITIES.includes(visibility as ListVisibility)) {
      res.status(400).json({ error: `visibility must be one of ${VALID_LIST_VISIBILITIES.join(', ')}` });
      return;
    }
    parsedVisibility = visibility as ListVisibility;
  }

  // Per-user list cap so a runaway client can't fill the table.
  const existingCount = await prisma.recommendationList.count({ where: { userId: req.userId } });
  if (existingCount >= MAX_LISTS_PER_USER) {
    res.status(400).json({ error: `You can have at most ${MAX_LISTS_PER_USER} lists` });
    return;
  }

  try {
    const list = await prisma.recommendationList.create({
      data: {
        userId:      req.userId as number,
        name:        trimmedName,
        description: description ?? null,
        color:       color ?? null,
        visibility:  parsedVisibility,
        position:    existingCount,
      },
      include: listInclude,
    });
    res.status(201).json({ list });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      res.status(409).json({ error: 'You already have a list with that name' });
      return;
    }
    throw err;
  }
});

// PATCH /api/social/lists/:id — update name / description / color /
// visibility. Body fields are all optional; only supplied fields change.
router.patch('/lists/:id', async (req: Request, res: Response) => {
  const listId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(listId)) { res.status(400).json({ error: 'list id must be an integer' }); return; }

  const body = req.body as { name?: string; description?: string | null; color?: string | null; visibility?: string };
  const data: { name?: string; description?: string | null; color?: string | null; visibility?: ListVisibility } = {};

  if (body.name !== undefined) {
    const trimmed = body.name?.trim() ?? '';
    if (!trimmed)                              { res.status(400).json({ error: 'name cannot be empty' }); return; }
    if (trimmed.length > MAX_LIST_NAME_LEN)    { res.status(400).json({ error: `name must be ${MAX_LIST_NAME_LEN} characters or fewer` }); return; }
    data.name = trimmed;
  }
  if (body.description !== undefined) {
    if (body.description !== null && (typeof body.description !== 'string' || body.description.length > MAX_LIST_DESCRIPTION_LEN)) {
      res.status(400).json({ error: `description must be a string of ${MAX_LIST_DESCRIPTION_LEN} characters or fewer` });
      return;
    }
    data.description = body.description;
  }
  if (body.color !== undefined) {
    if (body.color !== null && (typeof body.color !== 'string' || !HEX_COLOR_RE.test(body.color))) {
      res.status(400).json({ error: 'color must be a #RRGGBB hex string' });
      return;
    }
    data.color = body.color;
  }
  if (body.visibility !== undefined) {
    if (typeof body.visibility !== 'string' || !VALID_LIST_VISIBILITIES.includes(body.visibility as ListVisibility)) {
      res.status(400).json({ error: `visibility must be one of ${VALID_LIST_VISIBILITIES.join(', ')}` });
      return;
    }
    data.visibility = body.visibility as ListVisibility;
  }
  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: 'At least one field must be supplied' });
    return;
  }

  try {
    // updateMany scoped by userId so callers can't mutate someone else's
    // list. count=0 means either the list doesn't exist OR isn't theirs;
    // both surface as 404 to preserve list-existence privacy.
    const result = await prisma.recommendationList.updateMany({
      where: { id: listId, userId: req.userId },
      data,
    });
    if (result.count === 0) { res.status(404).json({ error: 'List not found' }); return; }
    const list = await prisma.recommendationList.findUnique({ where: { id: listId }, include: listInclude });
    res.json({ list });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      res.status(409).json({ error: 'You already have a list with that name' });
      return;
    }
    throw err;
  }
});

// DELETE /api/social/lists/:id — delete a list. Underlying recommendations
// are NOT deleted (the rec join cascades only on the list-entry row).
router.delete('/lists/:id', async (req: Request, res: Response) => {
  const listId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(listId)) { res.status(400).json({ error: 'list id must be an integer' }); return; }
  const result = await prisma.recommendationList.deleteMany({
    where: { id: listId, userId: req.userId },
  });
  if (result.count === 0) { res.status(404).json({ error: 'List not found' }); return; }
  res.status(204).end();
});

// POST /api/social/lists/:id/entries/:restaurantId — add a recommendation
// to a list. Upserts the underlying Recommendation if it doesn't already
// exist so the user doesn't have to first "recommend" a restaurant before
// adding it to a list. Optional `tip` body field updates the rec's tip
// when supplied.
router.post('/lists/:id/entries/:restaurantId', async (req: Request, res: Response) => {
  const listId       = Number.parseInt(req.params.id, 10);
  const restaurantId = Number.parseInt(req.params.restaurantId, 10);
  if (!Number.isFinite(listId) || !Number.isFinite(restaurantId)) {
    res.status(400).json({ error: 'list id and restaurant id must be integers' }); return;
  }
  const { tip } = req.body as { tip?: string | null };
  if (tip != null && (typeof tip !== 'string' || tip.length > 500)) {
    res.status(400).json({ error: 'tip must be a string of 500 characters or fewer' });
    return;
  }

  // Ownership: list must belong to caller. Use findFirst so a missing OR
  // mis-owned list surfaces as the same 404.
  const list = await prisma.recommendationList.findFirst({
    where: { id: listId, userId: req.userId },
    select: { id: true },
  });
  if (!list) { res.status(404).json({ error: 'List not found' }); return; }

  // Upsert the underlying recommendation by (fromUserId, restaurantId).
  const rec = await prisma.recommendation.upsert({
    where:  { fromUserId_restaurantId: { fromUserId: req.userId as number, restaurantId } },
    create: { fromUserId: req.userId as number, restaurantId, tip: tip ?? null },
    update: tip !== undefined ? { tip } : {},
  });

  // Position = current entry count so new entries land at the end.
  const position = await prisma.recommendationListEntry.count({ where: { listId } });

  try {
    await prisma.recommendationListEntry.create({
      data: { listId, recommendationId: rec.id, position },
    });
  } catch (err: unknown) {
    // P2002 = already in the list. Treat as success — re-adding is a no-op.
    if (typeof err !== 'object' || err === null || !('code' in err) || (err as { code: string }).code !== 'P2002') {
      throw err;
    }
  }

  const updated = await prisma.recommendationList.findUnique({ where: { id: listId }, include: listInclude });
  res.json({ list: updated });
});

// DELETE /api/social/lists/:id/entries/:restaurantId — remove a rec from
// a list. The underlying Recommendation stays — only the list-entry row
// is dropped, so a removed rec falls back to standalone (still visible
// to friends/follows individually).
router.delete('/lists/:id/entries/:restaurantId', async (req: Request, res: Response) => {
  const listId       = Number.parseInt(req.params.id, 10);
  const restaurantId = Number.parseInt(req.params.restaurantId, 10);
  if (!Number.isFinite(listId) || !Number.isFinite(restaurantId)) {
    res.status(400).json({ error: 'list id and restaurant id must be integers' }); return;
  }

  // Verify ownership before mutating.
  const list = await prisma.recommendationList.findFirst({
    where: { id: listId, userId: req.userId },
    select: { id: true },
  });
  if (!list) { res.status(404).json({ error: 'List not found' }); return; }

  const rec = await prisma.recommendation.findUnique({
    where: { fromUserId_restaurantId: { fromUserId: req.userId as number, restaurantId } },
    select: { id: true },
  });
  if (!rec) { res.status(204).end(); return; }

  await prisma.recommendationListEntry.deleteMany({
    where: { listId, recommendationId: rec.id },
  });
  res.status(204).end();
});

// GET /api/social/users/:userId/lists — every list of `userId` that the
// caller is allowed to see. Per-list visibility is evaluated against the
// caller's relationship to the owner; lists the caller can't see are
// dropped from the response (not surfaced as "private", which would
// leak existence).
router.get('/users/:userId/lists', async (req: Request, res: Response) => {
  const ownerId = Number.parseInt(req.params.userId, 10);
  if (!Number.isFinite(ownerId)) { res.status(400).json({ error: 'userId must be an integer' }); return; }

  const all = await prisma.recommendationList.findMany({
    where: { userId: ownerId },
    include: listInclude,
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  if (all.length === 0) { res.json({ lists: [] }); return; }

  // Cache relationship checks per (viewer, owner) — every list of the
  // same owner uses the same answer for FRIENDS / FOLLOWERS / NETWORK,
  // so we resolve each at most once.
  const viewerId = req.userId as number;
  const isFriend = ownerId === viewerId ? true : Boolean(
    await prisma.friendRequest.findFirst({
      where: {
        status: 'ACCEPTED',
        OR: [
          { senderId: viewerId, receiverId: ownerId },
          { senderId: ownerId,  receiverId: viewerId },
        ],
      },
      select: { id: true },
    }),
  );
  const isFollower = ownerId === viewerId ? true : (!isFriend && Boolean(
    await prisma.follow.findFirst({
      where: { followerId: viewerId, followingId: ownerId },
      select: { followerId: true },
    }),
  ));

  const lists = all.filter((l) => {
    if (l.visibility === 'NETWORK')   return isFriend || isFollower;
    if (l.visibility === 'FRIENDS')   return isFriend;
    if (l.visibility === 'FOLLOWERS') return isFollower || isFriend; // friends can always see follower-tier
    return false;
  });
  res.json({ lists });
});

// POST /api/social/lists/:id/share — explicitly share one of the caller's
// lists with a friend. Sends a notification (SSE + push) — does NOT
// change visibility. The recipient must already be able to see the list
// (visibility check is enforced before notification fires).
// Body: { friendUserId: number }
router.post('/lists/:id/share', async (req: Request, res: Response) => {
  const listId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(listId)) { res.status(400).json({ error: 'list id must be an integer' }); return; }

  const { friendUserId } = req.body as { friendUserId?: unknown };
  if (typeof friendUserId !== 'number' || !Number.isInteger(friendUserId) || friendUserId <= 0) {
    res.status(400).json({ error: 'friendUserId must be a positive integer' });
    return;
  }
  if (friendUserId === req.userId) {
    res.status(400).json({ error: 'Cannot share a list with yourself' });
    return;
  }

  const list = await prisma.recommendationList.findFirst({
    where: { id: listId, userId: req.userId },
    select: { id: true, name: true, visibility: true },
  });
  if (!list) { res.status(404).json({ error: 'List not found' }); return; }

  // The recipient must already be able to see the list — otherwise a
  // share would be a one-off ACL bypass, which our visibility model
  // doesn't support. Guide the caller to broaden visibility first.
  const canSee = await viewerCanSeeList(friendUserId, req.userId as number, list.visibility);
  if (!canSee) {
    res.status(400).json({ error: 'Recipient cannot see this list at its current visibility. Broaden visibility first.' });
    return;
  }

  notifyUser(friendUserId, 'list-shared');
  res.json({ ok: true });
});

export default router;
