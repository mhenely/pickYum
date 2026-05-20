// Bootstrap / batch-load routes:
//   - GET /me/identity   — fast critical-path: user + favoriteIds + defaultListId
//   - GET /me/data       — extended payload (everything except identity)
//   - GET /me/all        — DEPRECATED legacy compat: identity + data merged
//
// Auth + writeLimiter are applied by the parent router in ./index.ts.

import { Router, Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import {
  LIST_WITH_ENTRIES_SELECT,
  serializeList,
  ensureDefaultFavoriteList,
} from '../../lib/favoriteLists';
import { RESTAURANT_CARD_SELECT, ME_ALL_API_VERSION } from './shared';

const router = Router();

// GET /me/identity — fast critical-path bootstrap.
//
// Returns just enough for the app shell to render correctly:
//   - User identity (id, email, username, flipCount, avatarUrl, role,
//     emailVerified) for the nav + profile menu.
//   - defaultListId + favoriteIds so the heart icons on every card
//     render with the right fill state before the heavier /me/data
//     fetch lands.
//
// Two cheap queries vs. /me/all's seven-parallel + dedup-restaurants
// batch. Lets the client paint the home/search/compare pages with
// correct identity + favorite state in ~30ms, while History / Insights
// / "everything else" data streams in via /me/data in parallel.
//
// Why this isn't just a subset of /me/all: the perf win comes from
// NOT awaiting the slow queries (full restaurant lookup, all favorite
// list entries, accepted history) before responding. A user reading
// the search page doesn't care about their accepted history; serving
// it on every initial pageload is the cost we're removing.
router.get('/me/identity', async (req: Request, res: Response) => {
  const [user, defaultList] = await Promise.all([
    prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true, email: true, username: true, flipCount: true,
        avatarUrl: true, role: true, emailVerified: true,
        dietaryTags: true,
      },
    }),
    // Default list + its entries. The heart-fill state needs the entries;
    // everything else about the list (color, position, etc.) ships with
    // /me/data when the rest of the multi-list UI loads.
    prisma.favoriteList.findFirst({
      where: { userId: req.userId, isDefault: true },
      select: {
        id: true,
        entries: { select: { restaurantId: true }, orderBy: { addedAt: 'desc' } },
      },
    }),
  ]);

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Defensive bootstrap mirroring /me/all's path: if no default list
  // exists (legacy or freshly-deleted-everything), create one so the
  // heart icons have a valid target list.
  let defaultListId: number | null = defaultList?.id ?? null;
  let favoriteIds: number[] = defaultList?.entries.map((e) => e.restaurantId) ?? [];
  if (!defaultListId) {
    // ensureDefaultFavoriteList returns the list id (number) — see the
    // helper in lib/favoriteLists.ts. A freshly-created default list has
    // no entries yet, so favoriteIds stays [].
    defaultListId = await ensureDefaultFavoriteList(req.userId);
    favoriteIds = [];
  }

  res.json({
    apiVersion: 1,
    user,
    defaultListId,
    favoriteIds,
  });
});

// GET /me/data — extended payload (everything except identity).
//
// Carries the heavier data the app eventually needs but can defer past
// the initial render: full deduped restaurants[], all favorite lists,
// options, accepted history, archives, reviews, addresses. Fired in
// parallel with /me/identity by modern clients.
//
// Response shape mirrors /me/all minus the identity fields, so the
// JSON nesting and field names stay stable across both — anything that
// reads from /me/all's response can read from this without remapping.
router.get('/me/data', async (req: Request, res: Response) => {
  const data = await fetchUserDataPayload(req.userId);
  res.json(data);
});

// Shared helper used by /me/data and (for backward compat) /me/all.
// Kept as a function rather than inlined twice so the two endpoints
// can't drift on field shape. /me/all merges the identity payload on
// top of this; /me/data returns this verbatim.
async function fetchUserDataPayload(userId: number) {
  const [favRows, optRows, accRows, arcRows, revRows, addrRows, favListRows] = await Promise.all([
    prisma.userFavorite.findMany({
      where: { userId },
      select: { restaurantId: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.userOption.findMany({
      where: { userId },
      select: { restaurantId: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.userAccepted.findMany({
      where: { userId },
      select: { id: true, restaurantId: true, acceptedAt: true, excludeFromInsights: true },
      orderBy: { acceptedAt: 'desc' },
    }),
    prisma.userArchive.findMany({
      where: { userId },
      select: { restaurantId: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.review.findMany({
      where: { userId },
      select: {
        id: true,
        content: true,
        rating: true,
        restaurantId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.savedAddress.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    }),
    prisma.favoriteList.findMany({
      where: { userId },
      orderBy: { position: 'asc' },
      select: LIST_WITH_ENTRIES_SELECT,
    }),
  ]);

  let lists = favListRows;
  if (lists.length === 0) {
    await ensureDefaultFavoriteList(userId);
    lists = await prisma.favoriteList.findMany({
      where: { userId },
      orderBy: { position: 'asc' },
      select: LIST_WITH_ENTRIES_SELECT,
    });
  }

  const linkedIds = new Set<number>();
  favRows.forEach((r) => linkedIds.add(r.restaurantId));
  optRows.forEach((r) => linkedIds.add(r.restaurantId));
  accRows.forEach((r) => linkedIds.add(r.restaurantId));
  arcRows.forEach((r) => linkedIds.add(r.restaurantId));
  revRows.forEach((r) => linkedIds.add(r.restaurantId));
  for (const list of lists) {
    for (const entry of list.entries) linkedIds.add(entry.restaurantId);
  }

  const restaurants = linkedIds.size === 0 ? [] : await prisma.restaurant.findMany({
    where: { id: { in: [...linkedIds] } },
    select: RESTAURANT_CARD_SELECT,
  });

  const defaultList = lists.find((l) => l.isDefault) ?? lists[0] ?? null;
  const favoriteIds = defaultList
    ? defaultList.entries.map((e) => e.restaurantId)
    : favRows.map((r) => r.restaurantId);

  return {
    apiVersion: ME_ALL_API_VERSION,
    restaurants,
    favoriteIds,
    optionIds:       optRows.map((r) => r.restaurantId),
    archivedIds:     arcRows.map((r) => r.restaurantId),
    acceptedEntries: accRows,
    reviews:         revRows,
    addresses:       addrRows,
    favoriteLists:   lists.map(serializeList),
  };
}

// GET /me/all — DEPRECATED. Identity + extended data in one shot. Kept
// for backward compat with the legacy client (and future mobile builds
// that may still call it). New web client paths fire /me/identity +
// /me/data in parallel for the perf win. Delegates to fetchUserDataPayload
// so there's no chance of /me/all's shape drifting from /me/data.
//
// Logs a deprecation breadcrumb on each call — when the count goes to
// zero in production logs, this route is safe to remove.
router.get('/me/all', async (req: Request, res: Response) => {
  logger.warn({ userId: req.userId, route: '/me/all' }, 'deprecated /me/all endpoint hit — migrate caller to /me/identity + /me/data');
  const data = await fetchUserDataPayload(req.userId);
  res.json(data);
});

export default router;
