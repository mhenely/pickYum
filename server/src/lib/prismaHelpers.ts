// Composable Prisma `select` / `include` shapes shared across routes.
//
// Why this exists: each route file reinvented its own event-include
// shape with slight differences. groups.ts and trips.ts both pulled
// `options.restaurant`, `options.addedBy`, `createdBy` (always the
// same minimal-user select), and a `result` field — but the
// restaurant projection differed between them, so we can't ship a
// single eventInclude constant. The right granularity is smaller
// building blocks that each route composes into its full include.
//
// Use these constants rather than re-inlining `{ id: true, username:
// true }` in N places. When the minimal user projection needs to
// gain or drop a field (e.g. add `avatarUrl`), one edit propagates.

import { Prisma } from '@prisma/client';

// Minimal user projection: the absolute least to surface "who did
// this" without leaking email, addresses, or auth metadata. Used in
// event options (addedBy), event creators (createdBy), session
// participants, trip members, group hosts, friendship rows.
//
// `as const` makes the literal types narrow so Prisma's generic
// inference can produce a precise return type — without it, the
// type widens to Record<string, boolean> and downstream selects
// lose their typed shape.
export const userMinimalSelect = { id: true, username: true } as const;

// Common include shape for an event's `options` relation:
// restaurant + addedBy + ascending createdAt order. Parametric over
// the restaurant select so trips can ship a slim projection (no
// photos, no hours) while groups get the full row.
//
// The restaurant select is intentionally typed as
// Prisma.RestaurantSelect (not a generic) — keeping the surface
// area narrow forces callers to use Prisma's typed selects, not
// arbitrary objects.
export function eventOptionsInclude(restaurantSelect: Prisma.RestaurantSelect | true) {
  return {
    include: {
      restaurant: restaurantSelect === true ? true : { select: restaurantSelect },
      addedBy: { select: userMinimalSelect },
    },
    orderBy: { createdAt: 'asc' as const },
  };
}
