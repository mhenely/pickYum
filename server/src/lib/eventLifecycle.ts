// Shared event-lifecycle helpers — the GroupEvent table is polymorphic
// (parent is either a Group or a Trip via groupId/tripId), so the launch
// and member-removal/voter-revoke logic should be too. Previously these
// lived as near-duplicate `launchVoting` / `launchTripVoting` and inline
// member-removal blocks in both route files. The biggest known drift bug
// (groups didn't revoke voter tokens on member removal; trips did) was a
// direct symptom of that duplication. This module is the unification.

import prisma from './prisma';
import {
  createSession, generateSessionId, withSessionLock,
  getSession, saveSession, notifyClients,
  type RestaurantSnapshot,
  type SnapshotPhoto,
} from '../sessions';

export type EventParent = 'group' | 'trip';

// Atomically claims an OPEN GroupEvent and materializes a voting session
// for it. Works for both group events (parent='group', groupId set) and
// trip meal events (parent='trip', tripId set). Returns null when:
//   - event doesn't exist or wrong parent
//   - event isn't OPEN (race or already started)
//   - fewer than 2 candidates
//   - host user can't be loaded (deleted between request and dispatch)
//
// Race-safety: pre-allocates the session id, claims it via updateMany
// guarded on status='OPEN', and only then materializes in Redis. The
// previous create-then-claim ordering leaked orphan sessions on a race.
export async function launchVoting(
  parent: EventParent,
  parentId: number,
  eventId: number,
  hostId: number,
) {
  const event = await prisma.groupEvent.findUnique({
    where: { id: eventId },
    include: { options: { include: { restaurant: true } } },
  });
  if (!event) return null;
  if (parent === 'group' && event.groupId !== parentId) return null;
  if (parent === 'trip'  && event.tripId  !== parentId) return null;
  if (event.status !== 'OPEN') return null;
  if (event.options.length < 2) return null;

  const hostUser = await prisma.user.findUnique({
    where: { id: hostId },
    select: { username: true },
  });
  if (!hostUser) return null;

  const sessionId = generateSessionId();
  const updated = await prisma.groupEvent.updateMany({
    where: { id: eventId, status: 'OPEN' },
    data:  { status: 'VOTING', sessionId },
  });
  if (updated.count === 0) return null;

  const candidates = event.options.map((o) => String(o.restaurantId));
  const restaurants: Record<string, RestaurantSnapshot> = {};
  for (const opt of event.options) {
    const r = opt.restaurant;
    // First photo only — keeps the SSE-broadcast session payload bounded.
    // Restaurant.photos is JSON; defensively re-shape since old rows may
    // pre-date the current { name, widthPx, heightPx } convention.
    let firstPhoto: SnapshotPhoto | null = null;
    if (Array.isArray(r.photos) && r.photos.length > 0) {
      const p = r.photos[0] as { name?: unknown; widthPx?: unknown; heightPx?: unknown };
      if (p && typeof p.name === 'string' && p.name.length > 0) {
        firstPhoto = {
          name: p.name,
          widthPx: typeof p.widthPx === 'number' ? p.widthPx : null,
          heightPx: typeof p.heightPx === 'number' ? p.heightPx : null,
        };
      }
    }
    restaurants[String(r.id)] = {
      name:  r.name,
      type:  r.cuisineType ?? 'Restaurant',
      price: r.priceLevel ?? 1,
      ...(firstPhoto ? { photos: [firstPhoto] } : {}),
    };
  }

  return createSession(
    hostId,
    hostUser.username,
    candidates,
    restaurants,
    parent === 'group' ? parentId : 0,
    eventId,
    event.scheduledFor?.toISOString() ?? null,
    event.voteMethod === 'RANKED' ? 'ranked' : 'simple',
    hostUser.username,
    parent === 'trip' ? parentId : 0,
    sessionId,
  );
}

// Drops any voter tokens + ballots held by the given user on parent's
// currently-VOTING sessions. Fire-and-forget per session — failures are
// non-fatal because the session TTL (~4h) is the worst-case backstop.
//
// Previously this only ran for trips (see the trip member-removal handler);
// groups had the same vulnerability but no cleanup. Unifying through this
// helper closes that drift.
export async function revokeVoterTokensForUserOnParent(
  parent: EventParent,
  parentId: number,
  targetUserId: number,
): Promise<void> {
  const where =
    parent === 'group'
      ? { groupId: parentId, status: 'VOTING' as const, sessionId: { not: null } }
      : { tripId:  parentId, status: 'VOTING' as const, sessionId: { not: null } };

  const activeEvents = await prisma.groupEvent.findMany({
    where,
    select: { sessionId: true },
  });

  for (const ev of activeEvents) {
    if (!ev.sessionId) continue;
    withSessionLock(ev.sessionId, async () => {
      const sess = await getSession(ev.sessionId!);
      if (!sess) return;
      const namesToDrop: string[] = [];
      for (const [name, meta] of Object.entries(sess.voterMeta ?? {})) {
        if (!meta) continue;
        if (meta.userId === targetUserId) namesToDrop.push(name);
      }
      if (namesToDrop.length === 0) return;
      for (const name of namesToDrop) {
        delete sess.voters[name];
        delete sess.rankings[name];
        delete sess.voterMeta[name];
        if (sess.voterTokens) delete sess.voterTokens[name];
        sess.submitted = sess.submitted.filter((n) => n !== name);
      }
      await saveSession(sess);
      notifyClients(sess.id, sess);
    }).catch(() => { /* non-fatal */ });
  }
}
