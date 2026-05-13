import { Router, Request, Response } from 'express';
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
  selections: {
    include: {
      restaurant: true,
      addedBy: { select: { id: true, username: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  result: true,
} as const;

// Creates an in-memory voting session from a group event's selections,
// then atomically marks that event as VOTING.
async function launchVoting(groupId: number, eventId: number) {
  const event = await prisma.groupEvent.findUnique({
    where: { id: eventId },
    include: {
      group: { include: { host: { select: { id: true, username: true } } } },
      selections: { include: { restaurant: true } },
    },
  });
  if (!event || event.groupId !== groupId || event.status !== 'OPEN') return null;
  if (event.selections.length < 2) return null;

  const candidates = event.selections.map((s) => String(s.restaurantId));
  const restaurants: Record<string, RestaurantSnapshot> = {};
  for (const sel of event.selections) {
    const r = sel.restaurant;
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
      sessionId: true,
      votingStartsAt: true,
      scheduledFor: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' as const },
  };

  const archivedEventSummarySelect = {
    select: {
      id: true,
      name: true,
      status: true,
      sessionId: true,
      votingStartsAt: true,
      scheduledFor: true,
      createdAt: true,
      result: { select: { winnerName: true, method: true, participants: true, createdAt: true } },
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

// POST /api/groups
router.post('/', async (req: Request, res: Response) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }

  const group = await prisma.group.create({
    data: { name: name.trim(), hostId: req.userId },
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

  // Auto-launch any OPEN events whose scheduled time has passed
  const overdue = await prisma.groupEvent.findMany({
    where: { groupId, status: 'OPEN', votingStartsAt: { lte: new Date() } },
  });
  for (const ev of overdue) {
    await launchVoting(groupId, ev.id);
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
router.post('/:id/events', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (group.hostId !== req.userId) { res.status(403).json({ error: 'Only the host can create events' }); return; }

  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }

  const event = await prisma.groupEvent.create({
    data: { groupId, name: name.trim() },
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

// ── Event selections ──────────────────────────────────────────

// POST /api/groups/:id/events/:eventId/selections — add to pool (any member)
router.post('/:id/events/:eventId/selections', async (req: Request, res: Response) => {
  const groupId = Number(req.params.id);
  const eventId = Number(req.params.eventId);

  if (!(await isMember(groupId, req.userId))) {
    res.status(403).json({ error: 'Not a member of this group' }); return;
  }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.groupId !== groupId) { res.status(404).json({ error: 'Event not found' }); return; }
  if (event.status !== 'OPEN') { res.status(400).json({ error: 'Selections are locked — voting has started' }); return; }

  const { restaurantId } = req.body as { restaurantId?: number };
  if (!restaurantId) { res.status(400).json({ error: 'restaurantId is required' }); return; }

  const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
  if (!restaurant) { res.status(404).json({ error: 'Restaurant not found' }); return; }

  const selection = await prisma.groupEventSelection.upsert({
    where: { eventId_restaurantId: { eventId, restaurantId } },
    create: { eventId, restaurantId, addedById: req.userId },
    update: {},
    include: {
      restaurant: true,
      addedBy: { select: { id: true, username: true } },
    },
  });
  res.status(201).json({ selection });
});

// DELETE /api/groups/:id/events/:eventId/selections/:restaurantId — remove (host only)
router.delete('/:id/events/:eventId/selections/:restaurantId', async (req: Request, res: Response) => {
  const groupId      = Number(req.params.id);
  const eventId      = Number(req.params.eventId);
  const restaurantId = Number(req.params.restaurantId);

  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) { res.status(404).json({ error: 'Group not found' }); return; }
  if (group.hostId !== req.userId) { res.status(403).json({ error: 'Only the host can remove selections' }); return; }

  const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
  if (!event || event.groupId !== groupId) { res.status(404).json({ error: 'Event not found' }); return; }
  if (event.status !== 'OPEN') { res.status(400).json({ error: 'Selections are locked — voting has started' }); return; }

  await prisma.groupEventSelection.deleteMany({ where: { eventId, restaurantId } });
  res.json({ message: 'Selection removed' });
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

  await prisma.$transaction([
    prisma.groupEventResult.upsert({
      where: { eventId },
      create: {
        eventId,
        hostUsername: session.hostName,
        winnerName: winnerSnap?.name ?? session.result ?? '',
        method: session.method ?? 'flip',
        participants,
        scores: session.scores ?? undefined,
        restaurantPool: restaurantPool as any,
      },
      update: {},
    }),
    prisma.groupEvent.update({
      where: { id: eventId },
      data: { status: 'DONE', sessionId: null },
    }),
    ...(!isNaN(winnerId)
      ? [
          prisma.userAccepted.create({ data: { userId: req.userId, restaurantId: winnerId } }),
          ...memberUserIds.map((userId) =>
            prisma.userAccepted.create({ data: { userId, restaurantId: winnerId } }),
          ),
        ]
      : []),
  ]);

  res.json({ message: 'Event concluded' });
});

export default router;
