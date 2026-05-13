import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimits';
import { createSession, getSession, RestaurantSnapshot } from '../sessions';

const router = Router();
router.use(requireAuth);
router.use(writeLimiter);

// ── Helpers ───────────────────────────────────────────────────

async function isMember(groupId: number, userId: number): Promise<boolean> {
  const group = await prisma.group.findUnique({ where: { id: groupId }, select: { hostId: true } });
  if (!group) return false;
  if (group.hostId === userId) return true;
  const m = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId } } });
  return !!m;
}

// Full event include shape reused across routes
const eventInclude = {
  options: {
    include: {
      restaurant: true,
      addedBy: { select: { id: true, username: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  result: true,
  // Surface who proposed the event so the UI can show "Proposed by Sarah" —
  // null on legacy rows from before any-member creation rolled out.
  createdBy: { select: { id: true, username: true } },
} as const;

// Creates an in-memory voting session from a group event's options,
// then atomically marks that event as VOTING.
async function launchVoting(groupId: number, eventId: number) {
  const event = await prisma.groupEvent.findUnique({
    where: { id: eventId },
    include: {
      group: { include: { host: { select: { id: true, username: true } } } },
      options: { include: { restaurant: true } },
    },
  });
  if (!event || event.groupId !== groupId || event.status !== 'OPEN') return null;
  if (event.options.length < 2) return null;

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
  );

  const updated = await prisma.groupEvent.updateMany({
    where: { id: eventId, status: 'OPEN' },
    data: { status: 'VOTING', sessionId: session.id },
  });
  if (updated.count === 0) return null;

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
  if (!(await isMember(groupId, req.userId))) {
    res.status(403).json({ error: 'Not a member of this group' }); return;
  }

  // Auto-launch any OPEN events whose scheduled time has passed.
  // Skipped for archived groups — no new voting should start there.
  const groupMeta = await prisma.group.findUnique({ where: { id: groupId }, select: { archivedAt: true } });
  if (!groupMeta?.archivedAt) {
    const overdue = await prisma.groupEvent.findMany({
      where: { groupId, status: 'OPEN', votingStartsAt: { lte: new Date() } },
    });
    for (const ev of overdue) {
      await launchVoting(groupId, ev.id);
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

  // Atomic swap: promote target, demote current host into the members table.
  // Order matters — the unique constraint on (groupId, userId) means we have
  // to delete the new-host's GroupMember row before adding the old host's.
  await prisma.$transaction([
    prisma.groupMember.deleteMany({ where: { groupId, userId: newHostId } }),
    prisma.group.update({ where: { id: groupId }, data: { hostId: newHostId } }),
    prisma.groupMember.create({ data: { groupId, userId: group.hostId } }),
  ]);

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
  if (!(await isMember(groupId, req.userId))) {
    res.status(403).json({ error: 'Not a member of this group' }); return;
  }
  const group = await prisma.group.findUnique({ where: { id: groupId }, select: { archivedAt: true } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (group.archivedAt) {
    res.status(400).json({ error: 'Cannot create events in an archived group' }); return;
  }

  const { name } = req.body as { name?: string };
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' }); return;
  }
  const trimmedName = name.trim();
  if (trimmedName.length > MAX_NAME_LEN) {
    res.status(400).json({ error: `name must be ${MAX_NAME_LEN} characters or fewer` }); return;
  }

  const event = await prisma.groupEvent.create({
    data: { groupId, name: trimmedName, createdById: req.userId },
    include: eventInclude,
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

  if (!(await isMember(groupId, req.userId))) {
    res.status(403).json({ error: 'Not a member of this group' }); return;
  }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.groupId !== groupId) { res.status(404).json({ error: 'Event not found' }); return; }
  if (event.status !== 'OPEN') { res.status(400).json({ error: 'Options are locked — voting has started' }); return; }

  const { restaurantId } = req.body as { restaurantId?: number };
  if (!restaurantId) { res.status(400).json({ error: 'restaurantId is required' }); return; }

  const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) { res.status(404).json({ error: 'Restaurant not found' }); return; }

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

  if (!(await isMember(groupId, req.userId))) {
    res.status(403).json({ error: 'Not a member of this group' }); return;
  }

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

// POST /api/groups/:id/events/:eventId/accept-result — archive result and mark event DONE
router.post('/:id/events/:eventId/accept-result', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const eventId = Number(req.params.eventId);

  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (group.hostId !== req.userId) { res.status(403).json({ error: 'Only the host can close the event' }); return; }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.groupId !== groupId) { res.status(404).json({ error: 'Event not found' }); return; }
  if (event.status === 'DONE') { res.json({ message: 'Event already concluded' }); return; }
  if (event.status !== 'VOTING' || !event.sessionId) {
    res.status(400).json({ error: 'Event is not in voting state' }); return;
  }

  const session = await getSession(event.sessionId);

  if (!session || session.status !== 'done') {
    const existing = await prisma.groupEventResult.findUnique({ where: { eventId } });
    if (existing) {
      await prisma.groupEvent.update({ where: { id: eventId }, data: { status: 'DONE', sessionId: null } });
      res.json({ message: 'Event concluded' }); return;
    }
    res.status(400).json({ error: 'Voting session is not complete or has expired' }); return;
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

  // Look up member userIds by participant name for UserAccepted records
  const nonHostParticipants = participants.filter((n) => n !== session.hostName);
  let memberUserIds: number[] = [];
  if (nonHostParticipants.length > 0 && !isNaN(winnerId)) {
    const groupMembers = await prisma.groupMember.findMany({
      where: { groupId: session.groupId },
      include: { user: { select: { id: true, username: true } } },
    });
    const usernameToId = Object.fromEntries(groupMembers.map((m) => [m.user.username, m.user.id]));
    memberUserIds = nonHostParticipants.filter((n) => usernameToId[n]).map((n) => usernameToId[n]);
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
    ...(!isNaN(winnerId)
      ? [
          prisma.userAccepted.create({
            data: {
              userId: req.userId,
              restaurantId: winnerId,
              optionsSnapshot: session.candidates as Prisma.InputJsonValue,
              chooseMethod: session.method ?? null,
            },
          }),
          ...memberUserIds.map((userId) =>
            prisma.userAccepted.create({
              data: {
                userId,
                restaurantId: winnerId,
                optionsSnapshot: session.candidates as Prisma.InputJsonValue,
                chooseMethod: session.method ?? null,
              },
            }),
          ),
        ]
      : []),
  ]);

  res.json({ message: 'Event concluded' });
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

  if (!(await isMember(groupId, req.userId))) {
    res.status(403).json({ error: 'Not a member of this group' }); return;
  }

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
  res.json({ event });
});

// ── Group favorites ────────────────────────────────────────────
// Shared per-group restaurant list — collectively owned. Any member can add,
// any member can remove. Used as a quick-add source when creating events.

// GET /api/groups/:id/favorites
router.get('/:id/favorites', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  if (!(await isMember(groupId, req.userId))) {
    res.status(403).json({ error: 'Not a member of this group' }); return;
  }

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
  if (!(await isMember(groupId, req.userId))) {
    res.status(403).json({ error: 'Not a member of this group' }); return;
  }

  const group = await prisma.group.findUnique({ where: { id: groupId }, select: { archivedAt: true } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (group.archivedAt) {
    res.status(400).json({ error: 'Cannot modify favorites of an archived group' }); return;
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
  if (!(await isMember(groupId, req.userId))) {
    res.status(403).json({ error: 'Not a member of this group' }); return;
  }
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
  if (!(await isMember(groupId, req.userId))) {
    res.status(403).json({ error: 'Not a member of this group' }); return;
  }

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

    // Member "pick accuracy" — did they vote for the winner? Only meaningful
    // for simple-vote results where we have per-voter ballots.
    if (r.method === 'vote' && r.voteMethod === 'simple' && r.ballots && typeof r.ballots === 'object') {
      const ballots = r.ballots as Record<string, Record<string, boolean>>;
      const winningRestaurantId = (pool as Array<{ id?: unknown; name?: unknown }>)
        .find((p) => p?.name === r.winnerName)?.id;
      if (winningRestaurantId != null) {
        for (const [voter, ballot] of Object.entries(ballots)) {
          if (!ballot || typeof ballot !== 'object') continue;
          const approved = Object.entries(ballot)
            .filter(([, v]) => v === true)
            .map(([id]) => id);
          if (approved.length === 0) continue;
          if (!memberWinAccuracy[voter]) memberWinAccuracy[voter] = { picks: 0, wins: 0 };
          memberWinAccuracy[voter].picks += 1;
          if (approved.includes(String(winningRestaurantId))) {
            memberWinAccuracy[voter].wins += 1;
          }
        }
      }
    }
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
    topConsidered,
    oftenSkipped,
    topWinners,
    recent,
  });
});

export default router;
