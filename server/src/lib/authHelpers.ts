// Visibility / access-control helpers shared across route files.
//
// Why this exists: the "is this restaurant visible to this viewer"
// rule was previously inline in users.ts as `loadVisibleRestaurant`,
// but groups/trips/social all need the same check when they accept
// a restaurantId from the client. Inlining it three more times would
// invite drift — and a drift here is a privacy bug (a route silently
// dropping the `private` check would let any user enumerate other
// users' private restaurants).
//
// Existence-hiding: returns null in two cases — row missing AND
// row private-but-not-yours. Same response in both cases so
// attackers can't probe for the existence of private rows by ID.
// Callers should 404 (not 403) when this returns null.

import prisma from './prisma';

export async function loadVisibleRestaurant(
  restaurantId: number,
  userId: number,
): Promise<{ id: number; private: boolean; createdBy: number | null } | null> {
  const r = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, private: true, createdBy: true },
  });
  if (!r) return null;
  if (r.private && r.createdBy !== userId) return null;
  return r;
}
