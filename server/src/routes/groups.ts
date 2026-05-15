import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimits';
import { createSession, getSession, generateSessionId, withSessionLock, RestaurantSnapshot } from '../sessions';

const router = Router();
router.use(requireAuth);
router.use(writeLimiter);

// ── Helpers ───────────────────────────────────────────────────

// Group meta + membership in ONE query. The old isMember() helper did two
// (`group.findUnique` for hostId, then `groupMember.findUnique` for the
// member row); many call sites then issued a THIRD `findUnique` for
// `archivedAt`. By including the requesting user's member row inline
// (`members: { where: { userId } }`), and surfacing archivedAt up front,
// most group routes now do a single round-trip for auth + meta instead
// of two or three.
//
// `group: null` means the group doesn't exist (404). `isMember: false`
// with a non-null `group` means it exists but the user isn't authorized
// (403). The host is always considered a member.
type GroupAuth = {
  group: { id: number; hostId: number; archivedAt: Date | null } | null;
  isMember: boolean;
  isHost: boolean;
};

async function checkGroupAuth(groupId: number, userId: number): Promise<GroupAuth> {
  const row = await prisma.group.findUnique({
    where: { id: groupId },
    select: {
      id: true,
      hostId: true,
      archivedAt: true,
      // Only the requester's member row, not all members — O(1) regardless
      // of group size. Empty array = not a member (fast path).
      members: { where: { userId }, select: { userId: true } },
    },
  });
  if (!row) return { group: null, isMember: false, isHost: false };
  const isHost = row.hostId === userId;
  const group = { id: row.id, hostId: row.hostId, archivedAt: row.archivedAt };

  // Fast path: host OR inline members array shows membership. Production
  // Prisma always populates the requested members slice, so this answers
  // 99% of calls in one query. The fallback below only fires for true
  // non-members (403 path — rare and unauthorized, so the extra query
  // doesn't hurt) AND for test mocks that don't populate the inline
  // array — preserving compatibility without rewriting every mock.
  if (isHost || row.members.length > 0) {
    return { group, isHost, isMember: true };
  }
  const member = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });
  return { group, isHost, isMember: !!member };
}

// Event include shape reused across routes. Note: result intentionally
// projects to the SUMMARY-only fields the group detail page renders
// (`ResultDisplay`). The heavy fields — `ballots` (per-voter selections)
// and `irvRounds` (round-by-round counts) — are loaded on demand by
// `BallotDetailModal` via GET /api/groups/:id/events/:eventId. A group
// with 20 past events × 30 voters could ship 50+ KB of unused ballots
// here otherwise.
const eventInclude = {
  options: {
    include: {
      restaurant: true,
      addedBy: { select: { id: true, username: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  result: {
    select: {
      id: true,
      eventId: true,
      hostUsername: true,
      winnerName: true,
      method: true,
      voteMethod: true,
      participants: true,
      scores: true,
      voterMeta: true,
      restaurantPool: true,
      createdAt: true,
      // ballots and irvRounds intentionally omitted — see header above.
    },
  },
  // Surface who proposed the event so the UI can show "Proposed by Sarah" —
  // null on legacy rows from before any-member creation rolled out.
  createdBy: { select: { id: true, username: true } },
} as const;

// Stamps `currentUsername` onto each voterMeta entry — the user's username
// today, if it's different from the historical one captured at /join time.
// Lets the ballot-detail UI render "(signed in as @old, now @new)" without
// rewriting history.
//
// Mutates the supplied results in place (cheap, callers throw them away
// immediately after sending the response). One DB query for the whole batch
// across every result row passed in — safe to call with a single result or
// a list of them. Skips the lookup entirely when no entry carries a userId
// (guest-only or pre-rollout data) so we don't pay for an empty IN-list.
async function enrichVoterMeta(results: Array<{ voterMeta: unknown } | null | undefined>): Promise<void> {
  type Meta = { isGuest?: boolean; username?: string | null; userId?: number | null };
  // Collect all userIds across every result's voterMeta in one pass.
  const allIds = new Set<number>();
  for (const r of results) {
    const meta = r?.voterMeta;
    if (!meta || typeof meta !== 'object') continue;
    for (const m of Object.values(meta as Record<string, Meta>)) {
      if (typeof m?.userId === 'number') allIds.add(m.userId);
    }
  }
  if (allIds.size === 0) return;

  const users = await prisma.user.findMany({
    where: { id: { in: [...allIds] } },
    select: { id: true, username: true },
  });
  const idToCurrent = new Map(users.map((u) => [u.id, u.username]));

  for (const r of results) {
    if (!r) continue;
    const meta = r.voterMeta;
    if (!meta || typeof meta !== 'object') continue;
    const enriched: Record<string, unknown> = {};
    for (const [name, m] of Object.entries(meta as Record<string, Meta>)) {
      const current = m?.userId != null ? idToCurrent.get(m.userId) : undefined;
      // Surface currentUsername only when it differs from the historical
      // snapshot — null otherwise so the UI doesn't render an "x → x" suffix.
      const showCurrent = current && current !== m?.username ? current : null;
      enriched[name] = { ...m, currentUsername: showCurrent };
    }
    (r as { voterMeta: unknown }).voterMeta = enriched;
  }
}

// Creates an in-memory voting session from a group event's options,
// then atomically marks that event as VOTING.
//
// Race-safety: we pre-allocate the session id, then DB-claim it via an
// `updateMany` that's guarded on status='OPEN'. If we lose the race
// (another caller — typically the on-read auto-launch sweeper firing
// against the same overdue event from a different instance — flipped
// status first), we bail without creating a session at all. Materializing
// in Redis only after the claim wins is what prevents the orphan-session
// leak: a session created in Redis before a failed DB claim used to live
// for the full TTL (~4h) and be joinable by anyone who knew the id.
async function launchVoting(groupId: number, eventId: number) {
  const event = await prisma.groupEvent.findUnique({
    where: { id: eventId },
    include: {
      group: { include: { host: { select: { id: true, username: true } } } },
      options: { include: { restaurant: true } },
    },
  });
  // event.group is nullable on the type because GroupEvent.groupId is now
  // optional (trip events live in the same table). Narrowing through groupId
  // alone doesn't propagate to the relation, so we check both. In practice
  // event.group is non-null whenever groupId equals our group's id.
  if (!event || event.groupId !== groupId || !event.group || event.status !== 'OPEN') return null;
  if (event.options.length < 2) return null;

  // 1. Pre-allocate an id. 2. Claim it in the DB atomically — if status
  // isn't still OPEN, we lost the race; bail. 3. Only on win, materialize
  // the session in Redis with the same id.
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
    restaurants[String(r.id)] = { name: r.name, type: r.cuisineType ?? 'Restaurant', price: r.priceLevel ?? 1 };
  }

  const session = await createSession(
    event.group.host.id,
    event.group.host.username,
    candidates,
    restaurants,
    groupId,
    eventId,
    event.scheduledFor?.toISOString() ?? null,
    event.voteMethod === 'RANKED' ? 'ranked' : 'simple',
    event.group.host.username, // hostUsername = same as hostName for group sessions
    0,                          // tripId — not a trip session
    sessionId,                  // preallocatedId so the Redis blob matches the DB column
  );

  return session;
}

// ── List & create groups ──────────────────────────────────────

// GET /api/groups
router.get('/', async (req: Request, res: Response) => {
  const eventSummarySelect = {
    select: {
      id: true,
      name: true,
      status: true,
      voteMethod: true,
      sessionId: true,
      votingStartsAt: true,
      scheduledFor: true,
      createdAt: true,
      createdBy: { select: { id: true, username: true } },
    },
    orderBy: { createdAt: 'desc' as const },
  };

  const archivedEventSummarySelect = {
    select: {
      id: true,
      name: true,
      status: true,
      voteMethod: true,
      sessionId: true,
      votingStartsAt: true,
      scheduledFor: true,
      createdAt: true,
      createdBy: { select: { id: true, username: true } },
      result: { select: { winnerName: true, method: true, voteMethod: true, participants: true, createdAt: true } },
    },
    orderBy: { createdAt: 'desc' as const },
  };

  // List view only needs counts and event statuses — no full member rows. The
  // detail endpoint (`GET /api/groups/:id`) is what GroupDetailPage uses for
  // avatars/names. Dropping the `members.user` join here cuts the per-group
  // result rows from O(members) down to 1.
  const listGroupShape = {
    events: eventSummarySelect,
    _count: { select: { members: true, invites: { where: { status: 'PENDING' as const } } } },
  };

  const [hostedRaw, memberRaw, pendingInvites, archivedHostedRaw] = await Promise.all([
    prisma.group.findMany({
      where: { hostId: req.userId, archivedAt: null },
      include: listGroupShape,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.groupMember.findMany({
      where: { userId: req.userId, group: { archivedAt: null } },
      include: {
        group: {
          include: {
            host: { select: { id: true, username: true, avatarUrl: true } },
            ...listGroupShape,
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
    }),
    prisma.groupInvite.findMany({
      where: { invitedId: req.userId, status: 'PENDING' },
      include: {
        group: { select: { id: true, name: true, hostId: true } },
        invitedBy: { select: { id: true, username: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.group.findMany({
      where: { hostId: req.userId, archivedAt: { not: null } },
      // Archived groups display past results only — no member list rendered.
      include: { events: archivedEventSummarySelect },
      orderBy: { archivedAt: 'desc' },
    }),
  ]);

  const hosted = hostedRaw.map((g) => ({ ...g, role: 'host' as const }));
  const member = memberRaw.map((m) => ({ ...m.group, role: 'member' as const }));
  const memberGroupIds = new Set(member.map((g) => g.id));
  const groups = [...hosted.filter((g) => !memberGroupIds.has(g.id)), ...member];
  const archivedGroups = archivedHostedRaw.map((g) => ({ ...g, role: 'host' as const }));

  res.json({ groups, pendingInvites, archivedGroups });
});

// Maximum length for group + event names. Long enough for "Sunday Brunch with
// the Henely Family" and similar; short enough that a malicious caller can't
// store megabytes per row that every member then ships back on /api/groups.
const MAX_NAME_LEN = 100;

// POST /api/groups
router.post('/', async (req: Request, res: Response) => {
  const { name } = req.body as { name?: string };
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' }); return;
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME_LEN) {
    res.status(400).json({ error: `name must be ${MAX_NAME_LEN} characters or fewer` }); return;
  }

  const group = await prisma.group.create({
    data: { name: trimmed, hostId: req.userId },
    include: {
      host: { select: { id: true, username: true, avatarUrl: true } },
      members: true,
      events: true,
      invites: true,
    },
  });
  res.status(201).json({ group });
});

// ── Single group ──────────────────────────────────────────────

// GET /api/groups/:id
router.get('/:id', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  // One query covers existence check, membership check, and archivedAt
  // (used below to skip auto-launch on archived groups).
  const { group: groupMeta, isMember } = await checkGroupAuth(groupId, req.userId);
  if (!groupMeta) { res.status(404).json({ error: 'Group not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this group' }); return; }

  // Auto-launch any OPEN events whose scheduled time has passed.
  // Skipped for archived groups — no new voting should start there.
  // Parallelized: each launch is independent (different event id, no
  // contention on the same row). Was serial → multi-overdue page-loads
  // paid N × launch latency in serial. Composite index
  // group_events(group_id, status, voting_starts_at) keeps the findMany
  // O(log N).
  if (!groupMeta.archivedAt) {
    const overdue = await prisma.groupEvent.findMany({
      where: { groupId, status: 'OPEN', votingStartsAt: { lte: new Date() } },
      select: { id: true },
    });
    if (overdue.length > 0) {
      await Promise.all(overdue.map((ev) => launchVoting(groupId, ev.id)));
    }
  }

  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: {
      host:    { select: { id: true, username: true, avatarUrl: true } },
      members: { include: { user: { select: { id: true, username: true, avatarUrl: true } } }, orderBy: { joinedAt: 'asc' } },
      invites: {
        include: {
          invited:   { select: { id: true, username: true, avatarUrl: true } },
          invitedBy: { select: { id: true, username: true } },
        },
        orderBy: { createdAt: 'desc' },
      },
      events: {
        include: eventInclude,
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  // Past-event ResultDisplay cards on the group page render hostUsername +
  // participant pills inline, so they need the same rename enrichment as the
  // ballot-detail modal. Batched in one query for every result on the group.
  await enrichVoterMeta(group.events.map((e) => e.result));

  res.json({ group });
});

// DELETE /api/groups/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (group.hostId !== req.userId) { res.status(403).json({ error: 'Only the host can disband the group' }); return; }
  await prisma.group.update({ where: { id: groupId }, data: { archivedAt: new Date() } });
  res.json({ message: 'Group archived' });
});

// PATCH /api/groups/:id/transfer-host — host hands ownership to another member.
// The old host stays in the group as a regular member; the new host has full
// host privileges immediately. Used by the "Leave group" flow when the host
// wants to keep the group running with the remaining members.
router.patch('/:id/transfer-host', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (group.hostId !== req.userId) {
    res.status(403).json({ error: 'Only the current host can transfer ownership' });
    return;
  }
  if (group.archivedAt) {
    res.status(400).json({ error: 'Cannot transfer ownership of an archived group' });
    return;
  }

  const newHostId = Number(req.body?.newHostId);
  if (!Number.isInteger(newHostId) || newHostId <= 0) {
    res.status(400).json({ error: 'newHostId is required' });
    return;
  }
  if (newHostId === group.hostId) {
    res.status(400).json({ error: 'That user is already the host' });
    return;
  }

  // The new host has to be an existing member of the group — we don't allow
  // promoting a stranger or a user with a pending (un-accepted) invite.
  const newHostMembership = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: newHostId } },
  });
  if (!newHostMembership) {
    res.status(400).json({ error: 'New host must be a current member of the group' });
    return;
  }

  // Atomic swap inside an interactive transaction so we can:
  //   (a) Guard the hostId update on the EXPECTED previous host — two
  //       concurrent transfers from the same host both pre-flight as
  //       valid, but only one wins the `updateMany({where: hostId})`.
  //       The loser sees `count=0` and gets a clean 409.
  //   (b) Use `upsert` to demote the previous host. If they already
  //       happen to have a `GroupMember` row (e.g. they were a regular
  //       member promoted by an earlier transfer), `create` would hit
  //       the @@id([groupId, userId]) constraint and 500. `upsert`
  //       no-ops in that case.
  //   (c) Delete the new host's existing GroupMember row before the
  //       hostId flip — the new host shouldn't appear in both columns.
  const txResult = await prisma.$transaction(async (tx) => {
    await tx.groupMember.deleteMany({ where: { groupId, userId: newHostId } });
    const promoted = await tx.group.updateMany({
      where: { id: groupId, hostId: req.userId },
      data:  { hostId: newHostId },
    });
    if (promoted.count === 0) {
      // Another request transferred host out from under us. Caller's view
      // is stale; surface 409 so they refetch.
      return { ok: false as const };
    }
    // Idempotent demote — `upsert` handles the case where the demoted host
    // had a pre-existing GroupMember row (common: they became host via a
    // previous transfer-host that left their original membership intact).
    await tx.groupMember.upsert({
      where:  { groupId_userId: { groupId, userId: req.userId } },
      create: { groupId, userId: req.userId },
      update: {},
    });
    return { ok: true as const };
  });

  if (!txResult.ok) {
    res.status(409).json({ error: 'Host has already been transferred' });
    return;
  }

  res.json({ message: 'Host transferred', hostId: newHostId });
});

// ── Invites ───────────────────────────────────────────────────

// POST /api/groups/:id/invite
router.post('/:id/invite', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (group.hostId !== req.userId) { res.status(403).json({ error: 'Only the host can invite members' }); return; }

  const targetId = Number(req.body?.userId);
  if (!Number.isInteger(targetId) || targetId <= 0 || targetId === req.userId) {
    res.status(400).json({ error: 'Invalid target user' }); return;
  }

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) { res.status(404).json({ error: 'User not found' }); return; }

  const alreadyMember = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: targetId } },
  });
  if (alreadyMember || group.hostId === targetId) {
    res.status(409).json({ error: 'User is already a member' }); return;
  }

  const invite = await prisma.groupInvite.upsert({
    where: { groupId_invitedId: { groupId, invitedId: targetId } },
    create: { groupId, invitedId: targetId, invitedById: req.userId },
    update: { status: 'PENDING' },
    include: { invited: { select: { id: true, username: true, avatarUrl: true } } },
  });
  res.status(201).json({ invite });
});

// PATCH /api/groups/:id/invites/:inviteId
router.patch('/:id/invites/:inviteId', async (req: Request, res: Response) => {
  const inviteId = Number(req.params.inviteId);
  const { action } = req.body as { action?: 'accept' | 'decline' };
  if (action !== 'accept' && action !== 'decline') {
    res.status(400).json({ error: 'action must be "accept" or "decline"' }); return;
  }

  const invite = await prisma.groupInvite.findUnique({ where: { id: inviteId } });
  if (!invite) { res.status(404).json({ error: 'Invite not found' }); return; }
  if (invite.invitedId !== req.userId) { res.status(403).json({ error: 'Not your invite' }); return; }
  if (invite.status !== 'PENDING') { res.status(409).json({ error: 'Invite already responded to' }); return; }

  await prisma.groupInvite.update({
    where: { id: inviteId },
    data: { status: action === 'accept' ? 'ACCEPTED' : 'DECLINED' },
  });

  if (action === 'accept') {
    await prisma.groupMember.upsert({
      where: { groupId_userId: { groupId: invite.groupId, userId: req.userId } },
      create: { groupId: invite.groupId, userId: req.userId },
      update: {},
    });
  }

  res.json({ message: action === 'accept' ? 'Joined group' : 'Invite declined' });
});

// DELETE /api/groups/:id/members/:userId
router.delete('/:id/members/:userId', async (req: Request, res: Response) => {
  const groupId  = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  const isSelf = targetId === req.userId;
  const isHost = group.hostId === req.userId;
  if (!isSelf && !isHost) { res.status(403).json({ error: 'Only the host can remove members' }); return; }
  if (targetId === group.hostId) { res.status(400).json({ error: 'Host cannot be removed — disband the group instead' }); return; }

  await prisma.groupMember.deleteMany({ where: { groupId, userId: targetId } });
  res.json({ message: isSelf ? 'Left group' : 'Member removed' });
});

// ── Events ────────────────────────────────────────────────────

// POST /api/groups/:id/events — create a new event (host only)
// POST /api/groups/:id/events — any group member can propose an event.
// (Previously host-only.) The host retains delete authority via the DELETE
// route below, so abuse can still be cleaned up.
router.post('/:id/events', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const { group, isMember } = await checkGroupAuth(groupId, req.userId);
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this group' }); return; }
  if (group.archivedAt) {
    res.status(400).json({ error: 'Cannot create events in an archived group' }); return;
  }

  const { name, optionRestaurantIds } = req.body as {
    name?: string;
    optionRestaurantIds?: number[];
  };
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' }); return;
  }
  const trimmedName = name.trim();
  if (trimmedName.length > MAX_NAME_LEN) {
    res.status(400).json({ error: `name must be ${MAX_NAME_LEN} characters or fewer` }); return;
  }

  // Optional initial options. Frontend used to create the event then loop
  // `addOption` per restaurant — N+1 round-trips through writeLimiter for
  // every "Plan an event from my favorites" flow. Now the caller can pass
  // the ids inline and we seed them in the same transaction as the event
  // create. Each id is validated for ownership/visibility against the
  // same privacy rules as POST /:id/events/:eventId/options below.
  let optionIds: number[] = [];
  if (Array.isArray(optionRestaurantIds) && optionRestaurantIds.length > 0) {
    const cleaned = [...new Set(optionRestaurantIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (cleaned.length > 0) {
      // Visibility batch-check: a private restaurant can only be seeded by
      // its creator. We auto-publish those (matching the per-option route's
      // behavior) so subsequent reads through the group are consistent.
      const restaurants = await prisma.restaurant.findMany({
        where:  { id: { in: cleaned } },
        select: { id: true, private: true, createdBy: true },
      });
      const visible = restaurants.filter((r) => !r.private || r.createdBy === req.userId);
      if (visible.length !== cleaned.length) {
        res.status(404).json({ error: 'One or more restaurants not found' }); return;
      }
      const toAutoPublish = visible.filter((r) => r.private).map((r) => r.id);
      if (toAutoPublish.length > 0) {
        await prisma.restaurant.updateMany({
          where: { id: { in: toAutoPublish } },
          data:  { private: false },
        });
      }
      optionIds = visible.map((r) => r.id);
    }
  }

  // Single transaction for the event + its initial options. Caller goes
  // from `create + N x addOption` to a single round-trip.
  const event = await prisma.$transaction(async (tx) => {
    const created = await tx.groupEvent.create({
      data: { groupId, name: trimmedName, createdById: req.userId },
    });
    if (optionIds.length > 0) {
      await tx.groupEventOption.createMany({
        data: optionIds.map((restaurantId) => ({
          eventId: created.id,
          restaurantId,
          addedById: req.userId,
        })),
        skipDuplicates: true,
      });
    }
    return tx.groupEvent.findUnique({ where: { id: created.id }, include: eventInclude });
  });
  res.status(201).json({ event });
});

// DELETE /api/groups/:id/events/:eventId — delete an event (host; not while voting is active)
router.delete('/:id/events/:eventId', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const eventId = Number(req.params.eventId);
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (group.hostId !== req.userId) { res.status(403).json({ error: 'Only the host can delete events' }); return; }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.groupId !== groupId) { res.status(404).json({ error: 'Event not found' }); return; }
  if (event.status === 'VOTING') {
    res.status(400).json({ error: 'Cancel voting before deleting this event' }); return;
  }

  await prisma.groupEvent.delete({ where: { id: eventId } });
  res.json({ message: 'Event deleted' });
});

// ── Event options ─────────────────────────────────────────────

// POST /api/groups/:id/events/:eventId/options — add to pool (any member)
router.post('/:id/events/:eventId/options', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const eventId = Number(req.params.eventId);

  const { group: _grpAuth, isMember } = await checkGroupAuth(groupId, req.userId);
  if (!_grpAuth) { res.status(404).json({ error: 'Group not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this group' }); return; }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.groupId !== groupId) { res.status(404).json({ error: 'Event not found' }); return; }
  if (event.status !== 'OPEN') { res.status(400).json({ error: 'Options are locked — voting has started' }); return; }

  const { restaurantId } = req.body as { restaurantId?: number };
  if (!restaurantId) { res.status(400).json({ error: 'restaurantId is required' }); return; }

  const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
  // Privacy: a private restaurant can only be shared into a group by its
  // creator. Other members guessing the row id get the same 404 as a missing
  // row — we don't reveal that a private row exists.
  if (!restaurant || (restaurant.private && restaurant.createdBy !== req.userId)) {
    res.status(404).json({ error: 'Restaurant not found' }); return;
  }
  // Sharing a private row into a group implicitly publishes it: every group
  // member sees it via the Prisma relation join, and visibility filters can't
  // re-hide it afterwards. Flip the flag once, here, so subsequent reads
  // through any path are consistent.
  if (restaurant.private && restaurant.createdBy === req.userId) {
    await prisma.restaurant.update({ where: { id: restaurantId }, data: { private: false } });
  }

  const option = await prisma.groupEventOption.upsert({
    where: { eventId_restaurantId: { eventId, restaurantId } },
    create: { eventId, restaurantId, addedById: req.userId },
    update: {},
    include: {
      restaurant: true,
      addedBy: { select: { id: true, username: true } },
    },
  });
  res.status(201).json({ option });
});

// DELETE /api/groups/:id/events/:eventId/options/:restaurantId
// Removable by: the host, the member who originally added it, OR — if that
// adder has since left the group — any remaining member. The "orphaned adder"
// fallback prevents options from getting stuck in a vote when their
// proposer leaves before voting starts.
router.delete('/:id/events/:eventId/options/:restaurantId', async (req: Request, res: Response) => {
  const groupId      = Number(req.params.id);
  const eventId      = Number(req.params.eventId);
  const restaurantId = Number(req.params.restaurantId);

  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }

  const { group: _grpAuth, isMember } = await checkGroupAuth(groupId, req.userId);
  if (!_grpAuth) { res.status(404).json({ error: 'Group not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this group' }); return; }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.groupId !== groupId) { res.status(404).json({ error: 'Event not found' }); return; }
  if (event.status !== 'OPEN') { res.status(400).json({ error: 'Options are locked — voting has started' }); return; }

  // Look up the option so we know who added it. If it doesn't exist, the
  // deleteMany below will no-op and we still return 200 (idempotent).
  const option = await prisma.groupEventOption.findUnique({
    where: { eventId_restaurantId: { eventId, restaurantId } },
  });

  const isHost = group.hostId === req.userId;
  const isOwnOption = option?.addedById === req.userId;

  // If the original adder is no longer in the group (left or got removed),
  // any current member can clean up the orphaned option. We check the
  // GroupMember table AND the host slot, since the host isn't in members.
  let adderStillInGroup = true;
  if (option && !isHost && !isOwnOption) {
    if (option.addedById === group.hostId) {
      adderStillInGroup = true; // host is always "in"
    } else {
      const adderMembership = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId, userId: option.addedById } },
      });
      adderStillInGroup = !!adderMembership;
    }
  }

  if (option && !isHost && !isOwnOption && adderStillInGroup) {
    res.status(403).json({
      error: 'Only the host or the member who added this option can remove it',
    });
    return;
  }

  await prisma.groupEventOption.deleteMany({ where: { eventId, restaurantId } });
  res.json({ message: 'Option removed' });
});

// ── Event voting controls ─────────────────────────────────────

// POST /api/groups/:id/events/:eventId/start-voting — host starts voting now
router.post('/:id/events/:eventId/start-voting', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const eventId = Number(req.params.eventId);

  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (group.hostId !== req.userId) { res.status(403).json({ error: 'Only the host can start voting' }); return; }
  // The auto-launch sweeper in GET /:id correctly skips archived groups,
  // but the manual start path used to keep working — a host who archived
  // the group mid-planning could still kick off a vote on a leftover event.
  if (group.archivedAt) { res.status(400).json({ error: 'Group is archived' }); return; }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.groupId !== groupId) { res.status(404).json({ error: 'Event not found' }); return; }
  if (event.status !== 'OPEN') { res.status(400).json({ error: 'Voting has already started for this event' }); return; }

  const session = await launchVoting(groupId, eventId);
  if (!session) { res.status(400).json({ error: 'Need at least 2 restaurants to start voting' }); return; }

  res.json({ sessionId: session.id });
});

// PATCH /api/groups/:id/events/:eventId/schedule — set or clear auto-start time (host only)
router.patch('/:id/events/:eventId/schedule', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const eventId = Number(req.params.eventId);

  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (group.hostId !== req.userId) { res.status(403).json({ error: 'Only the host can set the schedule' }); return; }
  if (group.archivedAt) { res.status(400).json({ error: 'Group is archived' }); return; }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.groupId !== groupId) { res.status(404).json({ error: 'Event not found' }); return; }
  if (event.status !== 'OPEN') { res.status(400).json({ error: 'Cannot reschedule after voting has started' }); return; }

  const { votingStartsAt } = req.body as { votingStartsAt?: string | null };
  let newTime: Date | null = null;
  if (votingStartsAt) {
    const parsed = Date.parse(votingStartsAt);
    if (isNaN(parsed)) { res.status(400).json({ error: 'Invalid date format' }); return; }
    newTime = new Date(parsed);
    if (newTime <= new Date()) { res.status(400).json({ error: 'Schedule must be set to a future time' }); return; }
  }

  const updated = await prisma.groupEvent.update({
    where: { id: eventId },
    data: { votingStartsAt: newTime },
  });
  res.json({ votingStartsAt: updated.votingStartsAt });
});

// POST /api/groups/:id/events/:eventId/cancel-voting — reset a VOTING event back to OPEN (host only)
router.post('/:id/events/:eventId/cancel-voting', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const eventId = Number(req.params.eventId);

  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (group.hostId !== req.userId) { res.status(403).json({ error: 'Only the host can cancel voting' }); return; }
  if (group.archivedAt) { res.status(400).json({ error: 'Group is archived' }); return; }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.groupId !== groupId) { res.status(404).json({ error: 'Event not found' }); return; }
  if (event.status !== 'VOTING') { res.status(400).json({ error: 'Event is not in voting state' }); return; }

  await prisma.groupEvent.update({
    where: { id: eventId },
    data: { status: 'OPEN', sessionId: null },
  });

  res.json({ message: 'Voting cancelled — event reset to open' });
});

// PATCH /api/groups/:id/events/:eventId/date — set or clear the "when are we going" date (host only)
router.patch('/:id/events/:eventId/date', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const eventId = Number(req.params.eventId);

  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (group.hostId !== req.userId) { res.status(403).json({ error: 'Only the host can set the event date' }); return; }
  if (group.archivedAt) { res.status(400).json({ error: 'Group is archived' }); return; }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.groupId !== groupId) { res.status(404).json({ error: 'Event not found' }); return; }

  const { scheduledFor } = req.body as { scheduledFor?: string | null };
  let newDate: Date | null = null;
  if (scheduledFor) {
    const parsed = Date.parse(scheduledFor);
    if (isNaN(parsed)) { res.status(400).json({ error: 'Invalid date format' }); return; }
    newDate = new Date(parsed);
  }

  const updated = await prisma.groupEvent.update({
    where: { id: eventId },
    data: { scheduledFor: newDate },
  });
  res.json({ scheduledFor: updated.scheduledFor });
});

// POST /api/groups/:id/events/:eventId/accept-result — archive result and mark event DONE.
//
// The work runs under `withSessionLock` so two concurrent requests (host
// double-tap, retry after flaky network) can't both write UserAccepted
// rows. The lock serializes the read-event/check-status/write-result
// sequence; the second request acquires the lock only after the first
// commits, sees status='DONE', and returns the idempotent "already
// concluded" branch — no duplicate acceptance rows. The pre-lock auth
// + initial event read avoid even acquiring the lock on bad input.
router.post('/:id/events/:eventId/accept-result', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const eventId = Number(req.params.eventId);

  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (group.hostId !== req.userId) { res.status(403).json({ error: 'Only the host can close the event' }); return; }
  if (group.archivedAt) { res.status(400).json({ error: 'Group is archived' }); return; }

  // Read event once to discover the sessionId we need to lock on. The real
  // status check happens INSIDE the lock — if a concurrent request changes
  // status to DONE between this read and the lock acquisition, we'd still
  // proceed without the second check.
  const preEvent = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!preEvent || preEvent.groupId !== groupId) { res.status(404).json({ error: 'Event not found' }); return; }
  if (preEvent.status === 'DONE') { res.json({ message: 'Event already concluded' }); return; }
  if (preEvent.status !== 'VOTING' || !preEvent.sessionId) {
    res.status(400).json({ error: 'Event is not in voting state' }); return;
  }

  // withSessionLock returns whatever the inner function does; we tunnel the
  // response shape through so we can resolve status codes at the outer scope.
  type LockResult =
    | { status: 200; body: { message: string } }
    | { status: 400; body: { error: string } };

  const result: LockResult = await withSessionLock(preEvent.sessionId, async () => {
    // Re-read the event under the lock — between the pre-check above and
    // now, another concurrent accept-result on the same session may have
    // already flipped status to DONE.
    const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
    if (!event || event.status === 'DONE') {
      return { status: 200, body: { message: 'Event already concluded' } };
    }
    if (event.status !== 'VOTING' || !event.sessionId) {
      return { status: 400, body: { error: 'Event is not in voting state' } };
    }

    const session = await getSession(event.sessionId);

    if (!session || session.status !== 'done') {
      const existing = await prisma.groupEventResult.findUnique({ where: { eventId } });
      if (existing) {
        // Back-fill any missing UserAccepted rows before flipping status.
        // This covers the edge case where the original accept-result wrote
        // GroupEventResult, then crashed (worker death, network blip)
        // before / during the UserAccepted spread. Members whose rows
        // didn't land would otherwise never get personal-Insights credit,
        // since the status flip below moves the event into the "Event
        // already concluded" branch on all subsequent calls. We resolve
        // userIds from the persisted voterMeta JSON the same way the
        // happy path resolves them from session.voterMeta.
        const pool = (existing.restaurantPool as unknown as Array<{ id?: string; name?: string }>) ?? [];
        const winnerEntry = pool.find((p) => p?.name === existing.winnerName);
        const winnerId = winnerEntry?.id ? Number(winnerEntry.id) : NaN;
        if (!isNaN(winnerId)) {
          const meta = (existing.voterMeta as unknown as Record<string, { isGuest?: boolean; userId?: number | null } | null>) ?? {};
          const wantedUserIds = new Set<number>([req.userId]);
          for (const v of Object.values(meta)) {
            if (!v || v.isGuest || v.userId == null) continue;
            wantedUserIds.add(v.userId);
          }
          const already = await prisma.userAccepted.findMany({
            where:  { eventId, userId: { in: [...wantedUserIds] } },
            select: { userId: true },
          });
          const alreadySet = new Set(already.map((r) => r.userId));
          const missing = [...wantedUserIds].filter((id) => !alreadySet.has(id));
          if (missing.length > 0) {
            const optionsSnapshot = pool.map((p) => p?.id).filter((x): x is string => typeof x === 'string');
            // Single INSERT covers every missing row in one round-trip.
            // skipDuplicates piggybacks on the unique constraint to make
            // this idempotent — concurrent back-fills can't double-insert.
            await prisma.userAccepted.createMany({
              data: missing.map((userId) => ({
                userId,
                restaurantId: winnerId,
                eventId,
                optionsSnapshot: optionsSnapshot as Prisma.InputJsonValue,
                chooseMethod: existing.method ?? null,
              })),
              skipDuplicates: true,
            });
          }
        }
        await prisma.groupEvent.update({ where: { id: eventId }, data: { status: 'DONE', sessionId: null } });
        return { status: 200, body: { message: 'Event concluded' } };
      }
      return { status: 400, body: { error: 'Voting session is not complete or has expired' } };
    }

    const winnerSnap = session.result ? session.restaurants[session.result] : null;
    const participants = [session.hostName, ...Object.keys(session.voters).filter((n) => n !== session.hostName)];

    const dbRestaurants = await prisma.restaurant.findMany({
      where: { id: { in: session.candidates.map(Number).filter(Boolean) } },
      select: { id: true, address: true, website: true },
    });
    const dbMap = Object.fromEntries(dbRestaurants.map((r) => [String(r.id), r]));

    const restaurantPool = session.candidates.map((id) => ({
      id,
      name: session.restaurants[id]?.name ?? id,
      type: session.restaurants[id]?.type,
      price: session.restaurants[id]?.price,
      address: dbMap[id]?.address ?? null,
      website: dbMap[id]?.website ?? null,
    }));

    const winnerId = session.result ? Number(session.result) : NaN;

    // Resolve participant → userId via session.voterMeta (the authoritative
    // identity sidecar) rather than by matching display name to group
    // member username. Voters whose display name differs from their auth
    // username used to be silently dropped from UserAccepted writes; this
    // change credits them correctly. Guests (isGuest: true, userId: null)
    // are still skipped because they don't have an account to credit.
    let memberUserIds: number[] = [];
    if (!isNaN(winnerId)) {
      const seen = new Set<number>([req.userId]); // host gets their row below; dedupe here
      for (const meta of Object.values(session.voterMeta ?? {})) {
        if (!meta || meta.isGuest || meta.userId == null) continue;
        if (seen.has(meta.userId)) continue;
        seen.add(meta.userId);
        memberUserIds.push(meta.userId);
      }
    }

    // Persist ballots so /events/:eventId can render per-voter detail later.
    // We snapshot the full shape — voters (approval ballots) for simple, rankings
    // (ordered lists) for ranked. Both can be empty objects.
    const ballotsSnapshot = session.voteMethod === 'ranked'
      ? session.rankings
      : session.voters;

    await prisma.$transaction([
      prisma.groupEventResult.upsert({
        where: { eventId },
        create: {
          eventId,
          hostUsername: session.hostName,
          winnerName: winnerSnap?.name ?? session.result ?? '',
          method: session.method ?? 'flip',
          // voteMethod is only meaningful when the winner came from a vote —
          // a pure flip/spin gets null here (the `method` field tells the story).
          voteMethod: session.method === 'vote' ? session.voteMethod : null,
          participants,
          scores: session.scores ?? undefined,
          ballots: ballotsSnapshot as any,
          // Identity sidecar: lets the ballot detail modal show guest/signed-in
          // tags + an auth username when it differs from the display name.
          voterMeta: session.voterMeta as any,
          irvRounds: (session.irvRounds ?? undefined) as any,
          restaurantPool: restaurantPool as any,
        },
        update: {},
      }),
      prisma.groupEvent.update({
        where: { id: eventId },
        data: { status: 'DONE', sessionId: null },
      }),
      // Each member's acceptance carries the group's full candidate pool as the
      // optionsSnapshot — that's the "what they were considering" data for
      // anyone who participated in this vote. chooseMethod mirrors session.method
      // so flips vs. spins vs. votes show up correctly in personal Insights.
      // eventId stamps the link back to this GroupEvent so the user's Insights
      // page can deep-link "Recent decisions" rows into the ballot detail.
      // One createMany INSERT for everyone — host + all signed-in voters
      // resolved from voterMeta. The @@unique([userId, eventId]) constraint
      // (migration 20260519000000) makes `skipDuplicates: true` work, which
      // also bakes in idempotency: a host who retries doesn't get a P2002
      // and never produces dup rows even if the lock check missed.
      // Was previously N individual `userAccepted.create` calls inside the
      // transaction — N round-trips per accept.
      ...(!isNaN(winnerId)
        ? [
            prisma.userAccepted.createMany({
              data: [
                {
                  userId: req.userId,
                  restaurantId: winnerId,
                  eventId,
                  optionsSnapshot: session.candidates as Prisma.InputJsonValue,
                  chooseMethod: session.method ?? null,
                },
                ...memberUserIds.map((userId) => ({
                  userId,
                  restaurantId: winnerId,
                  eventId,
                  optionsSnapshot: session.candidates as Prisma.InputJsonValue,
                  chooseMethod: session.method ?? null,
                })),
              ],
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);

    return { status: 200, body: { message: 'Event concluded' } };
  });

  res.status(result.status).json(result.body);
});

// PATCH /api/groups/:id/events/:eventId/vote-method — set 'SIMPLE' or 'RANKED'
// while the event is still OPEN. Locked once voting has started.
router.patch('/:id/events/:eventId/vote-method', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const eventId = Number(req.params.eventId);

  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (group.hostId !== req.userId) {
    res.status(403).json({ error: 'Only the host can change the vote method' }); return;
  }
  if (group.archivedAt) { res.status(400).json({ error: 'Group is archived' }); return; }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.groupId !== groupId) { res.status(404).json({ error: 'Event not found' }); return; }
  if (event.status !== 'OPEN') {
    res.status(400).json({ error: "Vote method is locked once voting has started" }); return;
  }

  const { voteMethod } = req.body as { voteMethod?: unknown };
  if (voteMethod !== 'SIMPLE' && voteMethod !== 'RANKED') {
    res.status(400).json({ error: "voteMethod must be 'SIMPLE' or 'RANKED'" }); return;
  }

  const updated = await prisma.groupEvent.update({
    where: { id: eventId },
    data: { voteMethod },
    select: { id: true, voteMethod: true },
  });
  res.json(updated);
});

// GET /api/groups/:id/events/:eventId — single event with full result detail
// (ballots, IRV rounds). Used by the archived-group detail / ballot modal.
// Members can read; archived groups still resolve normally.
router.get('/:id/events/:eventId', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const eventId = Number(req.params.eventId);

  const { group: _grpAuth, isMember } = await checkGroupAuth(groupId, req.userId);
  if (!_grpAuth) { res.status(404).json({ error: 'Group not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this group' }); return; }

  const event = await prisma.groupEvent.findUnique({
    where: { id: eventId },
    include: {
      options: {
        include: {
          restaurant: { select: { id: true, name: true, cuisineType: true, priceLevel: true, address: true, website: true } },
          addedBy:    { select: { id: true, username: true } },
        },
        orderBy: { createdAt: 'asc' as const },
      },
      result: true,
    },
  });
  if (!event || event.groupId !== groupId) {
    res.status(404).json({ error: 'Event not found' }); return;
  }

  // See `enrichVoterMeta` header for the design. Stamps `currentUsername` so
  // the modal can show "(signed in as @old, now @new)" when a voter has
  // renamed since this event closed.
  await enrichVoterMeta([event.result]);

  res.json({ event });
});

// ── Group favorites ────────────────────────────────────────────
// Shared per-group restaurant list — collectively owned. Any member can add,
// any member can remove. Used as a quick-add source when creating events.

// GET /api/groups/:id/favorites
router.get('/:id/favorites', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const { group: _grpAuth, isMember } = await checkGroupAuth(groupId, req.userId);
  if (!_grpAuth) { res.status(404).json({ error: 'Group not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this group' }); return; }

  const favorites = await prisma.groupFavorite.findMany({
    where: { groupId },
    include: {
      restaurant: { select: { id: true, name: true, cuisineType: true, priceLevel: true, hours: true, phone: true, website: true, takeout: true, delivery: true, googleRating: true } },
      addedBy:    { select: { id: true, username: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ favorites });
});

// POST /api/groups/:id/favorites/:restaurantId
router.post('/:id/favorites/:restaurantId', async (req: Request, res: Response) => {
  const groupId      = Number(req.params.id);
  const restaurantId = Number(req.params.restaurantId);
  if (!Number.isInteger(restaurantId) || restaurantId <= 0) {
    res.status(400).json({ error: 'Invalid restaurant ID' }); return;
  }
  const { group, isMember } = await checkGroupAuth(groupId, req.userId);
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this group' }); return; }
  if (group.archivedAt) {
    res.status(400).json({ error: 'Cannot modify favorites of an archived group' }); return;
  }

  // Privacy: same rule as event options — a private restaurant can only be
  // promoted to a group favorite by its creator, and doing so publishes it.
  // Members guessing a private id get a 404 (visibility-preserving).
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { private: true, createdBy: true },
  });
  if (!restaurant || (restaurant.private && restaurant.createdBy !== req.userId)) {
    res.status(404).json({ error: 'Restaurant not found' }); return;
  }
  if (restaurant.private && restaurant.createdBy === req.userId) {
    await prisma.restaurant.update({ where: { id: restaurantId }, data: { private: false } });
  }

  try {
    const favorite = await prisma.groupFavorite.upsert({
      where: { groupId_restaurantId: { groupId, restaurantId } },
      create: { groupId, restaurantId, addedById: req.userId },
      // Don't overwrite addedById on re-add — preserves attribution to the
      // first person who put it in the list.
      update: {},
      include: {
        restaurant: { select: { id: true, name: true, cuisineType: true, priceLevel: true, hours: true, phone: true, website: true, takeout: true, delivery: true, googleRating: true } },
        addedBy:    { select: { id: true, username: true } },
      },
    });
    res.status(201).json({ favorite });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2003') {
      res.status(422).json({ error: 'Restaurant not found in database' });
      return;
    }
    throw err;
  }
});

// DELETE /api/groups/:id/favorites/:restaurantId
router.delete('/:id/favorites/:restaurantId', async (req: Request, res: Response) => {
  const groupId      = Number(req.params.id);
  const restaurantId = Number(req.params.restaurantId);
  const { group: _grpAuth, isMember } = await checkGroupAuth(groupId, req.userId);
  if (!_grpAuth) { res.status(404).json({ error: 'Group not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this group' }); return; }
  await prisma.groupFavorite.deleteMany({ where: { groupId, restaurantId } });
  res.json({ message: 'Removed from group favorites' });
});

// ── Group insights ────────────────────────────────────────────
// Aggregate analytics over the group's past completed events. Mirrors the
// per-user Insights endpoint structurally but rolls up GroupEventResult rows
// instead of UserAccepted rows. Returns empty/zeroed shape if the group has
// no completed events yet — the frontend renders an empty state then.

// GET /api/groups/:id/insights
router.get('/:id/insights', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const { group: _grpAuth, isMember } = await checkGroupAuth(groupId, req.userId);
  if (!_grpAuth) { res.status(404).json({ error: 'Group not found' }); return; }
  if (!isMember) { res.status(403).json({ error: 'Not a member of this group' }); return; }

  const results = await prisma.groupEventResult.findMany({
    where: { event: { groupId, status: 'DONE' } },
    include: {
      event: { select: { id: true, name: true, voteMethod: true, scheduledFor: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // ── Roll up per-restaurant considerations + wins ──
  type RestStat = { name: string; considered: number; wins: number };
  const stats = new Map<string, RestStat>();
  const methodCounts: Record<string, number> = {};
  const voteMethodCounts: Record<string, number> = {}; // simple vs ranked (when method === 'vote')
  const memberAppearances: Record<string, number> = {}; // participant name → events attended
  const memberWinAccuracy: Record<string, { picks: number; wins: number }> = {};

  for (const r of results) {
    methodCounts[r.method] = (methodCounts[r.method] ?? 0) + 1;
    if (r.method === 'vote' && r.voteMethod) {
      voteMethodCounts[r.voteMethod] = (voteMethodCounts[r.voteMethod] ?? 0) + 1;
    }

    for (const name of r.participants) {
      memberAppearances[name] = (memberAppearances[name] ?? 0) + 1;
    }

    // restaurantPool is Json — defensively check shape before iterating
    const pool = Array.isArray(r.restaurantPool) ? r.restaurantPool : [];
    for (const item of pool as Array<{ id?: unknown; name?: unknown }>) {
      const id = item?.id != null ? String(item.id) : null;
      const name = typeof item?.name === 'string' ? item.name : null;
      if (!id || !name) continue;
      const entry = stats.get(id) ?? { name, considered: 0, wins: 0 };
      entry.considered += 1;
      if (name === r.winnerName) entry.wins += 1;
      stats.set(id, entry);
    }

    // Member "pick accuracy" — did they vote for the winner?
    //   simple: counted if they approved the winning restaurant
    //   ranked: counted if they put it as their #1 choice
    // For both methods we need to resolve winner-name → winner-id by looking
    // it up in the restaurant pool stored on the result.
    if (r.method === 'vote' && r.ballots && typeof r.ballots === 'object') {
      const winningRestaurantId = (pool as Array<{ id?: unknown; name?: unknown }>)
        .find((p) => p?.name === r.winnerName)?.id;
      if (winningRestaurantId != null) {
        const winnerIdStr = String(winningRestaurantId);

        if (r.voteMethod === 'simple') {
          const ballots = r.ballots as Record<string, Record<string, boolean>>;
          for (const [voter, ballot] of Object.entries(ballots)) {
            if (!ballot || typeof ballot !== 'object') continue;
            const approved = Object.entries(ballot)
              .filter(([, v]) => v === true)
              .map(([id]) => id);
            if (approved.length === 0) continue;
            if (!memberWinAccuracy[voter]) memberWinAccuracy[voter] = { picks: 0, wins: 0 };
            memberWinAccuracy[voter].picks += 1;
            if (approved.includes(winnerIdStr)) {
              memberWinAccuracy[voter].wins += 1;
            }
          }
        } else if (r.voteMethod === 'ranked') {
          // Ranked ballots are stored as `{[voter]: string[]}` — the array is
          // the voter's preference order, best-first. Aligned = #1 matches winner.
          // Choosing strict-#1 (vs "winner anywhere in the ranking") gives the
          // most discriminating number; ranking the winner in slot 3 doesn't
          // really mean you "picked" them.
          const ballots = r.ballots as Record<string, unknown>;
          for (const [voter, ballot] of Object.entries(ballots)) {
            if (!Array.isArray(ballot) || ballot.length === 0) continue;
            if (!memberWinAccuracy[voter]) memberWinAccuracy[voter] = { picks: 0, wins: 0 };
            memberWinAccuracy[voter].picks += 1;
            if (String(ballot[0]) === winnerIdStr) {
              memberWinAccuracy[voter].wins += 1;
            }
          }
        }
      }
    }
  }

  // ── Member cuisine fingerprint ─────────────────────────────────
  // What each member tends to propose. Aggregated across every option ever
  // added (regardless of whether it won) so we can answer "Bob is the Italian
  // guy, Alice goes for Thai" without needing the event detail open.
  // Members who've only added 1-2 entries don't get a fingerprint — too noisy.
  // `?? []` is defensive against jest auto-mocks (Prisma never returns nullish
  // in real usage). Without it, every existing insights test would need a
  // dedicated mock for this query.
  const optionRows = (await prisma.groupEventOption.findMany({
    where: { event: { groupId } },
    select: {
      addedBy:    { select: { username: true } },
      restaurant: { select: { cuisineType: true } },
    },
  })) ?? [];

  const memberCuisineMap = new Map<string, Map<string, number>>();
  const memberTotalAdds  = new Map<string, number>();
  for (const opt of optionRows) {
    const username = opt.addedBy?.username;
    if (!username) continue;
    const cuisine = opt.restaurant?.cuisineType ?? 'Other';
    memberTotalAdds.set(username, (memberTotalAdds.get(username) ?? 0) + 1);
    if (!memberCuisineMap.has(username)) memberCuisineMap.set(username, new Map());
    const m = memberCuisineMap.get(username)!;
    m.set(cuisine, (m.get(cuisine) ?? 0) + 1);
  }

  const MIN_ADDS_FOR_FINGERPRINT = 3;
  const memberCuisines: Record<string, Array<{ cuisine: string; count: number }>> = {};
  for (const [member, cuisineMap] of memberCuisineMap) {
    if ((memberTotalAdds.get(member) ?? 0) < MIN_ADDS_FOR_FINGERPRINT) continue;
    memberCuisines[member] = [...cuisineMap.entries()]
      .map(([cuisine, count]) => ({ cuisine, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3); // top 3 cuisines per member
  }

  const allRestaurants = [...stats.entries()].map(([id, v]) => ({
    restaurantId: id,
    name: v.name,
    considered: v.considered,
    wins: v.wins,
    winRate: v.considered > 0 ? v.wins / v.considered : 0,
  }));

  const topConsidered = [...allRestaurants]
    .sort((a, b) => b.considered - a.considered)
    .slice(0, 5);

  // "The group loves to talk about it, never actually picks it" — ≥2 considerations, 0 wins.
  const oftenSkipped = [...allRestaurants]
    .filter((r) => r.considered >= 2 && r.wins === 0)
    .sort((a, b) => b.considered - a.considered)
    .slice(0, 5);

  // Top winners by absolute count, then by win rate.
  const topWinners = [...allRestaurants]
    .filter((r) => r.wins > 0)
    .sort((a, b) => b.wins - a.wins || b.winRate - a.winRate)
    .slice(0, 5);

  const recent = results.slice(0, 8).map((r) => ({
    eventId: r.event?.id ?? null,
    eventName: r.event?.name ?? null,
    winnerName: r.winnerName,
    method: r.method,
    voteMethod: r.voteMethod,
    participants: r.participants,
    acceptedAt: r.createdAt,
    scheduledFor: r.event?.scheduledFor ?? null,
  }));

  res.json({
    totalEvents: results.length,
    distinctWinners: new Set(results.map((r) => r.winnerName)).size,
    methodCounts,
    voteMethodCounts,
    memberAppearances,
    memberWinAccuracy: Object.fromEntries(
      Object.entries(memberWinAccuracy).map(([k, v]) => [
        k,
        { ...v, rate: v.picks > 0 ? v.wins / v.picks : 0 },
      ]),
    ),
    memberCuisines,
    topConsidered,
    oftenSkipped,
    topWinners,
    recent,
  });
});

export default router;
