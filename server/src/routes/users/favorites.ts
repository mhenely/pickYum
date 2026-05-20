// Favorites + favorite-lists CRUD:
//   - GET/POST/DELETE /me/favorites/:restaurantId   (legacy single-list)
//   - GET/POST /me/favorite-lists
//   - PATCH /me/favorite-lists/positions
//   - PATCH /me/favorite-lists/:id
//   - DELETE /me/favorite-lists/:id
//   - POST /me/favorite-lists/:id/default
//   - POST/PATCH/DELETE /me/favorite-lists/:id/entries[/:rid]
//
// Auth + writeLimiter are applied by the parent router in ./index.ts.

import { Router, Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { parseNumericId } from '../../lib/validators';
import { loadVisibleRestaurant } from '../../lib/authHelpers';
import {
  LIST_COLOR_PALETTE,
  LIST_WITH_ENTRIES_SELECT,
  MAX_LIST_DESCRIPTION_LEN,
  MAX_LIST_ENTRY_NOTE_LEN,
  MAX_LIST_NAME_LEN,
  MAX_LISTS_PER_USER,
  InvalidColorError,
  normalizeColor,
  serializeList,
  ensureDefaultFavoriteList,
} from '../../lib/favoriteLists';

const router = Router();

// ── Favorites (legacy single-list endpoints) ──────────────────

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
// LEGACY endpoint. Still present for backward compatibility, but
// new code uses POST /me/favorite-lists/:id/entries instead. The
// new endpoint already mirrors writes into UserFavorite when the
// list is default — so the legacy table stays current as long as
// the modern endpoints are the source of truth. No reverse mirror
// here on purpose: the frontend migration is removing the only
// callers of this route, and forcing a default-list lookup on
// every legacy write would over-couple the two surfaces.
router.post('/me/favorites/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseNumericId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  // Visibility gate: a private restaurant owned by another user must not be
  // addable here — otherwise GET /me/favorites would expose its full row
  // (name, address, etc.) on the join.
  if (!(await loadVisibleRestaurant(restaurantId, req.userId))) {
    res.status(404).json({ error: 'Restaurant not found' }); return;
  }
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
// LEGACY endpoint — see POST comment for the back-compat story.
router.delete('/me/favorites/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseNumericId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  await prisma.userFavorite.deleteMany({
    where: { userId: req.userId, restaurantId },
  });
  res.json({ message: 'Removed from favorites' });
});

// ── Favorite lists (multi-list favorites) ─────────────────────
//
// User-scoped CRUD for FavoriteList + FavoriteListEntry. All routes
// require auth via the router-level requireAuth above; every handler
// additionally asserts ownership by matching `userId === req.userId`
// before any mutation so a list id leaked between accounts can't be
// poked from a different session.
//
// During the v1 rollout these endpoints keep the legacy UserFavorite
// table in sync: adding/removing a default-list entry mirrors to
// user_favorites so the old surfaces (and the legacy `favorites`
// array in /me/all) still reflect the user's current favorites
// without requiring a second write at the call site.

// Pull a list row and confirm the caller owns it. Returns the
// existing row + a 404-aware response shape. Used by every PATCH /
// DELETE handler so the ownership check + 404-on-other-user path
// are identical across endpoints (and indistinguishable from
// 404-on-missing — avoids id-enumeration via 403 vs 404 timing).
async function loadOwnedList(listId: number, userId: number) {
  const list = await prisma.favoriteList.findUnique({
    where: { id: listId },
    select: {
      id: true,
      userId: true,
      groupId: true,
      name: true,
      isDefault: true,
      position: true,
    },
  });
  if (!list || list.userId !== userId) return null;
  return list;
}

// GET /api/users/me/favorite-lists
// Returns every list owned by this user, with entries inlined.
// Defensive default-bootstrap covers legacy accounts that pre-date
// the backfill or somehow ended up with no rows.
router.get('/me/favorite-lists', async (req: Request, res: Response) => {
  let lists = await prisma.favoriteList.findMany({
    where: { userId: req.userId },
    orderBy: { position: 'asc' },
    select: LIST_WITH_ENTRIES_SELECT,
  });

  if (lists.length === 0) {
    await ensureDefaultFavoriteList(req.userId);
    lists = await prisma.favoriteList.findMany({
      where: { userId: req.userId },
      orderBy: { position: 'asc' },
      select: LIST_WITH_ENTRIES_SELECT,
    });
  }

  res.json({ lists: lists.map(serializeList) });
});

// POST /api/users/me/favorite-lists
// Create a new named list. Position lands at the end of the user's
// existing lists; rename / reorder via PATCH afterwards.
router.post('/me/favorite-lists', async (req: Request, res: Response) => {
  const { name, description, color } = req.body as {
    name?: unknown;
    description?: unknown;
    color?: unknown;
  };

  // Name — required, trimmed, length-capped.
  if (typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' }); return;
  }
  const trimmedName = name.trim();
  if (!trimmedName) {
    res.status(400).json({ error: 'name cannot be empty' }); return;
  }
  if (trimmedName.length > MAX_LIST_NAME_LEN) {
    res.status(400).json({ error: `name must be ${MAX_LIST_NAME_LEN} characters or fewer` }); return;
  }

  // Description — optional, length-capped.
  let cleanDescription: string | null = null;
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string') {
      res.status(400).json({ error: 'description must be a string' }); return;
    }
    if (description.length > MAX_LIST_DESCRIPTION_LEN) {
      res.status(400).json({ error: `description must be ${MAX_LIST_DESCRIPTION_LEN} characters or fewer` }); return;
    }
    cleanDescription = description;
  }

  // Color — palette-allowlist validated.
  let cleanColor: string | null;
  try { cleanColor = normalizeColor(color); }
  catch (err) {
    if (err instanceof InvalidColorError) {
      res.status(400).json({ error: `color must be one of: ${LIST_COLOR_PALETTE.join(', ')}` });
      return;
    }
    throw err;
  }

  // Soft cap on lists per user. Stops abuse + keeps the management
  // modal usable.
  const existingCount = await prisma.favoriteList.count({ where: { userId: req.userId } });
  if (existingCount >= MAX_LISTS_PER_USER) {
    res.status(400).json({ error: `You can have at most ${MAX_LISTS_PER_USER} lists` });
    return;
  }

  // Position = (max existing position) + 1. SQL would give us this
  // atomically; doing it in JS is fine at this scale and keeps the
  // logic readable.
  const maxPos = await prisma.favoriteList.aggregate({
    where: { userId: req.userId },
    _max:  { position: true },
  });
  const nextPosition = (maxPos._max.position ?? -1) + 1;

  try {
    const created = await prisma.favoriteList.create({
      data: {
        userId: req.userId,
        name: trimmedName,
        description: cleanDescription,
        color: cleanColor,
        isDefault: false,
        position: nextPosition,
      },
      select: LIST_WITH_ENTRIES_SELECT,
    });
    res.status(201).json({ list: serializeList(created) });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      res.status(409).json({ error: 'You already have a list with that name' });
      return;
    }
    throw err;
  }
});

// PATCH /api/users/me/favorite-lists/positions
// Declared BEFORE the `:id` parameterized patches so Express matches
// the literal "positions" path first — otherwise the param route
// catches "positions" as `:id` and 400s on parseNumericId.
//
// Rewrite every list's `position` in one shot. Body shape:
// `{ order: [listId, listId, ...] }`. We validate that the supplied
// id set EXACTLY matches the user's current list set — partial
// reorders would leave some positions stale and break the sort.
router.patch('/me/favorite-lists/positions', async (req: Request, res: Response) => {
  const { order } = req.body as { order?: unknown };
  if (!Array.isArray(order) || !order.every((x) => Number.isInteger(x) && (x as number) > 0)) {
    res.status(400).json({ error: 'order must be an array of positive integer list ids' }); return;
  }
  const orderIds = order as number[];

  const current = await prisma.favoriteList.findMany({
    where: { userId: req.userId },
    select: { id: true },
  });
  const currentIds = new Set(current.map((l) => l.id));

  // Exact set match — same length AND every id present. Catches
  // duplicates in the input (length mismatch after Set conversion).
  if (orderIds.length !== currentIds.size || new Set(orderIds).size !== orderIds.length
      || !orderIds.every((id) => currentIds.has(id))) {
    res.status(400).json({ error: 'order must contain exactly your current list ids' }); return;
  }

  // Sequential 0..N positions. Transaction so a partial failure
  // doesn't leave the user with an inconsistent order.
  await prisma.$transaction(
    orderIds.map((id, idx) =>
      prisma.favoriteList.update({ where: { id }, data: { position: idx } }),
    ),
  );

  res.json({ message: 'List order updated' });
});

// PATCH /api/users/me/favorite-lists/:id
// Rename, change description, or change color. Promote-to-default is
// a separate POST (.../default) to keep the validation focused.
router.patch('/me/favorite-lists/:id', async (req: Request, res: Response) => {
  const listId = parseNumericId(req.params.id);
  if (!listId) { res.status(400).json({ error: 'Invalid list id' }); return; }

  const existing = await loadOwnedList(listId, req.userId);
  if (!existing) { res.status(404).json({ error: 'List not found' }); return; }

  const { name, description, color } = req.body as {
    name?: unknown;
    description?: unknown;
    color?: unknown;
  };

  const data: Record<string, unknown> = {};

  if (typeof name === 'string') {
    const trimmed = name.trim();
    if (!trimmed) { res.status(400).json({ error: 'name cannot be empty' }); return; }
    if (trimmed.length > MAX_LIST_NAME_LEN) {
      res.status(400).json({ error: `name must be ${MAX_LIST_NAME_LEN} characters or fewer` }); return;
    }
    data.name = trimmed;
  }

  if (description !== undefined) {
    if (description === null) {
      data.description = null;
    } else if (typeof description !== 'string') {
      res.status(400).json({ error: 'description must be a string or null' }); return;
    } else if (description.length > MAX_LIST_DESCRIPTION_LEN) {
      res.status(400).json({ error: `description must be ${MAX_LIST_DESCRIPTION_LEN} characters or fewer` }); return;
    } else {
      data.description = description;
    }
  }

  if (color !== undefined) {
    try { data.color = normalizeColor(color); }
    catch (err) {
      if (err instanceof InvalidColorError) {
        res.status(400).json({ error: `color must be one of: ${LIST_COLOR_PALETTE.join(', ')}` });
        return;
      }
      throw err;
    }
  }

  if (Object.keys(data).length === 0) {
    // Nothing to change — return the current row as-is so the client
    // can use the response uniformly without special-casing no-op.
    const current = await prisma.favoriteList.findUnique({
      where: { id: listId },
      select: LIST_WITH_ENTRIES_SELECT,
    });
    res.json({ list: current ? serializeList(current) : null });
    return;
  }

  try {
    const updated = await prisma.favoriteList.update({
      where: { id: listId },
      data,
      select: LIST_WITH_ENTRIES_SELECT,
    });
    res.json({ list: serializeList(updated) });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      res.status(409).json({ error: 'You already have a list with that name' });
      return;
    }
    throw err;
  }
});

// DELETE /api/users/me/favorite-lists/:id
// Deletes the list + all of its entries (entry cascade). Two
// guards: cannot delete the user's only list, and cannot delete a
// list that's currently marked default (promote another first).
router.delete('/me/favorite-lists/:id', async (req: Request, res: Response) => {
  const listId = parseNumericId(req.params.id);
  if (!listId) { res.status(400).json({ error: 'Invalid list id' }); return; }

  const existing = await loadOwnedList(listId, req.userId);
  if (!existing) { res.status(404).json({ error: 'List not found' }); return; }

  if (existing.isDefault) {
    res.status(400).json({ error: 'Cannot delete the default list — promote another first' });
    return;
  }

  const totalLists = await prisma.favoriteList.count({ where: { userId: req.userId } });
  if (totalLists <= 1) {
    // Belt-and-suspenders: the default-guard above already catches
    // the typical case (only list → it's default → reject). This
    // covers the legacy edge case of a non-default sole list.
    res.status(400).json({ error: 'Cannot delete your only list' });
    return;
  }

  await prisma.favoriteList.delete({ where: { id: listId } });
  res.json({ message: 'List deleted' });
});

// POST /api/users/me/favorite-lists/:id/default
// Promote this list to default. Atomic: clears any existing default
// inside the same transaction so we never end up with two defaults.
router.post('/me/favorite-lists/:id/default', async (req: Request, res: Response) => {
  const listId = parseNumericId(req.params.id);
  if (!listId) { res.status(400).json({ error: 'Invalid list id' }); return; }

  const existing = await loadOwnedList(listId, req.userId);
  if (!existing) { res.status(404).json({ error: 'List not found' }); return; }

  const updated = await prisma.$transaction(async (tx) => {
    // Demote any current defaults that aren't this list. Bulk
    // updateMany rather than a per-row update because there's only
    // ever supposed to be one — but if the invariant somehow got
    // broken we want to repair on the next promote.
    await tx.favoriteList.updateMany({
      where: { userId: req.userId, isDefault: true, NOT: { id: listId } },
      data:  { isDefault: false },
    });
    return tx.favoriteList.update({
      where: { id: listId },
      data: { isDefault: true },
      select: LIST_WITH_ENTRIES_SELECT,
    });
  });

  // Sync the legacy user_favorites table with the new default's
  // entries so /me/all's derived favoriteIds + any code still
  // reading the old table reflect the promotion. Fire-and-forget so
  // a hiccup here doesn't block the response — the read paths are
  // self-healing via favoriteLists.
  syncLegacyFavorites(req.userId)
    .catch((err) => logger.warn({ err, userId: req.userId }, 'syncLegacyFavorites after default promote failed'));

  res.json({ list: serializeList(updated) });
});

// POST /api/users/me/favorite-lists/:id/entries
// Add a restaurant to a list. Body: { restaurantId, note? }.
// Idempotent on the (listId, restaurantId) PK — repeat adds are a
// no-op rather than a 409, which matches the heart-icon UX (rapid
// double-click should be safe).
router.post('/me/favorite-lists/:id/entries', async (req: Request, res: Response) => {
  const listId = parseNumericId(req.params.id);
  if (!listId) { res.status(400).json({ error: 'Invalid list id' }); return; }

  const existing = await loadOwnedList(listId, req.userId);
  if (!existing) { res.status(404).json({ error: 'List not found' }); return; }

  const { restaurantId, note } = req.body as { restaurantId?: unknown; note?: unknown };
  if (typeof restaurantId !== 'number' || !Number.isInteger(restaurantId) || restaurantId <= 0) {
    res.status(400).json({ error: 'restaurantId must be a positive integer' }); return;
  }
  if (!(await loadVisibleRestaurant(restaurantId, req.userId))) {
    res.status(404).json({ error: 'Restaurant not found' }); return;
  }

  let cleanNote: string | null = null;
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string') {
      res.status(400).json({ error: 'note must be a string' }); return;
    }
    if (note.length > MAX_LIST_ENTRY_NOTE_LEN) {
      res.status(400).json({ error: `note must be ${MAX_LIST_ENTRY_NOTE_LEN} characters or fewer` }); return;
    }
    cleanNote = note;
  }

  const entry = await prisma.favoriteListEntry.upsert({
    where: { listId_restaurantId: { listId, restaurantId } },
    create: { listId, restaurantId, note: cleanNote },
    // Re-add of the same entry shouldn't overwrite an existing note
    // with null — only update if the caller explicitly sent a note.
    update: cleanNote === null ? {} : { note: cleanNote },
    select: { restaurantId: true, note: true, addedAt: true },
  });

  // Mirror to the legacy user_favorites table when this is the
  // user's default list. Keeps /me/all's transition-period
  // favoriteIds + any old client reading UserFavorite consistent.
  if (existing.isDefault) {
    await prisma.userFavorite.upsert({
      where: { userId_restaurantId: { userId: req.userId, restaurantId } },
      create: { userId: req.userId, restaurantId },
      update: {},
    });
  }

  res.status(201).json({ entry });
});

// PATCH /api/users/me/favorite-lists/:id/entries/:rid
// Update the per-entry note. Same ownership + visibility rules as POST.
router.patch('/me/favorite-lists/:id/entries/:rid', async (req: Request, res: Response) => {
  const listId       = parseNumericId(req.params.id);
  const restaurantId = parseNumericId(req.params.rid);
  if (!listId)       { res.status(400).json({ error: 'Invalid list id' }); return; }
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }

  const existing = await loadOwnedList(listId, req.userId);
  if (!existing) { res.status(404).json({ error: 'List not found' }); return; }

  const { note } = req.body as { note?: unknown };
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string') {
      res.status(400).json({ error: 'note must be a string' }); return;
    }
    if (note.length > MAX_LIST_ENTRY_NOTE_LEN) {
      res.status(400).json({ error: `note must be ${MAX_LIST_ENTRY_NOTE_LEN} characters or fewer` }); return;
    }
  }

  try {
    const updated = await prisma.favoriteListEntry.update({
      where: { listId_restaurantId: { listId, restaurantId } },
      data:  { note: note === undefined ? undefined : (note as string | null) },
      select: { restaurantId: true, note: true, addedAt: true },
    });
    res.json({ entry: updated });
  } catch (err: unknown) {
    // P2025 = "An operation failed because it depends on one or more
    // records that were required but not found." Surface as a 404 so
    // the client can refresh and retry.
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2025') {
      res.status(404).json({ error: 'Entry not found' }); return;
    }
    throw err;
  }
});

// DELETE /api/users/me/favorite-lists/:id/entries/:rid
// Remove a restaurant from a list. Idempotent — removing something
// that isn't there is a successful no-op.
router.delete('/me/favorite-lists/:id/entries/:rid', async (req: Request, res: Response) => {
  const listId       = parseNumericId(req.params.id);
  const restaurantId = parseNumericId(req.params.rid);
  if (!listId)       { res.status(400).json({ error: 'Invalid list id' }); return; }
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }

  const existing = await loadOwnedList(listId, req.userId);
  if (!existing) { res.status(404).json({ error: 'List not found' }); return; }

  await prisma.favoriteListEntry.deleteMany({
    where: { listId, restaurantId },
  });

  // Mirror to legacy user_favorites when this is the default list AND
  // the restaurant isn't in any of the user's other lists. The latter
  // matters because UserFavorite is a flat "is this a favorite?"
  // bucket — if the user still has the restaurant in another list it
  // shouldn't disappear from the legacy view.
  if (existing.isDefault) {
    const otherListMembership = await prisma.favoriteListEntry.findFirst({
      where: {
        restaurantId,
        list: { userId: req.userId, NOT: { id: listId } },
      },
      select: { restaurantId: true },
    });
    if (!otherListMembership) {
      await prisma.userFavorite.deleteMany({
        where: { userId: req.userId, restaurantId },
      });
    }
  }

  res.json({ message: 'Removed from list' });
});

// ── Legacy-favorites sync helper ──────────────────────────────
// Bring the legacy `user_favorites` table in line with the
// current default list's entries. Called after default-list
// promotion (POST .../default) so the legacy view reflects the
// new default's contents without each individual entry-add/remove
// having to know what the default's id is. Idempotent.
async function syncLegacyFavorites(userId: number): Promise<void> {
  const defaultList = await prisma.favoriteList.findFirst({
    where: { userId, isDefault: true },
    select: {
      id: true,
      entries: { select: { restaurantId: true } },
    },
  });
  if (!defaultList) return;

  const desired = new Set(defaultList.entries.map((e) => e.restaurantId));
  const current = await prisma.userFavorite.findMany({
    where: { userId },
    select: { restaurantId: true },
  });
  const present = new Set(current.map((r) => r.restaurantId));

  const toAdd    = [...desired].filter((id) => !present.has(id));
  const toRemove = [...present].filter((id) => !desired.has(id));

  await prisma.$transaction([
    ...(toRemove.length > 0 ? [
      prisma.userFavorite.deleteMany({
        where: { userId, restaurantId: { in: toRemove } },
      }),
    ] : []),
    ...(toAdd.length > 0 ? [
      prisma.userFavorite.createMany({
        data: toAdd.map((restaurantId) => ({ userId, restaurantId })),
        skipDuplicates: true,
      }),
    ] : []),
  ]);
}

export default router;
