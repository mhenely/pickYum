import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimits';
import {
  createSession, getSession, generateSessionId, withSessionLock,
  saveSession, notifyClients,
  type RestaurantSnapshot,
} from '../sessions';

const router = Router();
router.use(requireAuth);
router.use(writeLimiter);

// ── Limits ────────────────────────────────────────────────────
// Field caps mirror the equivalents on Group / SavedAddress where they
// exist; the trip-specific ones (member/anchor counts) are set generously
// for normal trip sizes while keeping a runaway-input ceiling.
const MAX_TRIP_NAME_LEN        = 80;
const MAX_DESTINATION_LEN      = 200;
const MAX_ANCHOR_LABEL_LEN     = 64;
const MAX_ANCHOR_ADDRESS_LEN   = 256;
const MAX_MEMBERS_PER_TRIP     = 50;
const MAX_ANCHORS_PER_TRIP     = 10;
// Meal-event name cap mirrors the GroupEvent name cap in groups.ts so the UI
// can use a single shared "max 80 chars" hint across both contexts.
const MAX_EVENT_NAME_LEN       = 80;
const VALID_MEAL_SLOTS = ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'] as const;
type MealSlotInput = typeof VALID_MEAL_SLOTS[number];

const parseId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// ── Auth helper ───────────────────────────────────────────────
// Returns the trip with membership info for the requesting user in ONE
// query — mirrors checkGroupAuth in groups.ts. Used by every route below
// to enforce "must be a member" with a single round-trip and let the
// caller use the returned meta without re-querying.
type TripAuth = {
  trip: { id: number; hostId: number; archivedAt: Date | null } | null;
  isMember: boolean;
  isHost: boolean;
};

async function checkTripAuth(tripId: number, userId: number): Promise<TripAuth> {
  const row = await prisma.trip.findUnique({
    where: { id: tripId },
    select: {
      id: true,
      hostId: true,
      archivedAt: true,
      members: { where: { userId }, select: { userId: true } },
    },
  });
  if (!row) return { trip: null, isMember: false, isHost: false };
  const isHost = row.hostId === userId;
  return {
    trip: { id: row.id, hostId: row.hostId, archivedAt: row.archivedAt },
    isHost,
    // Host is always a member (also has a row in trip_members from
    // create-time, but we OR the flag in defensively).
    isMember: isHost || row.members.length > 0,
  };
}

// Creates a voting session for a trip meal event and atomically flips the
// event from OPEN → VOTING. Mirrors the pattern in groups.ts's launchVoting.
// Returns the new session or null if the event isn't startable (wrong status,
// too few options, racing concurrent caller). Used by:
//   - POST /:id/events/:eventId/start-voting (host manual start)
//   - GET  /:id (lazy auto-start for events past their votingStartsAt)
//
// Race-safety: same pattern as groups.ts. Pre-allocate the session id and
// claim it via an `updateMany` guarded on status='OPEN' BEFORE creating the
// Redis blob. The previous order (create-then-claim) leaked an orphan
// votable session for the full TTL whenever the on-read auto-launch sweeper
// and the manual /start-voting raced.
async function launchTripVoting(tripId: number, eventId: number, hostId: number) {
  const event = await prisma.groupEvent.findUnique({
    where: { id: eventId },
    include: { options: { include: { restaurant: true } } },
  });
  if (!event || event.tripId !== tripId || event.status !== 'OPEN') return null;
  if (event.options.length < 2) return null;

  // Host username is needed for voterMeta + the session's hostName field.
  // If the host's row has somehow vanished we bail out — the auto-start
  // call site will silently skip; the manual start route will 500 (which
  // is the appropriate signal for "host got deleted between request and
  // dispatch", a should-never-happen case).
  const hostUser = await prisma.user.findUnique({
    where: { id: hostId },
    select: { username: true },
  });
  if (!hostUser) return null;

  // Claim the session id atomically before creating it in storage. Lose
  // the race → bail; nothing in Redis to leak.
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
    restaurants[String(r.id)] = {
      name:  r.name,
      type:  r.cuisineType ?? 'Restaurant',
      price: r.priceLevel ?? 1,
    };
  }

  const session = await createSession(
    hostId,
    hostUser.username,
    candidates,
    restaurants,
    0,                                              // groupId — none for trip
    eventId,
    event.scheduledFor?.toISOString() ?? null,
    event.voteMethod === 'RANKED' ? 'ranked' : 'simple',
    hostUser.username,
    tripId,
    sessionId,                                      // preallocated to match DB claim
  );

  return session;
}

// Slim include for `GET /api/trips` — the list endpoint. The Trips landing
// page only renders host.username and the members count per card; loading
// every meal event with its options, voterMeta/restaurantPool blobs, and
// anchors for every trip just to render a list was the biggest payload
// waste in the audit. Power users with 4 active trips × 8 meals × 4 options
// were getting 50+ KB of unused data per /api/trips call.
//
// `_count` selects let Postgres do the COUNT(*) inline, no row data shipped.
// TripDetailPage still uses the full `tripInclude` below.
const tripListInclude = {
  host: { select: { id: true, username: true, avatarUrl: true } },
  // SearchPage's trip-override banner reads `anchors.find(a => a.isPrimary)`
  // to offer "search near {anchor.label}". A few hundred bytes per trip is
  // worth surfacing — the rest of the anchors stays in the detail endpoint.
  anchors: {
    select: { id: true, label: true, address: true, isPrimary: true },
    where:  { isPrimary: true },
  },
  _count: {
    select: {
      members: true,
      events:  true,
      anchors: true,
    },
  },
};

// Full include for trip detail / mutation responses. Same shape as the
// pre-split version; everything the TripDetailPage calendar + members
// section + anchors + invites needs to render in one pass.
const tripInclude = {
  host:    { select: { id: true, username: true, avatarUrl: true } },
  members: {
    select: {
      userId: true,
      joinedAt: true,
      user: { select: { id: true, username: true, avatarUrl: true } },
    },
    orderBy: { joinedAt: 'asc' as const },
  },
  anchors: {
    // Array literal NOT marked `as const` because Prisma's orderBy type
    // is a mutable array — the outer `as const` on tripInclude would
    // propagate readonly otherwise. Inner field literals are typed.
    orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }] as Prisma.TripAnchorOrderByWithRelationInput[],
  },
  invites: {
    // Pending invites only — accepted ones have been converted to
    // TripMember rows and declined ones are kept for audit but not
    // surfaced. Sorted oldest-first so the host sees the order they
    // were sent.
    where: { status: 'PENDING' as const },
    select: {
      id: true,
      invitedId: true,
      invitedById: true,
      status: true,
      createdAt: true,
      invited:   { select: { id: true, username: true, avatarUrl: true } },
      invitedBy: { select: { id: true, username: true, avatarUrl: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  // Meal events for this trip. We denormalize options + result inline so the
  // TripDetailPage calendar can render every meal card without a fan-out of
  // per-event GETs. Ordered earliest-scheduled-first (so the calendar reads
  // top-down chronologically) with createdAt as the tiebreaker for unscheduled
  // events. mealSlot ordering within a day happens client-side; sorting by
  // enum in Postgres requires a CASE expression that's clunkier than a JS sort.
  events: {
    include: {
      options: {
        include: {
          restaurant: { select: { id: true, name: true, cuisineType: true, priceLevel: true, address: true, lat: true, lng: true } },
          addedBy:    { select: { id: true, username: true } },
        },
      },
      createdBy: { select: { id: true, username: true } },
      result:    true,
    },
    orderBy: [
      { scheduledFor: 'asc' as const },
      { createdAt:    'asc' as const },
    ] as Prisma.GroupEventOrderByWithRelationInput[],
  },
};

// ── List ──────────────────────────────────────────────────────

// GET /api/trips — trips where the current user is host OR a member.
// Uses the slim `tripListInclude` (host + _count); TripDetailPage's
// `GET /:id` is where the full payload lives.
router.get('/', async (req: Request, res: Response) => {
  const [hosted, member] = await Promise.all([
    prisma.trip.findMany({
      where: { hostId: req.userId },
      include: tripListInclude,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.trip.findMany({
      where: {
        members: { some: { userId: req.userId } },
        NOT: { hostId: req.userId }, // exclude hosted trips already in the first query
      },
      include: tripListInclude,
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  res.json({ trips: [...hosted, ...member] });
});

// ── Create ────────────────────────────────────────────────────

// POST /api/trips
// Creates the trip, auto-adds the creator as a member. Anchors and
// additional members come via the dedicated endpoints below — keeps
// this payload small and the validation focused.
router.post('/', async (req: Request, res: Response) => {
  const { name, destination, startDate, endDate } = req.body as {
    name?: string;
    destination?: string;
    startDate?: string;
    endDate?: string;
  };

  const trimmedName        = typeof name        === 'string' ? name.trim()        : '';
  const trimmedDestination = typeof destination === 'string' ? destination.trim() : '';

  if (!trimmedName)                                       { res.status(400).json({ error: 'name is required' }); return; }
  if (trimmedName.length > MAX_TRIP_NAME_LEN)             { res.status(400).json({ error: `name must be ${MAX_TRIP_NAME_LEN} characters or fewer` }); return; }
  if (!trimmedDestination)                                { res.status(400).json({ error: 'destination is required' }); return; }
  if (trimmedDestination.length > MAX_DESTINATION_LEN)    { res.status(400).json({ error: `destination must be ${MAX_DESTINATION_LEN} characters or fewer` }); return; }

  // Date sanity: both optional, but if both set, end must not precede start.
  const start = startDate ? new Date(startDate) : null;
  const end   = endDate   ? new Date(endDate)   : null;
  if (start && Number.isNaN(start.getTime())) { res.status(400).json({ error: 'Invalid startDate' }); return; }
  if (end   && Number.isNaN(end.getTime()))   { res.status(400).json({ error: 'Invalid endDate' }); return; }
  if (start && end && end < start)            { res.status(400).json({ error: 'endDate cannot be before startDate' }); return; }

  // Create the trip + add host as first member in a single transaction
  // so we don't leave half-baked rows on partial failure.
  const trip = await prisma.$transaction(async (tx) => {
    const created = await tx.trip.create({
      data: {
        name: trimmedName,
        destination: trimmedDestination,
        startDate: start,
        endDate: end,
        hostId: req.userId,
      },
    });
    await tx.tripMember.create({ data: { tripId: created.id, userId: req.userId } });
    return tx.trip.findUnique({ where: { id: created.id }, include: tripInclude });
  });

  res.status(201).json({ trip });
});

// ── Single trip ───────────────────────────────────────────────

// GET /api/trips/:id
router.get('/:id', async (req: Request, res: Response) => {
  const tripId = parseId(req.params.id);
  if (!tripId) { res.status(400).json({ error: 'Invalid trip id' }); return; }

  const { trip: tripMeta, isMember } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this trip' }); return; }

  // Auto-launch any OPEN meal events whose votingStartsAt has passed. Mirrors
  // the groups.ts on-read sweeper — no background process, just opportunistic
  // start when someone loads the trip page. Skipped for archived trips so a
  // member browsing history doesn't trigger a fresh vote post-archive.
  if (!tripMeta.archivedAt) {
    // `?? []` is defensive against a Prisma test-double that doesn't
    // explicitly return an array; in production findMany always does.
    // Parallel launches — each is independent (different event id, no
    // row-level contention). Backed by composite index
    // group_events(trip_id, status, voting_starts_at).
    const overdue = (await prisma.groupEvent.findMany({
      where: { tripId, status: 'OPEN', votingStartsAt: { lte: new Date() } },
      select: { id: true },
    })) ?? [];
    if (overdue.length > 0) {
      await Promise.all(overdue.map((ev) => launchTripVoting(tripId, ev.id, tripMeta.hostId)));
    }
  }

  const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: tripInclude });
  res.json({ trip });
});

// PATCH /api/trips/:id — update name / destination / dates. Host only.
// Locked out once archived (read-only after the trip ends).
router.patch('/:id', async (req: Request, res: Response) => {
  const tripId = parseId(req.params.id);
  if (!tripId) { res.status(400).json({ error: 'Invalid trip id' }); return; }

  const { trip: tripMeta, isHost } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isHost)   { res.status(403).json({ error: 'Only the host can edit this trip' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived (read-only)' }); return; }

  const { name, destination, startDate, endDate } = req.body as {
    name?: string;
    destination?: string;
    startDate?: string | null;
    endDate?: string | null;
  };

  const data: Prisma.TripUpdateInput = {};
  if (typeof name === 'string') {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > MAX_TRIP_NAME_LEN) {
      res.status(400).json({ error: `name must be 1-${MAX_TRIP_NAME_LEN} characters` }); return;
    }
    data.name = trimmed;
  }
  if (typeof destination === 'string') {
    const trimmed = destination.trim();
    if (!trimmed || trimmed.length > MAX_DESTINATION_LEN) {
      res.status(400).json({ error: `destination must be 1-${MAX_DESTINATION_LEN} characters` }); return;
    }
    data.destination = trimmed;
  }
  if (startDate !== undefined) {
    const parsed = startDate ? new Date(startDate) : null;
    if (parsed && Number.isNaN(parsed.getTime())) { res.status(400).json({ error: 'Invalid startDate' }); return; }
    data.startDate = parsed;
  }
  if (endDate !== undefined) {
    const parsed = endDate ? new Date(endDate) : null;
    if (parsed && Number.isNaN(parsed.getTime())) { res.status(400).json({ error: 'Invalid endDate' }); return; }
    data.endDate = parsed;
  }

  const trip = await prisma.trip.update({ where: { id: tripId }, data, include: tripInclude });
  res.json({ trip });
});

// POST /api/trips/:id/archive — soft-deletes the trip (host only). The
// row stays so members can still browse meal results; everything else
// becomes read-only.
router.post('/:id/archive', async (req: Request, res: Response) => {
  const tripId = parseId(req.params.id);
  if (!tripId) { res.status(400).json({ error: 'Invalid trip id' }); return; }

  const { trip: tripMeta, isHost } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isHost)   { res.status(403).json({ error: 'Only the host can archive this trip' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is already archived' }); return; }

  const trip = await prisma.trip.update({
    where: { id: tripId },
    data: { archivedAt: new Date() },
    include: tripInclude,
  });
  res.json({ trip });
});

// ── Members ───────────────────────────────────────────────────

// POST /api/trips/:id/invites — host sends a PENDING invite by username.
// Replaces the previous direct-add behavior: the invited user must
// accept before becoming a member. Idempotent for existing pending
// invites; re-invites declined ones by flipping status back to PENDING.
router.post('/:id/invites', async (req: Request, res: Response) => {
  const tripId = parseId(req.params.id);
  if (!tripId) { res.status(400).json({ error: 'Invalid trip id' }); return; }

  const { trip: tripMeta, isHost } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isHost)   { res.status(403).json({ error: 'Only the host can invite members' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  const { username } = req.body as { username?: string };
  if (typeof username !== 'string' || !username.trim()) {
    res.status(400).json({ error: 'username is required' }); return;
  }

  // username column is citext — case-insensitive equality via unique index.
  const targetUser = await prisma.user.findFirst({
    where: { username: { equals: username.trim() } },
    select: { id: true, username: true, avatarUrl: true },
  });
  if (!targetUser) { res.status(404).json({ error: 'User not found' }); return; }
  if (targetUser.id === req.userId) {
    res.status(400).json({ error: 'You are already on this trip' }); return;
  }

  // Already a member? Surface a friendly message rather than a generic
  // "no-op" — calling this for a current member is a UI-side mistake.
  const memberExisting = await prisma.tripMember.findUnique({
    where: { tripId_userId: { tripId, userId: targetUser.id } },
  });
  if (memberExisting) {
    res.status(409).json({ error: 'That user is already a member of this trip' }); return;
  }

  // Member-count cap applies to pending invites too (we don't want a
  // host to send 100 invites at a 50-member cap).
  const [memberCount, pendingCount] = await Promise.all([
    prisma.tripMember.count({ where: { tripId } }),
    prisma.tripInvite.count({ where: { tripId, status: 'PENDING' } }),
  ]);
  if (memberCount + pendingCount >= MAX_MEMBERS_PER_TRIP) {
    res.status(400).json({ error: `Trip is limited to ${MAX_MEMBERS_PER_TRIP} members (counting pending invites)` }); return;
  }

  // Upsert pattern: if an invite already exists (any status), flip it
  // back to PENDING. This lets the host re-invite someone who previously
  // declined without hitting a 409.
  const invite = await prisma.tripInvite.upsert({
    where: { tripId_invitedId: { tripId, invitedId: targetUser.id } },
    create: { tripId, invitedId: targetUser.id, invitedById: req.userId, status: 'PENDING' },
    update: { status: 'PENDING', invitedById: req.userId },
  });

  const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: tripInclude });
  res.status(201).json({ trip, invite });
});

// POST /api/trips/:id/invites/import-from-group — bulk-invite every
// member of the named group. Caller must be a member of the source
// group (prevents using trip-host position to enumerate group rosters).
router.post('/:id/invites/import-from-group', async (req: Request, res: Response) => {
  const tripId = parseId(req.params.id);
  if (!tripId) { res.status(400).json({ error: 'Invalid trip id' }); return; }

  const { trip: tripMeta, isHost } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isHost)   { res.status(403).json({ error: 'Only the host can invite members' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  const { groupId } = req.body as { groupId?: number };
  if (!Number.isInteger(groupId) || (groupId as number) <= 0) {
    res.status(400).json({ error: 'groupId is required' }); return;
  }

  // Source-group access check.
  const group = await prisma.group.findUnique({
    where: { id: groupId as number },
    select: { hostId: true, members: { select: { userId: true } } },
  });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  const isInGroup = group.hostId === req.userId || group.members.some((m) => m.userId === req.userId);
  if (!isInGroup) { res.status(403).json({ error: 'You are not a member of that group' }); return; }

  // Build the candidate list, skip the trip host + existing members + already-pending invitees.
  const groupUserIds = new Set<number>([group.hostId, ...group.members.map((m) => m.userId)]);
  groupUserIds.delete(req.userId);  // host is already on the trip

  const [existingMembers, pendingInvites] = await Promise.all([
    prisma.tripMember.findMany({ where: { tripId }, select: { userId: true } }),
    prisma.tripInvite.findMany({ where: { tripId, status: 'PENDING' }, select: { invitedId: true } }),
  ]);
  const skipSet = new Set<number>([
    ...existingMembers.map((m) => m.userId),
    ...pendingInvites.map((i) => i.invitedId),
  ]);

  const toInvite = [...groupUserIds].filter((id) => !skipSet.has(id));
  const room    = MAX_MEMBERS_PER_TRIP - (existingMembers.length + pendingInvites.length);
  const limited = toInvite.slice(0, Math.max(0, room));

  let invited = 0;
  if (limited.length > 0) {
    // Two-step batch instead of N parallel upserts:
    //   1. `createMany({ skipDuplicates })` covers the common case where
    //      every invitee is a net-new row — one INSERT, one round-trip.
    //   2. `updateMany({ status: 'DECLINED' })` then flips any rows that
    //      already existed back to PENDING — covers re-invitation of
    //      previously declined users in one UPDATE. ACCEPTED rows are
    //      left alone (those users are already trip members, filtered
    //      out above via `existingMembers`).
    // Was N parallel upserts saturating the Prisma pool (default 5-10) and
    // queueing serially. createMany supports skipDuplicates on the unique
    // (tripId, invitedId) constraint.
    await prisma.tripInvite.createMany({
      data: limited.map((invitedId) => ({
        tripId, invitedId, invitedById: req.userId, status: 'PENDING' as const,
      })),
      skipDuplicates: true,
    });
    await prisma.tripInvite.updateMany({
      where: { tripId, invitedId: { in: limited }, status: 'DECLINED' },
      data:  { status: 'PENDING', invitedById: req.userId },
    });
    invited = limited.length;
  }

  const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: tripInclude });
  res.json({ trip, invited, skipped: toInvite.length - limited.length });
});

// DELETE /api/trips/:id/invites/:inviteId — host rescinds a pending
// invite. Always-200 even if the row was already gone (idempotent).
router.delete('/:id/invites/:inviteId', async (req: Request, res: Response) => {
  const tripId   = parseId(req.params.id);
  const inviteId = parseId(req.params.inviteId);
  if (!tripId || !inviteId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { trip: tripMeta, isHost } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isHost)   { res.status(403).json({ error: 'Only the host can rescind invites' }); return; }

  await prisma.tripInvite.deleteMany({ where: { id: inviteId, tripId } });
  const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: tripInclude });
  res.json({ trip });
});

// POST /api/trips/:id/invites/:inviteId/respond — invitee accepts or
// declines. Accept atomically converts the invite into a TripMember row.
router.post('/:id/invites/:inviteId/respond', async (req: Request, res: Response) => {
  const tripId   = parseId(req.params.id);
  const inviteId = parseId(req.params.inviteId);
  if (!tripId || !inviteId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { action } = req.body as { action?: string };
  if (action !== 'accept' && action !== 'decline') {
    res.status(400).json({ error: 'action must be "accept" or "decline"' }); return;
  }

  // Verify the invite exists, is for THIS user, and is still PENDING.
  // 404 (rather than 403) so a fishing probe can't enumerate ids.
  const invite = await prisma.tripInvite.findUnique({ where: { id: inviteId } });
  if (!invite || invite.tripId !== tripId || invite.invitedId !== req.userId) {
    res.status(404).json({ error: 'Invite not found' }); return;
  }
  if (invite.status !== 'PENDING') {
    res.status(400).json({ error: 'This invite has already been responded to' }); return;
  }

  // Check the trip wasn't archived between invite-send and accept.
  const trip = await prisma.trip.findUnique({ where: { id: tripId }, select: { archivedAt: true } });
  if (!trip) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (trip.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  if (action === 'decline') {
    await prisma.tripInvite.update({ where: { id: inviteId }, data: { status: 'DECLINED' } });
    res.json({ message: 'Invite declined' });
    return;
  }

  // Accept path: mark accepted + create membership in one transaction.
  await prisma.$transaction([
    prisma.tripInvite.update({ where: { id: inviteId }, data: { status: 'ACCEPTED' } }),
    prisma.tripMember.create({ data: { tripId, userId: req.userId } }),
  ]);
  const accepted = await prisma.trip.findUnique({ where: { id: tripId }, include: tripInclude });
  res.json({ trip: accepted });
});

// GET /api/trips/me/invites — pending invites for the current user.
// Used by the navbar notifications bell + the Trips landing page.
router.get('/me/invites', async (req: Request, res: Response) => {
  const invites = await prisma.tripInvite.findMany({
    where: { invitedId: req.userId, status: 'PENDING' },
    select: {
      id: true,
      tripId: true,
      createdAt: true,
      trip: { select: { id: true, name: true, destination: true } },
      invitedBy: { select: { id: true, username: true, avatarUrl: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ invites });
});

// DELETE /api/trips/:id/members/:userId — host removes a member, or a
// member removes themselves (leave). Host can't remove themselves; they
// must archive the trip or (future) transfer host first.
router.delete('/:id/members/:userId', async (req: Request, res: Response) => {
  const tripId   = parseId(req.params.id);
  const targetId = parseId(req.params.userId);
  if (!tripId || !targetId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { trip: tripMeta, isHost, isMember } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this trip' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  // A non-host can only remove themselves. The host can remove anyone
  // except themselves.
  if (targetId === tripMeta.hostId) {
    res.status(400).json({ error: 'Host cannot be removed; archive the trip instead' }); return;
  }
  if (targetId !== req.userId && !isHost) {
    res.status(403).json({ error: 'Only the host can remove other members' }); return;
  }

  await prisma.tripMember.deleteMany({ where: { tripId, userId: targetId } });

  // Revoke any active voter tokens the removed user holds on this trip's
  // currently-voting meals. Without this, the removed member retains a
  // working ballot — the trip-membership check at /join runs only on join,
  // not on /vote, so their already-issued voterToken keeps working until
  // the session TTLs (~4h). We can't reliably map auth user → display name
  // without the session's voterMeta, so we open each active session under
  // its lock and drop any voter entries whose userId matches.
  const activeEvents = await prisma.groupEvent.findMany({
    where:  { tripId, status: 'VOTING', sessionId: { not: null } },
    select: { sessionId: true },
  });
  for (const ev of activeEvents) {
    if (!ev.sessionId) continue;
    // Fire-and-forget per session — failure here shouldn't block the member
    // removal response. The session TTL is the worst-case fallback.
    withSessionLock(ev.sessionId, async () => {
      const sess = await getSession(ev.sessionId!);
      if (!sess) return;
      const namesToDrop: string[] = [];
      for (const [name, meta] of Object.entries(sess.voterMeta ?? {})) {
        if (!meta) continue;
        if (meta.userId === targetId) namesToDrop.push(name);
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
    }).catch(() => { /* non-fatal; logs already captured upstream */ });
  }

  // For a member leaving, return 204 (no body); for a host removing
  // someone, return the updated trip so the host's UI can re-render.
  if (targetId === req.userId && !isHost) {
    res.status(204).end();
    return;
  }
  const trip = await prisma.trip.findUnique({ where: { id: tripId }, include: tripInclude });
  res.json({ trip });
});

// ── Anchors ───────────────────────────────────────────────────
// Map-anchor locations within the trip (hotel, conference, etc.). Used
// to seed restaurant searches in phase 2 and to power the Search-page
// banner override in phase 4.

// POST /api/trips/:id/anchors — host only. First anchor auto-becomes
// primary; setting isPrimary on a later anchor demotes the current
// primary atomically (mirrors SavedAddress "default" semantics).
router.post('/:id/anchors', async (req: Request, res: Response) => {
  const tripId = parseId(req.params.id);
  if (!tripId) { res.status(400).json({ error: 'Invalid trip id' }); return; }

  const { trip: tripMeta, isHost } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isHost)   { res.status(403).json({ error: 'Only the host can manage anchors' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  const { label, address, isPrimary } = req.body as { label?: string; address?: string; isPrimary?: boolean };
  const trimmedLabel   = typeof label   === 'string' ? label.trim()   : '';
  const trimmedAddress = typeof address === 'string' ? address.trim() : '';

  if (!trimmedLabel)                                      { res.status(400).json({ error: 'label is required' }); return; }
  if (!trimmedAddress)                                    { res.status(400).json({ error: 'address is required' }); return; }
  if (trimmedLabel.length   > MAX_ANCHOR_LABEL_LEN)       { res.status(400).json({ error: `label must be ${MAX_ANCHOR_LABEL_LEN} characters or fewer` }); return; }
  if (trimmedAddress.length > MAX_ANCHOR_ADDRESS_LEN)     { res.status(400).json({ error: `address must be ${MAX_ANCHOR_ADDRESS_LEN} characters or fewer` }); return; }

  const count = await prisma.tripAnchor.count({ where: { tripId } });
  if (count >= MAX_ANCHORS_PER_TRIP) {
    res.status(400).json({ error: `Trip is limited to ${MAX_ANCHORS_PER_TRIP} anchors` }); return;
  }

  // Promote rules: first anchor auto-primary; explicit isPrimary=true
  // demotes any existing primary first.
  const willBePrimary = isPrimary === true || count === 0;
  try {
    const created = await prisma.$transaction(async (tx) => {
      if (willBePrimary) {
        await tx.tripAnchor.updateMany({
          where: { tripId, isPrimary: true },
          data:  { isPrimary: false },
        });
      }
      return tx.tripAnchor.create({
        data: { tripId, label: trimmedLabel, address: trimmedAddress, isPrimary: willBePrimary },
      });
    });
    res.status(201).json({ anchor: created });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      res.status(409).json({ error: 'An anchor with that label already exists for this trip' });
      return;
    }
    throw err;
  }
});

// PATCH /api/trips/:id/anchors/:anchorId — host only.
router.patch('/:id/anchors/:anchorId', async (req: Request, res: Response) => {
  const tripId   = parseId(req.params.id);
  const anchorId = parseId(req.params.anchorId);
  if (!tripId || !anchorId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { trip: tripMeta, isHost } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isHost)   { res.status(403).json({ error: 'Only the host can manage anchors' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  const existing = await prisma.tripAnchor.findUnique({ where: { id: anchorId } });
  if (!existing || existing.tripId !== tripId) {
    res.status(404).json({ error: 'Anchor not found' }); return;
  }

  const { label, address, isPrimary } = req.body as { label?: string; address?: string; isPrimary?: boolean };
  const data: Prisma.TripAnchorUpdateInput = {};
  if (typeof label === 'string') {
    const trimmed = label.trim();
    if (!trimmed || trimmed.length > MAX_ANCHOR_LABEL_LEN) {
      res.status(400).json({ error: `label must be 1-${MAX_ANCHOR_LABEL_LEN} characters` }); return;
    }
    data.label = trimmed;
  }
  if (typeof address === 'string') {
    const trimmed = address.trim();
    if (!trimmed || trimmed.length > MAX_ANCHOR_ADDRESS_LEN) {
      res.status(400).json({ error: `address must be 1-${MAX_ANCHOR_ADDRESS_LEN} characters` }); return;
    }
    data.address = trimmed;
  }

  const promotingToPrimary = isPrimary === true && !existing.isPrimary;
  if (isPrimary === true) data.isPrimary = true;
  if (isPrimary === false && existing.isPrimary) {
    res.status(400).json({ error: 'Set another anchor as primary instead of clearing this one' });
    return;
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (promotingToPrimary) {
        await tx.tripAnchor.updateMany({
          where: { tripId, isPrimary: true, NOT: { id: anchorId } },
          data:  { isPrimary: false },
        });
      }
      return tx.tripAnchor.update({ where: { id: anchorId }, data });
    });
    res.json({ anchor: updated });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      res.status(409).json({ error: 'An anchor with that label already exists for this trip' });
      return;
    }
    throw err;
  }
});

// DELETE /api/trips/:id/anchors/:anchorId — host only. Auto-promotes
// the oldest remaining anchor to primary if the deleted one was.
router.delete('/:id/anchors/:anchorId', async (req: Request, res: Response) => {
  const tripId   = parseId(req.params.id);
  const anchorId = parseId(req.params.anchorId);
  if (!tripId || !anchorId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { trip: tripMeta, isHost } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isHost)   { res.status(403).json({ error: 'Only the host can manage anchors' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  const existing = await prisma.tripAnchor.findUnique({ where: { id: anchorId } });
  if (!existing || existing.tripId !== tripId) {
    res.status(404).json({ error: 'Anchor not found' }); return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.tripAnchor.delete({ where: { id: anchorId } });
    if (existing.isPrimary) {
      const next = await tx.tripAnchor.findFirst({
        where: { tripId },
        orderBy: { createdAt: 'asc' },
      });
      if (next) await tx.tripAnchor.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
  });

  res.json({ message: 'Anchor deleted' });
});

// ── Meal events ───────────────────────────────────────────────
// A trip meal event is a row in `group_events` with tripId set and groupId
// null (see schema comment on GroupEvent for the polymorphism rationale).
// Voting reuses the entire session machinery in sessions.ts — only the
// parent context differs. accept-result mirrors the group flow but skips
// member-acceptance writes for the trip case (those are group-scoped
// "personal Insights" entries — we don't surface a trip equivalent yet).

// Shared include shape for a meal event response (mirrors what tripInclude
// pulls inline, but as a top-level field). Centralized so list/create/update
// responses all return the same denormalized event row.
const mealEventInclude = {
  options: {
    include: {
      restaurant: { select: { id: true, name: true, cuisineType: true, priceLevel: true, address: true, lat: true, lng: true } },
      addedBy:    { select: { id: true, username: true } },
    },
  },
  createdBy: { select: { id: true, username: true } },
  result:    true,
};

// POST /api/trips/:id/events — create a meal event. Any trip member can.
// Mirrors `POST /api/groups/:id/events`; trip-specific fields (mealSlot,
// scheduledFor, participantUserIds) are optional in the create payload.
router.post('/:id/events', async (req: Request, res: Response) => {
  const tripId = parseId(req.params.id);
  if (!tripId) { res.status(400).json({ error: 'Invalid trip id' }); return; }

  const { trip: tripMeta, isMember } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this trip' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  const { name, scheduledFor, mealSlot, participantUserIds } = req.body as {
    name?: string;
    scheduledFor?: string | null;
    mealSlot?: string | null;
    participantUserIds?: number[];
  };

  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' }); return;
  }
  const trimmedName = name.trim();
  if (trimmedName.length > MAX_EVENT_NAME_LEN) {
    res.status(400).json({ error: `name must be ${MAX_EVENT_NAME_LEN} characters or fewer` }); return;
  }

  let parsedScheduled: Date | null = null;
  if (scheduledFor) {
    const t = Date.parse(scheduledFor);
    if (isNaN(t)) { res.status(400).json({ error: 'Invalid scheduledFor' }); return; }
    parsedScheduled = new Date(t);
  }

  let parsedMealSlot: MealSlotInput | null = null;
  if (mealSlot != null) {
    if (typeof mealSlot !== 'string' || !VALID_MEAL_SLOTS.includes(mealSlot.toUpperCase() as MealSlotInput)) {
      res.status(400).json({ error: 'Invalid mealSlot' }); return;
    }
    parsedMealSlot = mealSlot.toUpperCase() as MealSlotInput;
  }

  // Validate participants if supplied: must be members of this trip. The
  // creator can omit the field to mean "everyone", which we represent as
  // an empty array (also the column default). Sanitize to unique ints.
  let participants: number[] = [];
  if (Array.isArray(participantUserIds) && participantUserIds.length > 0) {
    const cleaned = [...new Set(participantUserIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const memberRows = await prisma.tripMember.findMany({
      where: { tripId, userId: { in: cleaned } },
      select: { userId: true },
    });
    const validIds = new Set(memberRows.map((r) => r.userId));
    // Trip host is technically a member too — checkTripAuth treats them as one
    // — but they may or may not have a row in trip_members (always do, per
    // the create transaction). Validating purely via tripMember is correct.
    participants = cleaned.filter((id) => validIds.has(id));
    if (participants.length !== cleaned.length) {
      res.status(400).json({ error: 'One or more participantUserIds are not trip members' }); return;
    }
  }

  const event = await prisma.groupEvent.create({
    data: {
      tripId,
      name: trimmedName,
      scheduledFor: parsedScheduled,
      mealSlot: parsedMealSlot,
      participantUserIds: participants,
      createdById: req.userId,
    },
    include: mealEventInclude,
  });
  res.status(201).json({ event });
});

// PATCH /api/trips/:id/events/:eventId — update fields on a meal event.
// Editable while still OPEN; the host or original creator may edit. Mirrors
// how groups handle event creator-vs-host permissions.
router.patch('/:id/events/:eventId', async (req: Request, res: Response) => {
  const tripId  = parseId(req.params.id);
  const eventId = parseId(req.params.eventId);
  if (!tripId || !eventId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { trip: tripMeta, isMember, isHost } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this trip' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  const existing = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!existing || existing.tripId !== tripId) {
    res.status(404).json({ error: 'Event not found' }); return;
  }
  if (!isHost && existing.createdById !== req.userId) {
    res.status(403).json({ error: 'Only the trip host or the event creator can edit this' }); return;
  }
  if (existing.status !== 'OPEN') {
    res.status(400).json({ error: 'Cannot edit a meal that is already voting or done' }); return;
  }

  const { name, scheduledFor, mealSlot, participantUserIds } = req.body as {
    name?: string;
    scheduledFor?: string | null;
    mealSlot?: string | null;
    participantUserIds?: number[];
  };

  const data: Prisma.GroupEventUpdateInput = {};

  if (typeof name === 'string') {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > MAX_EVENT_NAME_LEN) {
      res.status(400).json({ error: `name must be 1-${MAX_EVENT_NAME_LEN} characters` }); return;
    }
    data.name = trimmed;
  }
  if (scheduledFor !== undefined) {
    if (scheduledFor === null) {
      data.scheduledFor = null;
    } else {
      const t = Date.parse(scheduledFor);
      if (isNaN(t)) { res.status(400).json({ error: 'Invalid scheduledFor' }); return; }
      data.scheduledFor = new Date(t);
    }
  }
  if (mealSlot !== undefined) {
    if (mealSlot === null) {
      data.mealSlot = null;
    } else if (typeof mealSlot === 'string' && VALID_MEAL_SLOTS.includes(mealSlot.toUpperCase() as MealSlotInput)) {
      data.mealSlot = mealSlot.toUpperCase() as MealSlotInput;
    } else {
      res.status(400).json({ error: 'Invalid mealSlot' }); return;
    }
  }
  if (Array.isArray(participantUserIds)) {
    const cleaned = [...new Set(participantUserIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (cleaned.length > 0) {
      const memberRows = await prisma.tripMember.findMany({
        where: { tripId, userId: { in: cleaned } },
        select: { userId: true },
      });
      const validIds = new Set(memberRows.map((r) => r.userId));
      if (cleaned.some((id) => !validIds.has(id))) {
        res.status(400).json({ error: 'One or more participantUserIds are not trip members' }); return;
      }
    }
    data.participantUserIds = { set: cleaned };
  }

  const event = await prisma.groupEvent.update({
    where: { id: eventId },
    data,
    include: mealEventInclude,
  });
  res.json({ event });
});

// DELETE /api/trips/:id/events/:eventId — only the host or the original
// creator can delete, and only while still OPEN. (Trip-wide "I made a
// mistake" cleanup; once voting starts, cancel-voting first.)
router.delete('/:id/events/:eventId', async (req: Request, res: Response) => {
  const tripId  = parseId(req.params.id);
  const eventId = parseId(req.params.eventId);
  if (!tripId || !eventId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { trip: tripMeta, isMember, isHost } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this trip' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.tripId !== tripId) {
    res.status(404).json({ error: 'Event not found' }); return;
  }
  if (!isHost && event.createdById !== req.userId) {
    res.status(403).json({ error: 'Only the trip host or the event creator can delete this' }); return;
  }
  if (event.status === 'VOTING') {
    res.status(400).json({ error: 'Cancel voting before deleting this event' }); return;
  }

  await prisma.groupEvent.delete({ where: { id: eventId } });
  res.json({ message: 'Event deleted' });
});

// POST /api/trips/:id/events/:eventId/options — add a restaurant to the pool.
// Any trip member can. Privacy semantics match groups: a private restaurant
// can only be shared in by its creator; sharing implicitly publishes it.
router.post('/:id/events/:eventId/options', async (req: Request, res: Response) => {
  const tripId  = parseId(req.params.id);
  const eventId = parseId(req.params.eventId);
  if (!tripId || !eventId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { trip: tripMeta, isMember } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this trip' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.tripId !== tripId) {
    res.status(404).json({ error: 'Event not found' }); return;
  }
  if (event.status !== 'OPEN') {
    res.status(400).json({ error: 'Options are locked — voting has started' }); return;
  }

  const { restaurantId } = req.body as { restaurantId?: number };
  if (!restaurantId) { res.status(400).json({ error: 'restaurantId is required' }); return; }

  const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant || (restaurant.private && restaurant.createdBy !== req.userId)) {
    res.status(404).json({ error: 'Restaurant not found' }); return;
  }
  if (restaurant.private && restaurant.createdBy === req.userId) {
    await prisma.restaurant.update({ where: { id: restaurantId }, data: { private: false } });
  }

  const option = await prisma.groupEventOption.upsert({
    where:  { eventId_restaurantId: { eventId, restaurantId } },
    create: { eventId, restaurantId, addedById: req.userId },
    update: {},
    include: {
      restaurant: true,
      addedBy:    { select: { id: true, username: true } },
    },
  });
  res.status(201).json({ option });
});

// DELETE /api/trips/:id/events/:eventId/options/:restaurantId — remove an
// option. Removable by: the host, the member who added it, OR any member
// when the adder has left. Mirrors the group rule.
router.delete('/:id/events/:eventId/options/:restaurantId', async (req: Request, res: Response) => {
  const tripId       = parseId(req.params.id);
  const eventId      = parseId(req.params.eventId);
  const restaurantId = parseId(req.params.restaurantId);
  if (!tripId || !eventId || !restaurantId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { trip: tripMeta, isMember, isHost } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this trip' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.tripId !== tripId) {
    res.status(404).json({ error: 'Event not found' }); return;
  }
  if (event.status !== 'OPEN') {
    res.status(400).json({ error: 'Options are locked — voting has started' }); return;
  }

  const option = await prisma.groupEventOption.findUnique({
    where: { eventId_restaurantId: { eventId, restaurantId } },
  });

  const isOwnOption = option?.addedById === req.userId;

  // "Orphan adder" fallback: if the user who added this option has left the
  // trip, any current member can clean it up so the option doesn't get stuck.
  // Host is always considered present.
  let adderStillInTrip = true;
  if (option && !isHost && !isOwnOption) {
    if (option.addedById === tripMeta.hostId) {
      adderStillInTrip = true;
    } else {
      const adderMembership = await prisma.tripMember.findUnique({
        where: { tripId_userId: { tripId, userId: option.addedById } },
      });
      adderStillInTrip = !!adderMembership;
    }
  }

  if (option && !isHost && !isOwnOption && adderStillInTrip) {
    res.status(403).json({
      error: 'Only the host or the member who added this option can remove it',
    });
    return;
  }

  await prisma.groupEventOption.deleteMany({ where: { eventId, restaurantId } });
  res.json({ message: 'Option removed' });
});

// PATCH /api/trips/:id/events/:eventId/vote-method — set SIMPLE or RANKED.
// Locked once voting starts; host-or-creator only (same as edit).
router.patch('/:id/events/:eventId/vote-method', async (req: Request, res: Response) => {
  const tripId  = parseId(req.params.id);
  const eventId = parseId(req.params.eventId);
  if (!tripId || !eventId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { trip: tripMeta, isMember, isHost } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this trip' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.tripId !== tripId) {
    res.status(404).json({ error: 'Event not found' }); return;
  }
  if (!isHost && event.createdById !== req.userId) {
    res.status(403).json({ error: 'Only the trip host or the event creator can change vote method' }); return;
  }
  if (event.status !== 'OPEN') {
    res.status(400).json({ error: 'Vote method is locked once voting has started' }); return;
  }

  const { voteMethod } = req.body as { voteMethod?: string };
  if (voteMethod !== 'SIMPLE' && voteMethod !== 'RANKED') {
    res.status(400).json({ error: 'voteMethod must be SIMPLE or RANKED' }); return;
  }

  const updated = await prisma.groupEvent.update({
    where: { id: eventId },
    data:  { voteMethod },
  });
  res.json({ voteMethod: updated.voteMethod });
});

// POST /api/trips/:id/events/:eventId/start-voting — host opens the vote.
// Delegates to launchTripVoting() so this manual start and the auto-start
// in GET /:id share their implementation. GroupSessionPage on the frontend
// handles both group and trip contexts uniformly.
router.post('/:id/events/:eventId/start-voting', async (req: Request, res: Response) => {
  const tripId  = parseId(req.params.id);
  const eventId = parseId(req.params.eventId);
  if (!tripId || !eventId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { trip: tripMeta, isHost } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isHost)   { res.status(403).json({ error: 'Only the host can start voting' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  // Pre-flight validation so callers get a specific 400 rather than a
  // generic "couldn't start". launchTripVoting returns null for all of
  // these too, but the helper can't distinguish "wrong event id" from
  // "raced concurrent caller" for the response message.
  const event = await prisma.groupEvent.findUnique({
    where: { id: eventId },
    select: { tripId: true, status: true, options: { select: { id: true } } },
  });
  if (!event || event.tripId !== tripId) {
    res.status(404).json({ error: 'Event not found' }); return;
  }
  if (event.status !== 'OPEN') {
    res.status(400).json({ error: 'Voting has already started for this event' }); return;
  }
  if (event.options.length < 2) {
    res.status(400).json({ error: 'Need at least 2 restaurants to start voting' }); return;
  }

  const session = await launchTripVoting(tripId, eventId, tripMeta.hostId);
  if (!session) {
    // launchTripVoting returns null on race or missing host — surface the
    // race as 400 (the most common cause when we got past pre-flight).
    res.status(400).json({ error: 'Voting has already started for this event' }); return;
  }

  res.json({ sessionId: session.id });
});

// PATCH /api/trips/:id/events/:eventId/schedule — host sets (or clears)
// votingStartsAt, the time at which the on-read sweeper in GET /:id will
// auto-open the vote. Locked once the event leaves OPEN. Mirrors the
// corresponding group endpoint so /trips and /groups have the same shape.
router.patch('/:id/events/:eventId/schedule', async (req: Request, res: Response) => {
  const tripId  = parseId(req.params.id);
  const eventId = parseId(req.params.eventId);
  if (!tripId || !eventId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { trip: tripMeta, isHost } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isHost)   { res.status(403).json({ error: 'Only the host can set the schedule' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.tripId !== tripId) {
    res.status(404).json({ error: 'Event not found' }); return;
  }
  if (event.status !== 'OPEN') {
    res.status(400).json({ error: 'Cannot reschedule after voting has started' }); return;
  }

  const { votingStartsAt } = req.body as { votingStartsAt?: string | null };
  let newTime: Date | null = null;
  if (votingStartsAt) {
    const parsed = Date.parse(votingStartsAt);
    if (isNaN(parsed)) { res.status(400).json({ error: 'Invalid date format' }); return; }
    newTime = new Date(parsed);
    if (newTime <= new Date()) {
      res.status(400).json({ error: 'Schedule must be set to a future time' }); return;
    }
  }

  const updated = await prisma.groupEvent.update({
    where: { id: eventId },
    data:  { votingStartsAt: newTime },
  });
  res.json({ votingStartsAt: updated.votingStartsAt });
});

// POST /api/trips/:id/events/:eventId/cancel-voting — host resets a VOTING
// event back to OPEN. Used when "we changed our minds, restart the vote".
router.post('/:id/events/:eventId/cancel-voting', async (req: Request, res: Response) => {
  const tripId  = parseId(req.params.id);
  const eventId = parseId(req.params.eventId);
  if (!tripId || !eventId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { trip: tripMeta, isHost } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isHost)   { res.status(403).json({ error: 'Only the host can cancel voting' }); return; }
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.tripId !== tripId) {
    res.status(404).json({ error: 'Event not found' }); return;
  }
  if (event.status !== 'VOTING') {
    res.status(400).json({ error: 'Event is not currently voting' }); return;
  }

  await prisma.groupEvent.update({
    where: { id: eventId },
    data:  { status: 'OPEN', sessionId: null },
  });
  res.json({ message: 'Voting canceled' });
});

// POST /api/trips/:id/events/:eventId/accept-result — host finalizes the
// vote outcome and persists it to GroupEventResult. Mirrors the group
// flow with trip-specific tweaks: no UserAccepted writes (those are
// group-specific personal Insights entries we don't surface for trips yet).
// Wrapped in withSessionLock so concurrent accept-result calls (host
// double-tap / network retry) can't both fall through the status check
// and write to GroupEventResult / GroupEvent. The second caller acquires
// the lock after the first commits, sees status='DONE' on re-read, and
// returns the idempotent "already concluded" branch.
router.post('/:id/events/:eventId/accept-result', async (req: Request, res: Response) => {
  const tripId  = parseId(req.params.id);
  const eventId = parseId(req.params.eventId);
  if (!tripId || !eventId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { trip: tripMeta, isHost } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isHost)   { res.status(403).json({ error: 'Only the host can close the event' }); return; }
  // Mirror the archive guard now on every other host-only trip route.
  // Without it, a host who archived the trip mid-vote could still finalize
  // the result — drifting from the documented "archived = read-only" model.
  if (tripMeta.archivedAt) { res.status(400).json({ error: 'Trip is archived' }); return; }

  // Pre-lock read so we know the sessionId to lock on; the real status
  // check happens inside the lock to catch a concurrent race.
  const preEvent = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!preEvent || preEvent.tripId !== tripId) {
    res.status(404).json({ error: 'Event not found' }); return;
  }
  if (preEvent.status === 'DONE') { res.json({ message: 'Event already concluded' }); return; }
  if (preEvent.status !== 'VOTING' || !preEvent.sessionId) {
    res.status(400).json({ error: 'Event is not in voting state' }); return;
  }

  type LockResult =
    | { status: 200; body: { message: string } }
    | { status: 400; body: { error: string } };

  const result: LockResult = await withSessionLock(preEvent.sessionId, async () => {
    // Re-check inside the lock.
    const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
    if (!event || event.status === 'DONE') {
      return { status: 200, body: { message: 'Event already concluded' } };
    }
    if (event.status !== 'VOTING' || !event.sessionId) {
      return { status: 400, body: { error: 'Event is not in voting state' } };
    }

    const session = await getSession(event.sessionId);
    if (!session || session.status !== 'done') {
      // Fallback path: session has expired but a result was already persisted
      // (e.g. a prior accept-result that crashed mid-update). Re-stamp the
      // event status and idempotently succeed.
      const existing = await prisma.groupEventResult.findUnique({ where: { eventId } });
      if (existing) {
        await prisma.groupEvent.update({ where: { id: eventId }, data: { status: 'DONE', sessionId: null } });
        return { status: 200, body: { message: 'Event concluded' } };
      }
      return { status: 400, body: { error: 'Voting session is not complete or has expired' } };
    }

    const winnerSnap   = session.result ? session.restaurants[session.result] : null;
    const participants = [session.hostName, ...Object.keys(session.voters).filter((n) => n !== session.hostName)];

    const dbRestaurants = await prisma.restaurant.findMany({
      where:  { id: { in: session.candidates.map(Number).filter(Boolean) } },
      select: { id: true, address: true, website: true },
    });
    const dbMap = Object.fromEntries(dbRestaurants.map((r) => [String(r.id), r]));

    const restaurantPool = session.candidates.map((id) => ({
      id,
      name:    session.restaurants[id]?.name ?? id,
      type:    session.restaurants[id]?.type,
      price:   session.restaurants[id]?.price,
      address: dbMap[id]?.address ?? null,
      website: dbMap[id]?.website ?? null,
    }));

    const ballotsSnapshot = session.voteMethod === 'ranked' ? session.rankings : session.voters;

    await prisma.$transaction([
      prisma.groupEventResult.upsert({
        where: { eventId },
        create: {
          eventId,
          hostUsername:  session.hostName,
          winnerName:    winnerSnap?.name ?? session.result ?? '',
          method:        session.method ?? 'flip',
          voteMethod:    session.method === 'vote' ? session.voteMethod : null,
          participants,
          scores:        session.scores ?? undefined,
          // Prisma's InputJsonValue is an indexable signature; our session
          // shapes are typed records that don't structurally widen to it.
          // The cast-through-unknown mirrors groups.ts and is safe — these
          // values are all JSON-serializable by construction.
          ballots:        ballotsSnapshot as unknown as Prisma.InputJsonValue,
          voterMeta:      session.voterMeta as unknown as Prisma.InputJsonValue,
          irvRounds:      (session.irvRounds ?? undefined) as unknown as Prisma.InputJsonValue,
          restaurantPool: restaurantPool as unknown as Prisma.InputJsonValue,
        },
        update: {},
      }),
      prisma.groupEvent.update({
        where: { id: eventId },
        data:  { status: 'DONE', sessionId: null },
      }),
    ]);

    return { status: 200, body: { message: 'Event concluded' } };
  });

  res.status(result.status).json(result.body);
});

// GET /api/trips/:id/events/:eventId — single-event read for the ballot
// detail modal. Same shape as the inline `events[i]` from GET /api/trips/:id
// but standalone so deep-links work.
router.get('/:id/events/:eventId', async (req: Request, res: Response) => {
  const tripId  = parseId(req.params.id);
  const eventId = parseId(req.params.eventId);
  if (!tripId || !eventId) { res.status(400).json({ error: 'Invalid id' }); return; }

  const { trip: tripMeta, isMember } = await checkTripAuth(tripId, req.userId);
  if (!tripMeta) { res.status(404).json({ error: 'Trip not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this trip' }); return; }

  const event = await prisma.groupEvent.findUnique({
    where:   { id: eventId },
    include: mealEventInclude,
  });
  if (!event || event.tripId !== tripId) {
    res.status(404).json({ error: 'Event not found' }); return;
  }
  res.json({ event });
});

export default router;
