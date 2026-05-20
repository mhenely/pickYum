// Profile + account-level routes:
//   - PATCH /me                — change email / username / password
//   - PATCH /me/dietary-tags   — replace dietary tag list
//   - PATCH /me/avatar         — set or clear avatar
//   - GET   /me/export         — GDPR data dump
//   - DELETE /me               — delete account
//   - POST  /me/flip           — increment flipCount (coin-flip tracker)
//
// Auth + writeLimiter are applied by the parent router in ./index.ts.

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../../lib/prisma';
import { avatarUpdateLimiter } from '../../middleware/rateLimits';
import { validatePassword } from '../auth';
import { issueToken } from '../../lib/emailTokens';
import { sendEmail, verifyEmailTemplate } from '../../lib/email';
import { logger } from '../../lib/logger';
import { logTaskFailure } from '../../lib/asyncSafety';
import {
  CLIENT_URL,
  MAX_USERNAME_LEN,
  MAX_EMAIL_LEN,
  MAX_AVATAR_BYTES,
  isRecognizedImage,
  recomputeCommunityRating,
} from './shared';

const router = Router();

// ── Profile ───────────────────────────────────────────────────

// PATCH /api/users/me
// Sensitive updates (password, email) require re-authentication via
// `currentPassword`. Username-only updates are not gated — they're public info
// already and re-prompting for a password for a username change is friction
// without security benefit.
//
// Password changes additionally run the same complexity check as registration
// (validatePassword); the old code skipped this, letting an attacker who
// already has a session weaken the password before exfiltrating it.
//
// Email changes flip emailVerified=false and fire a fresh verification email
// so an attacker can't change the recovery address and have password-reset
// links go to them. The session cookie is preserved (we don't sign out the
// caller) since they just proved current-password control.
router.patch('/me', async (req: Request, res: Response) => {
  const { email, username, password, currentPassword } = req.body as {
    email?: string;
    username?: string;
    password?: string;
    currentPassword?: string;
  };

  // Reject obviously oversized inputs early — Prisma would 500 on overflow,
  // and storing 10MB usernames isn't a feature anyone needs.
  if (typeof email === 'string' && email.length > MAX_EMAIL_LEN) {
    res.status(400).json({ error: `email must be ${MAX_EMAIL_LEN} characters or fewer` }); return;
  }
  if (typeof username === 'string' && (username.length === 0 || username.length > MAX_USERNAME_LEN)) {
    res.status(400).json({ error: `username must be 1-${MAX_USERNAME_LEN} characters` }); return;
  }

  const wantsSensitiveChange = Boolean(email || password);

  if (wantsSensitiveChange) {
    if (typeof currentPassword !== 'string' || !currentPassword) {
      res.status(400).json({ error: 'currentPassword is required to change email or password' });
      return;
    }
    const me = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { passwordHash: true },
    });
    if (!me?.passwordHash) {
      // OAuth-only accounts have no password — they can't re-authenticate this
      // way. Direct them to set one first (via the reset flow) before changing
      // email. Avoids silently allowing email change on accounts that have no
      // local password gate.
      res.status(400).json({ error: 'Set a password first before changing email — use the password reset flow' });
      return;
    }
    const ok = await bcrypt.compare(currentPassword, me.passwordHash);
    if (!ok) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
  }

  if (password) {
    const pwError = validatePassword(password);
    if (pwError) { res.status(400).json({ error: pwError }); return; }
  }

  // email + username are citext (schema.prisma) — equality is case-
  // insensitive at the DB level via the unique B-tree index. We rely on
  // the DB to enforce uniqueness rather than pre-checking with findFirst,
  // because two concurrent PATCHes can both pass a findFirst probe and
  // then one of them throws P2002 on update → bubbles to a generic 500.
  // The catch block below maps the violation to a clean 409 with the
  // right field-specific message.

  const data: Record<string, unknown> = {};
  if (email) {
    data.email = email;
    // Force re-verification after an email change so an attacker who hijacks a
    // session can't move the account to an address they control without owning
    // the new inbox.
    data.emailVerified = false;
    data.emailVerifiedAt = null;
  }
  if (username) data.username = username;
  if (password) data.passwordHash = await bcrypt.hash(password, 12);

  let user;
  try {
    user = await prisma.user.update({
      where: { id: req.userId },
      data,
      select: { id: true, email: true, username: true },
    });
  } catch (err: unknown) {
    // P2002 = unique constraint violation. Prisma populates `meta.target`
    // with the constraint name, which on Postgres includes the column
    // (e.g. `User_email_key`) — we sniff which field collided to give
    // the matching client message.
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      const target = (err as { meta?: { target?: string[] | string } }).meta?.target;
      const targetStr = Array.isArray(target) ? target.join(',') : (target ?? '');
      if (targetStr.includes('email')) {
        res.status(409).json({ error: 'That email is already in use' }); return;
      }
      if (targetStr.includes('username')) {
        res.status(409).json({ error: 'That username is already taken' }); return;
      }
      res.status(409).json({ error: 'That value is already in use' }); return;
    }
    throw err;
  }

  // Fire-and-forget the verification email when the address changed. A failed
  // send isn't fatal (the user can request a resend from the profile page).
  if (email) {
    (async () => {
      try {
        const raw = await issueToken(user.id, 'VERIFY_EMAIL');
        const url = `${CLIENT_URL}/verify-email?token=${encodeURIComponent(raw)}`;
        await sendEmail({ to: user.email, ...verifyEmailTemplate(url) });
      } catch (err) {
        logger.error({ err, userId: user.id }, 'failed to send verification email after email change');
      }
    })();
  }

  res.json({ user });
});

// PATCH /api/users/me/dietary-tags — replace the caller's dietary tag list.
// Free-form tags but capped to keep the column tidy and prevent abuse:
//   - max 10 tags per user
//   - each ≤ 40 chars after trim
//   - lowercased + de-duplicated server-side
// The frontend recommends a short allowlist ("vegan", "vegetarian",
// "gluten-free", "halal", "kosher", "dairy-free", "nut-allergy",
// "shellfish-allergy") but accepts arbitrary user-typed values for the
// long-tail cases (low-fodmap, pescatarian, etc.).
router.patch('/me/dietary-tags', async (req: Request, res: Response) => {
  const { tags } = req.body as { tags?: unknown };
  if (!Array.isArray(tags)) {
    res.status(400).json({ error: 'tags must be an array of strings' });
    return;
  }
  // Sanitize: stringify each entry, trim, lowercase, drop empties + dupes.
  const cleaned = Array.from(new Set(
    tags
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0 && t.length <= 40),
  ));
  if (cleaned.length > 10) {
    res.status(400).json({ error: 'A maximum of 10 dietary tags is allowed' });
    return;
  }

  const user = await prisma.user.update({
    where: { id: req.userId },
    data:  { dietaryTags: { set: cleaned } },
    select: { id: true, dietaryTags: true },
  });
  res.json({ user });
});

// PATCH /api/users/me/avatar — replace (or clear) the caller's avatar.
// Body shape:
//   { dataUrl: "data:image/png;base64,..." }  — set / replace
//   { dataUrl: null }                          — clear
//
// Stored as a data URL directly in `User.avatarUrl`. Tradeoff: row size
// grows, but avoids new infrastructure (S3/Supabase Storage) at the
// app's current scale. Caller is expected to downscale client-side; we
// reject anything over 100KB so a careless upload can't bloat the DB.
//
// The body cap (200KB encoded, to give headroom over the 133KB ceiling
// for 100KB base64-encoded payloads) is set in app.ts via a path-scoped
// `express.json({ limit })` mounted BEFORE the global 32KB parser.
router.patch('/me/avatar', avatarUpdateLimiter, async (req: Request, res: Response) => {
  const { dataUrl } = req.body as { dataUrl?: unknown };

  if (dataUrl === null || dataUrl === '') {
    const user = await prisma.user.update({
      where: { id: req.userId },
      data:  { avatarUrl: null },
      select: { id: true, avatarUrl: true },
    });
    res.json({ user });
    return;
  }

  if (typeof dataUrl !== 'string') {
    res.status(400).json({ error: 'dataUrl must be a data: URL string or null' });
    return;
  }

  // Parse `data:<mime>;base64,<payload>`. Reject anything that doesn't match
  // — strict so an attacker can't sneak in a `javascript:` URL or similar.
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    res.status(400).json({ error: 'Only base64-encoded PNG/JPEG/GIF/WebP data URLs are accepted' });
    return;
  }

  const [, mimeType, b64] = match;

  // Decode + size check. base64 inflates payload by ~33%, so a 100KB byte
  // budget means the encoded string is ~133KB. The express body limit (set
  // to 200KB above) gives a buffer for the mime prefix and slack.
  let bytes: Buffer;
  try { bytes = Buffer.from(b64, 'base64'); }
  catch { res.status(400).json({ error: 'Invalid base64 payload' }); return; }

  if (bytes.length === 0) {
    res.status(400).json({ error: 'Avatar payload is empty' }); return;
  }
  if (bytes.length > MAX_AVATAR_BYTES) {
    res.status(400).json({
      error: `Avatar exceeds ${Math.round(MAX_AVATAR_BYTES / 1024)}KB after base64 decoding`,
    });
    return;
  }
  if (!isRecognizedImage(bytes)) {
    res.status(400).json({ error: `Payload doesn't match a recognized ${mimeType} signature` });
    return;
  }

  const user = await prisma.user.update({
    where: { id: req.userId },
    data:  { avatarUrl: dataUrl },
    select: { id: true, avatarUrl: true },
  });
  res.json({ user });
});

// GET /api/users/me/export — download every piece of data the user has on
// record. Returned as a single JSON blob with `Content-Disposition:
// attachment` so the browser saves to disk. Used by the delete-account
// dialog ("Download my data first") and as a GDPR self-service portal.
//
// What's included:
//   - profile: id, email, username, dietaryTags, avatarUrl, createdAt
//   - favorites, options, archived: arrays of restaurant snapshots
//   - accepted: full coin-flip / vote history with method + timestamps
//   - reviews: the user's own reviews (content + rating + restaurant)
//   - savedAddresses: address book entries
//   - groups: { hosted: [...], member: [...] } — group rows the user owns
//     or belongs to, with events + their own results
//   - trips: same shape as groups
//   - recommendations: outgoing + incoming
//
// We avoid leaking other users' identifying info — e.g. group members
// surface as usernames, not as full User rows. Restaurant data is
// included via FK joins since those rows are not user-private.
router.get('/me/export', async (req: Request, res: Response) => {
  const userId = req.userId;
  const [
    user, favs, opts, accs, arcs, revs, addrs, favLists,
    hostedGroups, memberGroups, hostedTrips, memberTrips,
    outgoingRecs, incomingRecs,
  ] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, username: true, dietaryTags: true,
        avatarUrl: true, emailVerified: true, flipCount: true, createdAt: true,
      },
    }),
    prisma.userFavorite.findMany({ where: { userId }, include: { restaurant: true } }),
    prisma.userOption.findMany({ where: { userId }, include: { restaurant: true } }),
    prisma.userAccepted.findMany({
      where: { userId },
      include: { restaurant: { select: { id: true, name: true, googlePlaceId: true } } },
      orderBy: { acceptedAt: 'desc' },
    }),
    prisma.userArchive.findMany({ where: { userId }, include: { restaurant: true } }),
    prisma.review.findMany({
      where: { userId },
      include: { restaurant: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.savedAddress.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    prisma.favoriteList.findMany({
      where: { userId },
      include: { entries: { include: { restaurant: { select: { id: true, name: true } } } } },
      orderBy: { position: 'asc' },
    }),
    prisma.group.findMany({
      where: { hostId: userId },
      include: {
        members: { include: { user: { select: { username: true } } } },
        events:  { include: { result: true } },
      },
    }),
    prisma.groupMember.findMany({
      where: { userId, group: { hostId: { not: userId } } },
      include: {
        group: {
          include: {
            host:   { select: { username: true } },
            events: { include: { result: true } },
          },
        },
      },
    }),
    prisma.trip.findMany({
      where: { hostId: userId },
      include: {
        members: { include: { user: { select: { username: true } } } },
        anchors: true,
        events:  { include: { result: true } },
      },
    }),
    prisma.tripMember.findMany({
      where: { userId, trip: { hostId: { not: userId } } },
      include: {
        trip: {
          include: {
            host:   { select: { username: true } },
            events: { include: { result: true } },
          },
        },
      },
    }),
    prisma.recommendation.findMany({
      where: { fromUserId: userId },
      include: { restaurant: { select: { id: true, name: true } } },
    }),
    // Incoming recs: ones FROM a friend (or follow) TO the current user.
    // Reuses the same socialAccess gate as the recommendations route —
    // we don't materialize that import here; instead we just list all
    // recs whose restaurant the current user could have seen as a target.
    // For an export, the user is allowed to see what was recommended TO
    // them so they can verify the data the system has on them.
    prisma.recommendation.findMany({
      where: {
        OR: [
          { fromUser: { followers: { some: { followingId: userId } } } },
          {
            fromUser: {
              OR: [
                { receivedRequests: { some: { senderId: userId,   status: 'ACCEPTED' } } },
                { sentRequests:     { some: { receiverId: userId, status: 'ACCEPTED' } } },
              ],
            },
          },
        ],
      },
      include: {
        fromUser: { select: { username: true } },
        restaurant: { select: { id: true, name: true } },
      },
    }),
  ]);

  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    profile: user,
    favorites: favs.map((f) => ({ restaurant: f.restaurant, addedAt: f.createdAt })),
    options:   opts.map((o) => ({ restaurant: o.restaurant, addedAt: o.createdAt })),
    accepted: accs.map((a) => ({
      restaurant: a.restaurant,
      acceptedAt: a.acceptedAt,
      chooseMethod: a.chooseMethod,
      excludeFromInsights: a.excludeFromInsights,
      optionsSnapshot: a.optionsSnapshot,
    })),
    archived:  arcs.map((a) => ({ restaurant: a.restaurant, archivedAt: a.createdAt })),
    reviews:   revs.map((r) => ({
      id: r.id, restaurant: r.restaurant, rating: r.rating, content: r.content, createdAt: r.createdAt,
    })),
    savedAddresses: addrs,
    favoriteLists: favLists,
    groups: {
      hosted: hostedGroups.map((g) => ({
        id: g.id, name: g.name, archivedAt: g.archivedAt, createdAt: g.createdAt,
        members: g.members.map((m) => m.user.username),
        events:  g.events,
      })),
      member: memberGroups.map((m) => ({
        id: m.group.id, name: m.group.name, host: m.group.host?.username,
        archivedAt: m.group.archivedAt, joinedAt: m.joinedAt,
        events: m.group.events,
      })),
    },
    trips: {
      hosted: hostedTrips.map((t) => ({
        id: t.id, name: t.name, destination: t.destination,
        startDate: t.startDate, endDate: t.endDate, archivedAt: t.archivedAt,
        members: t.members.map((m) => m.user.username),
        anchors: t.anchors,
        events:  t.events,
      })),
      member: memberTrips.map((m) => ({
        id: m.trip.id, name: m.trip.name, destination: m.trip.destination,
        host: m.trip.host?.username, joinedAt: m.joinedAt,
        events: m.trip.events,
      })),
    },
    recommendations: {
      outgoing: outgoingRecs.map((r) => ({
        restaurant: r.restaurant, tip: r.tip, createdAt: r.createdAt,
      })),
      incoming: incomingRecs.map((r) => ({
        fromUsername: r.fromUser?.username,
        restaurant: r.restaurant, tip: r.tip, createdAt: r.createdAt,
      })),
    },
  };

  const stamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="pickyum-export-${stamp}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

// DELETE /api/users/me — permanently delete the authenticated user's account.
//
// Reviews are kept by default (anonymized — userId → null) so the community
// keeps the rating data. The user can opt-in to full retraction by sending
// `{ retractReviews: true }`, which deletes their review rows up front before
// the FK cascade fires. In both branches we capture the restaurantIds the
// user touched before deletion so we can refresh each restaurant's cached
// communityRating after the row count or grouping has changed.
router.delete('/me', async (req: Request, res: Response) => {
  const retractReviews = (req.body as { retractReviews?: unknown })?.retractReviews === true;

  const reviewed = await prisma.review.findMany({
    where: { userId: req.userId },
    select: { restaurantId: true },
    distinct: ['restaurantId'],
  });

  if (retractReviews) {
    // Explicit retraction — strip the reviews ourselves so the cascade has
    // nothing to set-null. The recompute below sees them as fully gone.
    await prisma.review.deleteMany({ where: { userId: req.userId } });
  }
  // Default branch: leave reviews in place; `onDelete: SetNull` on the FK
  // anonymizes them when the user row is deleted below.

  await prisma.user.delete({ where: { id: req.userId } });

  // Fire-and-forget the recomputes — by now the reviews are either gone
  // (retract case) or detached from the user (anonymize case), so the
  // groupBy + orphan-count logic in recomputeCommunityRating will reflect
  // the new pool. Failures are logged but don't block the response; the
  // cache will catch up on the next review write/delete for that restaurant.
  for (const r of reviewed) {
    logTaskFailure(
      recomputeCommunityRating(r.restaurantId),
      'recomputeCommunityRating:onAccountDelete',
      { restaurantId: r.restaurantId },
    );
  }

  // Match the cookie set by auth.ts so the session is actually cleared
  res.clearCookie('token', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
  res.json({ message: 'Account deleted' });
});

// ── Flip counter ─────────────────────────────────────────────

// POST /api/users/me/flip
router.post('/me/flip', async (req: Request, res: Response) => {
  const user = await prisma.user.update({
    where: { id: req.userId },
    data: { flipCount: { increment: 1 } },
    select: { flipCount: true },
  });
  res.json({ flipCount: user.flipCount });
});

export default router;
