import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { writeLimiter, externalApiLimiter, perRowRefreshLimiter, avatarUpdateLimiter } from '../middleware/rateLimits';
import { validatePassword } from './auth';
import { issueToken } from '../lib/emailTokens';
import { sendEmail, verifyEmailTemplate } from '../lib/email';
import { logger } from '../lib/logger';
import { trackGoogleCall } from '../lib/apiUsage';
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
} from '../lib/favoriteLists';

const router = Router();

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

// All user routes require authentication and are rate-limited on writes
router.use(requireAuth);
router.use(writeLimiter);

const parseRestaurantId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// Restaurant visibility guard — used by every /me/* write that takes a
// restaurantId. The route-level routes (groups/social/trips) already enforce
// this; this fills the matching gap on the personal-collection writes. A
// private restaurant is visible (and addable to any personal list) only to
// its creator. Returns `null` (caller should 404) when the row is missing
// OR private-and-not-yours — the same response in both cases preserves the
// existence-hiding property of the privacy flag.
async function loadVisibleRestaurant(restaurantId: number, userId: number) {
  const r = await prisma.restaurant.findUnique({
    where:  { id: restaurantId },
    select: { id: true, private: true, createdBy: true },
  });
  if (!r) return null;
  if (r.private && r.createdBy !== userId) return null;
  return r;
}

// String-input caps. Picked generously enough for real usernames / addresses
// / review text, tight enough that a hostile client can't store megabytes per
// row. Username/email match what the registration UI already constrains.
const MAX_USERNAME_LEN   = 32;
const MAX_EMAIL_LEN      = 254; // RFC 5321 maximum
const MAX_REVIEW_CONTENT = 4000;
// Avatar payload cap. The frontend downscales to ~256×256 before sending,
// which lands well under 100KB even at high JPEG quality. The DB column
// stores the data URL directly — fine at this scale; if avatar storage
// ever pressures the DB we'll move to S3/Supabase Storage and the column
// becomes a URL. The Express body limit (32kb in app.ts) is overridden for
// this single route via the `bigJson` helper below.
const MAX_AVATAR_BYTES   = 100 * 1024;

// Magic-byte signatures for the image types we accept. Validating these
// (vs. trusting the data-URL MIME header) prevents a hostile client from
// labelling an arbitrary payload as image/png and stashing it in a column
// the UI will render. We only check the prefix — full image parsing would
// be overkill and most attacks fail this gate.
function isRecognizedImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // GIF: 47 49 46 38 (GIF8)
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // WebP: starts with "RIFF" then 4 bytes of size then "WEBP"
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return true;
  return false;
}

async function recomputeCommunityRating(restaurantId: number): Promise<void> {
  // Serialize concurrent recomputes for the same restaurant via a Postgres
  // advisory lock keyed by `restaurantId`. Without this, two parallel review
  // creates can interleave their `groupBy → update` pairs and the slower
  // recompute clobbers the faster one with a stale aggregate. The lock is
  // transaction-scoped (auto-released on commit/rollback) and only contends
  // with other recomputes for the *same* restaurant — high-volume rows queue
  // briefly, low-volume rows pay nothing.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${restaurantId})`;

    // The user-avg groupBy and the orphan findMany are independent — both
    // filter the same `restaurantId` but along disjoint `userId` predicates.
    // Parallelize to save one RTT per recompute. Backed by index
    // reviews(restaurant_id) so each is O(log N).
    //
    // Per-user averages collapse multiple reviews from the same person into
    // one data point so no single account can dominate by spamming reviews.
    // Orphans (from deleted accounts) can no longer be grouped by user;
    // each is counted as its own data point so historical contributions
    // survive an account deletion without letting one deleted user
    // double-count. `?? []` is defensive for jest automocks that resolve
    // to undefined.
    const [userAvgs, orphans] = await Promise.all([
      tx.review.groupBy({
        by: ['userId'],
        where: { restaurantId, userId: { not: null } },
        _avg: { rating: true },
      }),
      tx.review.findMany({
        where: { restaurantId, userId: null },
        select: { rating: true },
      }).then((r) => r ?? []),
    ]);

    const samples = [
      ...userAvgs.map((u) => Number(u._avg.rating ?? 0)),
      ...orphans.map((o) => Number(o.rating)),
    ];
    const communityRating =
      samples.length > 0
        ? samples.reduce((sum, n) => sum + n, 0) / samples.length
        : null;
    await tx.restaurant.update({ where: { id: restaurantId }, data: { communityRating } });
  });
}

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
    recomputeCommunityRating(r.restaurantId)
      .catch((err) => console.warn('[communityRating] recompute on account delete failed:', err));
  }

  // Match the cookie set by auth.ts so the session is actually cleared
  res.clearCookie('token', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
  res.json({ message: 'Account deleted' });
});

// ── Batch load ────────────────────────────────────────────────

// GET /api/users/me/all — returns all user collections in one round-trip.
//
// Restaurant payload is sent through 5 separate collections; each row was
// previously a full Restaurant (every column). The frontend slice
// (userInfoSlice.loadUserData) only reads a fixed set of fields, so we
// project them server-side. Anything not in here is unused at the call
// site; if you need a new field on cards, add it here AND in the
// addCustomRestaurant mapping in the slice.
//
// THIS PROJECTION IS THE SESSION-RESTORE BOTTLENECK. Anything you want
// to survive a logout/login cycle on cards/modals MUST be listed here
// — otherwise the field comes back from /me/all as undefined and the
// frontend can only repopulate it via a fresh nearby search. Found and
// fixed an instance where photos / ratingCount / regularOpeningHours /
// address were missing here even though they were persisted in the DB
// (added via materialize + refresh-places); the cards rendered them
// after a search but lost them on the next session.
//
// yelpUrl was previously selected here too, but no UI surface reads
// it anymore — dropped to keep the projection lean.
const RESTAURANT_CARD_SELECT = {
  id: true,
  name: true,
  cuisineType: true,
  priceLevel: true,
  googleRating: true,
  // Number of Google ratings backing the average. UI uses it to show
  // "4.5 (827 ratings)" — without it the count silently disappears
  // after a session refresh.
  ratingCount: true,
  // Free-form opening-hours string (typically null — only set on
  // user-typed custom rows that supplied an Opens line).
  hours: true,
  phone: true,
  website: true,
  // Postal address rendered in the modal's Contact info grid.
  address: true,
  takeout: true,
  delivery: true,
  googlePlaceId: true,
  // Needed for the Compare-page map. ~16 bytes per row — negligible
  // payload addition. Frontend skips rows where these are null.
  lat: true,
  lng: true,
  // Cached Google Places photo metadata array. Drives the photo
  // carousel on cards + the photo hero/strip in the detail modal.
  // JSON column — typical row carries 200-500 bytes.
  photos: true,
  // Structured weekly hours used by the open-now / closing-soon
  // indicator + the collapsible weekday table. JSON column —
  // typical row carries 300-800 bytes.
  regularOpeningHours: true,
  // Custom-row opt-out for the post-search match-suggestion scan.
  // Read by the frontend to skip a custom row when scanning
  // search results; toggled by the user via the match-confirm
  // modal's "Stop asking" button or the detail-modal toggle.
  excludeFromPlaceMatching: true,
  // Surfaces a "Google data updated 2 months ago" indicator on the
  // detail modal so users know to expect possible staleness when
  // STALE_DAYS is set to 90. Null for custom rows + legacy
  // pre-rollout rows; rendered only when older than ~7 days so
  // freshly-refreshed rows don't show noise like "updated today".
  googleDataUpdatedAt: true,
} as const;

// Bump this whenever /me/all's response shape changes in a breaking
// way (added fields are non-breaking; removed/renamed fields are).
// Future mobile clients use it to detect "please update" scenarios
// instead of failing on missing keys. Mirrored by ApiMeAllResponse
// in src/lib/api.ts — update both together.
//
//   v1 → original Option-B normalized shape (deduped restaurants[]
//        + per-collection ID arrays).
//   v2 → adds favoriteLists[] (multi-list favorites). `favoriteIds`
//        stays during the transition as a derived view of the
//        default list's entries; drop in a future minor bump after
//        all client surfaces read from favoriteLists.
const ME_ALL_API_VERSION = 2;

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

// ── Address book ──────────────────────────────────────────────
// Each user keeps a small list of named locations (Home, Work, etc.)
// for one-click prefill on the Search page. Exactly one address can be
// marked `isDefault` — enforced application-side in the writes below,
// which clear other defaults inside a transaction whenever a new
// default is set.

const MAX_LABEL_LEN          = 64;
const MAX_ADDRESS_BOOK_ENTRY = 256;
const MAX_ADDRESSES_PER_USER = 10;

// GET /api/users/me/addresses
router.get('/me/addresses', async (req: Request, res: Response) => {
  const addresses = await prisma.savedAddress.findMany({
    where: { userId: req.userId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  res.json({ addresses });
});

// POST /api/users/me/addresses
router.post('/me/addresses', async (req: Request, res: Response) => {
  const { label, address, isDefault } = req.body as {
    label?: string;
    address?: string;
    isDefault?: boolean;
  };
  const trimmedLabel   = typeof label   === 'string' ? label.trim()   : '';
  const trimmedAddress = typeof address === 'string' ? address.trim() : '';

  if (!trimmedLabel)   { res.status(400).json({ error: 'label is required' }); return; }
  if (!trimmedAddress) { res.status(400).json({ error: 'address is required' }); return; }
  if (trimmedLabel.length   > MAX_LABEL_LEN)          { res.status(400).json({ error: `label must be ${MAX_LABEL_LEN} characters or fewer` }); return; }
  if (trimmedAddress.length > MAX_ADDRESS_BOOK_ENTRY) { res.status(400).json({ error: `address must be ${MAX_ADDRESS_BOOK_ENTRY} characters or fewer` }); return; }

  // Soft cap — keeps the UI dropdown short and rules out runaway entries.
  const count = await prisma.savedAddress.count({ where: { userId: req.userId } });
  if (count >= MAX_ADDRESSES_PER_USER) {
    res.status(400).json({ error: `Address book is limited to ${MAX_ADDRESSES_PER_USER} entries — delete one to add another` });
    return;
  }

  // If this is being set as default, demote any existing default
  // atomically so the "exactly one default" invariant holds.
  const willBeDefault = isDefault === true || count === 0; // first entry auto-defaults
  try {
    const created = await prisma.$transaction(async (tx) => {
      if (willBeDefault) {
        await tx.savedAddress.updateMany({
          where: { userId: req.userId, isDefault: true },
          data:  { isDefault: false },
        });
      }
      return tx.savedAddress.create({
        data: {
          userId: req.userId,
          label: trimmedLabel,
          address: trimmedAddress,
          isDefault: willBeDefault,
        },
      });
    });
    res.status(201).json({ address: created });
  } catch (err: unknown) {
    // P2002 = unique constraint (userId, label) violation
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      res.status(409).json({ error: 'You already have an address with that label' });
      return;
    }
    throw err;
  }
});

// PATCH /api/users/me/addresses/:id
router.patch('/me/addresses/:id', async (req: Request, res: Response) => {
  const id = parseRestaurantId(req.params.id);
  if (!id) { res.status(400).json({ error: 'Invalid address id' }); return; }

  const { label, address, isDefault } = req.body as {
    label?: string;
    address?: string;
    isDefault?: boolean;
  };

  // Confirm ownership first — keeps the response shape consistent (404)
  // for both "doesn't exist" and "belongs to another user", so a fishing
  // probe can't enumerate ids.
  const existing = await prisma.savedAddress.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.userId) {
    res.status(404).json({ error: 'Address not found' }); return;
  }

  const data: Record<string, unknown> = {};
  if (typeof label === 'string') {
    const trimmed = label.trim();
    if (!trimmed)                       { res.status(400).json({ error: 'label cannot be empty' }); return; }
    if (trimmed.length > MAX_LABEL_LEN) { res.status(400).json({ error: `label must be ${MAX_LABEL_LEN} characters or fewer` }); return; }
    data.label = trimmed;
  }
  if (typeof address === 'string') {
    const trimmed = address.trim();
    if (!trimmed)                                { res.status(400).json({ error: 'address cannot be empty' }); return; }
    if (trimmed.length > MAX_ADDRESS_BOOK_ENTRY) { res.status(400).json({ error: `address must be ${MAX_ADDRESS_BOOK_ENTRY} characters or fewer` }); return; }
    data.address = trimmed;
  }

  // Promoting this row to default? Demote others atomically.
  const promotingToDefault = isDefault === true && !existing.isDefault;
  if (isDefault === true)  data.isDefault = true;
  // Refuse demotion to false — the only valid way to "lose" default is
  // to set another row as default (which will demote this one). This
  // keeps the invariant "exactly one default exists when ≥1 addresses".
  if (isDefault === false && existing.isDefault) {
    res.status(400).json({ error: 'Set another address as default instead of clearing this one' });
    return;
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (promotingToDefault) {
        await tx.savedAddress.updateMany({
          where: { userId: req.userId, isDefault: true, NOT: { id } },
          data:  { isDefault: false },
        });
      }
      return tx.savedAddress.update({ where: { id }, data });
    });
    res.json({ address: updated });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      res.status(409).json({ error: 'You already have an address with that label' });
      return;
    }
    throw err;
  }
});

// DELETE /api/users/me/addresses/:id
router.delete('/me/addresses/:id', async (req: Request, res: Response) => {
  const id = parseRestaurantId(req.params.id);
  if (!id) { res.status(400).json({ error: 'Invalid address id' }); return; }

  // Same ownership-or-404 pattern as PATCH.
  const existing = await prisma.savedAddress.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.userId) {
    res.status(404).json({ error: 'Address not found' }); return;
  }

  // If we're deleting the current default, promote the oldest remaining
  // entry so the "exactly one default" invariant is preserved.
  // (Strictly: "at most one default with ≥1 addresses; zero if empty.")
  await prisma.$transaction(async (tx) => {
    await tx.savedAddress.delete({ where: { id } });
    if (existing.isDefault) {
      const next = await tx.savedAddress.findFirst({
        where: { userId: req.userId },
        orderBy: { createdAt: 'asc' },
      });
      if (next) {
        await tx.savedAddress.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    }
  });

  res.json({ message: 'Address deleted' });
});

// ── Favorites ─────────────────────────────────────────────────

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
  const restaurantId = parseRestaurantId(req.params.restaurantId);
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
  const restaurantId = parseRestaurantId(req.params.restaurantId);
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

const parseListId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

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
// catches "positions" as `:id` and 400s on parseListId.
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
  const listId = parseListId(req.params.id);
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
  const listId = parseListId(req.params.id);
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
  const listId = parseListId(req.params.id);
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
  const listId = parseListId(req.params.id);
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
  const listId       = parseListId(req.params.id);
  const restaurantId = parseRestaurantId(req.params.rid);
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
  const listId       = parseListId(req.params.id);
  const restaurantId = parseRestaurantId(req.params.rid);
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

// ── Options ───────────────────────────────────────────────────

// GET /api/users/me/options
router.get('/me/options', async (req: Request, res: Response) => {
  const options = await prisma.userOption.findMany({
    where: { userId: req.userId },
    include: { restaurant: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ options: options.map((o) => o.restaurant) });
});

// POST /api/users/me/options/:restaurantId
router.post('/me/options/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseRestaurantId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  if (!(await loadVisibleRestaurant(restaurantId, req.userId))) {
    res.status(404).json({ error: 'Restaurant not found' }); return;
  }
  try {
    await prisma.userOption.upsert({
      where: { userId_restaurantId: { userId: req.userId, restaurantId } },
      create: { userId: req.userId, restaurantId },
      update: {},
    });
    res.status(201).json({ message: 'Added to options' });
  } catch (err: any) {
    if (err?.code === 'P2003') {
      res.status(422).json({ error: 'Restaurant not found in database' });
    } else {
      throw err;
    }
  }
});

// DELETE /api/users/me/options/:restaurantId
router.delete('/me/options/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseRestaurantId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  await prisma.userOption.deleteMany({
    where: { userId: req.userId, restaurantId },
  });
  res.json({ message: 'Removed from options' });
});

// ── Accepted history ──────────────────────────────────────────

// GET /api/users/me/accepted
router.get('/me/accepted', async (req: Request, res: Response) => {
  const accepted = await prisma.userAccepted.findMany({
    where: { userId: req.userId },
    include: { restaurant: true },
    orderBy: { acceptedAt: 'desc' },
  });
  res.json({ accepted });
});

const VALID_CHOOSE_METHODS = new Set(['flip', 'spin', 'vote', 'surprise', 'direct']);

// POST /api/users/me/accepted
router.post('/me/accepted', async (req: Request, res: Response) => {
  const { restaurantId, optionsSnapshot, chooseMethod, excludeFromInsights } = req.body as {
    restaurantId?: number;
    optionsSnapshot?: unknown;
    chooseMethod?: unknown;
    excludeFromInsights?: unknown;
  };
  if (!restaurantId) {
    res.status(400).json({ error: 'restaurantId is required' });
    return;
  }
  if (!(await loadVisibleRestaurant(restaurantId, req.userId))) {
    res.status(404).json({ error: 'Restaurant not found' }); return;
  }

  // Snapshot is an array of stringy IDs, capped — a Json column is forgiving
  // but we don't want a misbehaving client pushing megabytes of payload here.
  let cleanSnapshot: string[] | undefined;
  if (optionsSnapshot !== undefined && optionsSnapshot !== null) {
    if (!Array.isArray(optionsSnapshot) || optionsSnapshot.length > 100) {
      res.status(400).json({ error: 'optionsSnapshot must be an array of ≤100 IDs' });
      return;
    }
    cleanSnapshot = optionsSnapshot
      .map((v) => String(v))
      .filter((s) => s.length > 0 && s.length <= 64);
  }

  let cleanMethod: string | undefined;
  if (chooseMethod !== undefined && chooseMethod !== null) {
    if (typeof chooseMethod !== 'string' || !VALID_CHOOSE_METHODS.has(chooseMethod)) {
      res.status(400).json({ error: `chooseMethod must be one of: ${[...VALID_CHOOSE_METHODS].join(', ')}` });
      return;
    }
    cleanMethod = chooseMethod;
  }

  // Default false matches the column default. Allowing the create caller
  // to set it up-front saves a follow-up PATCH for clients that already
  // know a pick should be excluded (e.g. a future "I didn't really want
  // this" affordance on the group-vote result modal).
  let cleanExclude: boolean | undefined;
  if (excludeFromInsights !== undefined && excludeFromInsights !== null) {
    if (typeof excludeFromInsights !== 'boolean') {
      res.status(400).json({ error: 'excludeFromInsights must be a boolean' });
      return;
    }
    cleanExclude = excludeFromInsights;
  }

  const record = await prisma.userAccepted.create({
    data: {
      userId: req.userId,
      restaurantId,
      // Prisma's Json input type rejects `undefined` differently from `null`;
      // omitting via spread keeps legacy clients (no snapshot) working unchanged.
      ...(cleanSnapshot !== undefined && { optionsSnapshot: cleanSnapshot }),
      chooseMethod: cleanMethod ?? null,
      ...(cleanExclude !== undefined && { excludeFromInsights: cleanExclude }),
    },
    include: { restaurant: true },
  });
  res.status(201).json({ accepted: record });
});

// PATCH /api/users/me/accepted/:id
//
// Per-entry toggle for the InsightsPage opt-out. Body: `{ excludeFromInsights: boolean }`.
// Ownership is enforced via `updateMany` with a `userId` filter — using
// `update({ where: { id } })` alone would either succeed (wrong owner)
// or throw P2025 on missing; updateMany returns `{ count }` which we
// branch on to distinguish "missing" from "not yours" cleanly (we treat
// both as 404 to avoid leaking row existence to other users).
router.patch('/me/accepted/:id', async (req: Request, res: Response) => {
  const acceptedId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(acceptedId) || acceptedId <= 0) {
    res.status(400).json({ error: 'accepted id must be a positive integer' });
    return;
  }

  const { excludeFromInsights } = req.body as { excludeFromInsights?: unknown };
  if (typeof excludeFromInsights !== 'boolean') {
    res.status(400).json({ error: 'excludeFromInsights must be a boolean' });
    return;
  }

  const { count } = await prisma.userAccepted.updateMany({
    where: { id: acceptedId, userId: req.userId },
    data: { excludeFromInsights },
  });
  if (count === 0) {
    res.status(404).json({ error: 'Accepted entry not found' });
    return;
  }

  const updated = await prisma.userAccepted.findUnique({
    where: { id: acceptedId },
    include: { restaurant: true },
  });
  res.json({ accepted: updated });
});

// ── Insights ──────────────────────────────────────────────────
//
// Aggregate analytics over the user's acceptance history. Compute in one pass
// over UserAccepted: a single findMany + an in-memory rollup, which is fine
// for any realistic per-user history size (acceptances are sparse).

// Insight tunables — see server/src/config/insights.ts for the rationale
// on each value (TIER_2_3_PLAN.md #14). Re-exporting the cap for the
// existing test that imports it from this module.
import {
  INSIGHT_WINDOW_DAYS,
  INSIGHTS_ALL_TIME_CAP_DAYS,
  NEGLECT_THRESHOLD_DAYS,
  SPARKLINE_WEEKS,
  DAY_MS,
} from '../config/insights';
export { INSIGHTS_ALL_TIME_CAP_DAYS };

// First Sunday cell of the sparkline window. Sunday of the week containing
// today, minus (SPARKLINE_WEEKS − 1) weeks. The current week is always the
// rightmost bucket, with prior weeks marching back in time. Aligning the
// start to Sunday keeps the week boundaries consistent across runs.
function sparklineWindowStartUtc(): Date {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sundayOfThisWeek = new Date(todayUtc);
  sundayOfThisWeek.setUTCDate(sundayOfThisWeek.getUTCDate() - todayUtc.getUTCDay());
  const start = new Date(sundayOfThisWeek);
  start.setUTCDate(start.getUTCDate() - (SPARKLINE_WEEKS - 1) * 7);
  return start;
}

// GET /api/users/me/insights?since=week|month|year|all
router.get('/me/insights', async (req: Request, res: Response) => {
  const userId = req.userId;

  const sinceParam = typeof req.query.since === 'string' ? req.query.since : 'all';
  const windowDays = INSIGHT_WINDOW_DAYS[sinceParam];
  // Resolve the lower-bound timestamp:
  //   - Explicit windowDays ('week'/'month'/'year') → slide from now.
  //   - 'all' (or any unknown value) → cap at INSIGHTS_ALL_TIME_CAP_DAYS
  //     so the rollup stays bounded. Previously this was null (unbounded);
  //     see TIER_2_3_PLAN.md #12 for the rationale.
  const effectiveWindowDays = windowDays ?? INSIGHTS_ALL_TIME_CAP_DAYS;
  const sinceDate = new Date(Date.now() - effectiveWindowDays * 24 * 60 * 60 * 1000);

  // ── Phase 1: kick off every independent query in parallel ────────────
  // These four queries don't depend on each other. Previously they ran
  // sequentially across the handler — for power users the first-paint
  // wait could exceed 400ms. Parallelizing collapses the wait to the
  // single slowest query.
  const sparklineStart = sparklineWindowStartUtc();
  const prevStart = windowDays ? new Date(Date.now() - 2 * windowDays * DAY_MS) : null;
  const prevEnd   = windowDays ? new Date(Date.now() - windowDays * DAY_MS) : null;

  const [rows, favoriteRows, sparklineRows, previousPeriodCountRaw] = await Promise.all([
    prisma.userAccepted.findMany({
      where: {
        userId,
        acceptedAt: { gte: sinceDate },
        // Per-entry opt-out from insights. Excluded rows still appear in
        // History (the user wants the visit logged) but drop out of every
        // aggregation here — totals, breakdowns, weekday heatmap, cuisine
        // trends, sparklines. The other UserAccepted reads below
        // (previousPeriodCount, sparklineRows, neglectedFavorites'
        // lastChosenRows) MUST also filter on this flag or the numbers
        // disagree across panels.
        excludeFromInsights: false,
      },
      select: {
        restaurantId: true,
        acceptedAt: true,
        optionsSnapshot: true,
        chooseMethod: true,
        // Surface eventId + groupId so the Insights page can deep-link recent
        // group-vote acceptances to their ballot detail. Solo acceptances have
        // null event, in which case both fields fall through as null.
        eventId: true,
        event: { select: { groupId: true } },
        restaurant: { select: { id: true, name: true, cuisineType: true } },
      },
      orderBy: { acceptedAt: 'desc' },
    }),
    prisma.userFavorite.findMany({
      where: { userId },
      include: { restaurant: { select: { id: true, name: true, cuisineType: true } } },
    }),
    prisma.userAccepted.findMany({
      where: { userId, acceptedAt: { gte: sparklineStart }, excludeFromInsights: false },
      select: {
        acceptedAt: true,
        restaurant: { select: { cuisineType: true } },
      },
    }),
    // Previous-period count for the "this month vs last month" delta. Only
    // computed when the user is viewing a windowed slice — there's no
    // "previous all-time", so we return null and the UI hides the indicator.
    prevStart && prevEnd
      ? prisma.userAccepted.count({
          where: { userId, acceptedAt: { gte: prevStart, lt: prevEnd }, excludeFromInsights: false },
        })
      : Promise.resolve(0),
  ]);

  // Single-pass roll-up.
  //
  // The original code iterated rows twice — once for wins/considered/methods,
  // then a second pass purely for cuisine-considered totals (because the
  // cuisineType for non-winner snapshot ids wasn't known until after the
  // filler-restaurant lookup). We can fold both passes into one by:
  //   1. Pre-collecting every snapshot id (and the winner ids).
  //   2. Building a single restaurantId → cuisineType map up front, using
  //      the joined `row.restaurant` for winners and a SINGLE batched
  //      findMany for the rest. (One query — same DB cost.)
  //   3. A single pass over rows that bumps wins + considered AND rolls up
  //      cuisineConsidered / cuisineChosen / methodCounts / weekdayCounts
  //      all at once.
  // On a power user with 200 acceptances × 5-id snapshots, this halves the
  // JS-side work (~1000 → ~500 ops in the hot loop).
  type RestStat = { name: string | null; cuisineType: string | null; considered: number; wins: number };

  // 1. Pre-collect every restaurant id that will need cuisine resolution.
  const allReferencedIds = new Set<string>();
  for (const row of rows) {
    allReferencedIds.add(String(row.restaurantId));
    if (Array.isArray(row.optionsSnapshot)) {
      for (const id of row.optionsSnapshot as unknown[]) {
        const idStr = String(id);
        if (idStr) allReferencedIds.add(idStr);
      }
    }
  }

  // 2. Seed the metadata map from joined winners; whatever's left needs one
  // batched lookup. Numeric guard skips custom-string IDs that won't have
  // a Restaurant row anyway.
  const restaurantMeta = new Map<string, { name: string | null; cuisineType: string | null }>();
  for (const row of rows) {
    if (row.restaurant) {
      restaurantMeta.set(String(row.restaurantId), {
        name: row.restaurant.name,
        cuisineType: row.restaurant.cuisineType,
      });
    }
  }
  const missingNumericIds = [...allReferencedIds]
    .filter((id) => !restaurantMeta.has(id))
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (missingNumericIds.length > 0) {
    const fillers = await prisma.restaurant.findMany({
      where:  { id: { in: missingNumericIds } },
      select: { id: true, name: true, cuisineType: true },
    });
    for (const r of fillers) {
      restaurantMeta.set(String(r.id), { name: r.name, cuisineType: r.cuisineType });
    }
  }

  // 3. Single pass: wins + considered + method + cuisine + weekday all at once.
  const stats = new Map<string, RestStat>();
  const ensure = (id: string): RestStat => {
    let entry = stats.get(id);
    if (!entry) {
      const meta = restaurantMeta.get(id);
      entry = { name: meta?.name ?? null, cuisineType: meta?.cuisineType ?? null, considered: 0, wins: 0 };
      stats.set(id, entry);
    }
    return entry;
  };

  const methodCounts: Record<string, number> = {};
  const cuisineConsidered: Record<string, number> = {};
  const cuisineChosen: Record<string, number> = {};
  // Index 0=Sunday … 6=Saturday, matching JS getDay(). We bucket by UTC day
  // because acceptedAt is stored as UTC; this is "close enough" for most users
  // and we can revisit with a tz param later if it matters.
  const weekdayCounts: number[] = [0, 0, 0, 0, 0, 0, 0];

  for (const row of rows) {
    const winnerId = String(row.restaurantId);
    const winnerEntry = ensure(winnerId);
    winnerEntry.wins += 1;
    if (winnerEntry.cuisineType) {
      cuisineChosen[winnerEntry.cuisineType] = (cuisineChosen[winnerEntry.cuisineType] ?? 0) + 1;
    }

    if (Array.isArray(row.optionsSnapshot)) {
      for (const id of row.optionsSnapshot as unknown[]) {
        const idStr = String(id);
        if (!idStr) continue;
        const entry = ensure(idStr);
        entry.considered += 1;
        if (entry.cuisineType) {
          cuisineConsidered[entry.cuisineType] = (cuisineConsidered[entry.cuisineType] ?? 0) + 1;
        }
      }
    }

    const method = row.chooseMethod ?? 'unknown';
    methodCounts[method] = (methodCounts[method] ?? 0) + 1;
    weekdayCounts[row.acceptedAt.getUTCDay()] += 1;
  }

  // ── Roll-ups ──
  const all = [...stats.entries()]
    .filter(([, v]) => v.considered > 0 || v.wins > 0)
    .map(([id, v]) => ({
      restaurantId: id,
      name: v.name ?? `Restaurant #${id}`,
      cuisineType: v.cuisineType,
      considered: v.considered,
      wins: v.wins,
      winRate: v.considered > 0 ? v.wins / v.considered : (v.wins > 0 ? 1 : 0),
    }));

  const topConsidered = [...all]
    .filter((r) => r.considered > 0)
    .sort((a, b) => b.considered - a.considered)
    .slice(0, 5);

  // "Often considered, never chosen" — entries with ≥ 2 considerations and 0 wins.
  // A threshold of 2 filters out one-off pool entries and surfaces real avoidance.
  const oftenSkipped = [...all]
    .filter((r) => r.considered >= 2 && r.wins === 0)
    .sort((a, b) => b.considered - a.considered)
    .slice(0, 5);

  const recent = rows.slice(0, 8).map((r) => ({
    restaurantId: String(r.restaurantId),
    name: r.restaurant?.name ?? `Restaurant #${r.restaurantId}`,
    acceptedAt: r.acceptedAt,
    chooseMethod: r.chooseMethod ?? null,
    // Present only when the acceptance came from a group event (post-rollout).
    // The page uses both ids together to deep-link into the ballot modal.
    eventId: r.eventId ?? null,
    groupId: r.event?.groupId ?? null,
    competing: Array.isArray(r.optionsSnapshot)
      ? (r.optionsSnapshot as unknown[])
          .map(String)
          .filter((id) => id !== String(r.restaurantId))
          .map((id) => stats.get(id)?.name ?? `Restaurant #${id}`)
      : [],
  }));

  // ── Variety score ──────────────────────────────────────────
  // Ratio of distinct restaurants chosen to total decisions, scaled to 0–10
  // and rounded to one decimal. "10/10" means every decision was a different
  // restaurant; "1/10" means you keep going to the same place.
  const totalDecisions   = rows.length;
  const distinctChosen   = new Set(rows.map((r) => r.restaurantId)).size;
  const varietyScore = totalDecisions > 0
    ? Math.round((distinctChosen / totalDecisions) * 100) / 10
    : 0;

  // ── Neglected favorites ────────────────────────────────────
  // Restaurants the user has favorited but hasn't picked in NEGLECT_THRESHOLD_DAYS
  // (or has never picked at all). This is computed against ALL UserAccepted —
  // not the current `since` window — because the whole point is "you haven't
  // chosen this in a long time," which only makes sense over full history.
  // favoriteRows was prefetched in Phase 1 above.
  let neglectedFavorites: Array<{
    restaurantId: string;
    name: string;
    cuisineType: string | null;
    lastChosenAt: string | null;
  }> = [];

  if (favoriteRows.length > 0) {
    const favIds = favoriteRows.map((f) => f.restaurantId);
    const lastChosenRows = (await prisma.userAccepted.groupBy({
      by: ['restaurantId'],
      // Excluded picks shouldn't count as "you chose this" for the neglect
      // calculation — a user who marks every visit to a place as off-the-record
      // intends for the place to feel un-chosen here too.
      where: { userId, restaurantId: { in: favIds }, excludeFromInsights: false },
      _max: { acceptedAt: true },
    })) ?? [];
    const lastChosen = new Map<number, Date>();
    for (const row of lastChosenRows) {
      if (row._max.acceptedAt) lastChosen.set(row.restaurantId, row._max.acceptedAt);
    }

    const cutoff = Date.now() - NEGLECT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
    neglectedFavorites = favoriteRows
      .map((f) => {
        const last = lastChosen.get(f.restaurantId) ?? null;
        return {
          restaurantId: String(f.restaurantId),
          name: f.restaurant.name,
          cuisineType: f.restaurant.cuisineType,
          lastChosenAt: last ? last.toISOString() : null,
          // Stash the raw timestamp for sorting; stripped before sending out
          _sortKey: last ? last.getTime() : -Infinity,
        };
      })
      .filter((f) => f._sortKey < cutoff)
      // Oldest (or never-chosen) first — the most "neglected" entry leads.
      .sort((a, b) => a._sortKey - b._sortKey)
      .slice(0, 5)
      // Drop the sort-only field on the way out
      .map(({ _sortKey: _unused, ...rest }) => rest);
  }

  // ── Cuisine sparklines — 12 weekly buckets, top 5 cuisines ────────────
  // sparklineRows was prefetched in Phase 1 above. Bucket index 0 is the
  // oldest week, so the sparkline reads left-to-right oldest→newest.
  const cuisineWeekly = new Map<string, number[]>();
  for (const row of sparklineRows) {
    const cuisine = row.restaurant?.cuisineType;
    if (!cuisine) continue; // skip uncategorized — the sparkline is per-cuisine
    if (!cuisineWeekly.has(cuisine)) {
      cuisineWeekly.set(cuisine, Array(SPARKLINE_WEEKS).fill(0));
    }
    const weekIdx = Math.min(
      SPARKLINE_WEEKS - 1,
      Math.max(0, Math.floor((row.acceptedAt.getTime() - sparklineStart.getTime()) / (7 * DAY_MS))),
    );
    cuisineWeekly.get(cuisine)![weekIdx] += 1;
  }
  // Top 5 cuisines by total acceptances in the window — matches the cuisine
  // table above. Cuisines that appear in `cuisineChosen` but had zero
  // acceptances in the last 12 weeks are excluded (a flat-zero sparkline is
  // not informative).
  const cuisineWeeklyCounts: Record<string, number[]> = {};
  [...cuisineWeekly.entries()]
    .map(([cuisine, weeks]) => ({ cuisine, total: weeks.reduce((a, b) => a + b, 0), weeks }))
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .forEach((x) => { cuisineWeeklyCounts[x.cuisine] = x.weeks; });

  // ── Previous-period count (for "this month vs last month" delta) ──────
  // previousPeriodCountRaw was prefetched in Phase 1; the UI hides the
  // indicator when no window is in effect, so we surface null in that case.
  const previousPeriodCount: number | null = windowDays ? (previousPeriodCountRaw ?? 0) : null;

  res.json({
    totalDecisions,
    distinctChosen,
    varietyScore,
    since: sinceParam,
    previousPeriodCount,
    methodCounts,
    cuisineConsidered,
    cuisineChosen,
    cuisineWeeklyCounts,
    weekdayCounts,
    topConsidered,
    oftenSkipped,
    neglectedFavorites,
    recent,
  });
});

// ── Archives ──────────────────────────────────────────────────

// GET /api/users/me/archived
router.get('/me/archived', async (req: Request, res: Response) => {
  const archived = await prisma.userArchive.findMany({
    where: { userId: req.userId },
    include: { restaurant: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ archived: archived.map((a) => a.restaurant) });
});

// POST /api/users/me/archived/:restaurantId
router.post('/me/archived/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseRestaurantId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  if (!(await loadVisibleRestaurant(restaurantId, req.userId))) {
    res.status(404).json({ error: 'Restaurant not found' }); return;
  }
  await prisma.userArchive.upsert({
    where: { userId_restaurantId: { userId: req.userId, restaurantId } },
    create: { userId: req.userId, restaurantId },
    update: {},
  });
  res.status(201).json({ message: 'Archived' });
});

// DELETE /api/users/me/archived/:restaurantId
router.delete('/me/archived/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseRestaurantId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  await prisma.userArchive.deleteMany({
    where: { userId: req.userId, restaurantId },
  });
  res.json({ message: 'Unarchived' });
});

// ── Reviews ───────────────────────────────────────────────────

// GET /api/users/me/reviews — all of the current user's reviews, optionally filtered by restaurant
router.get('/me/reviews', async (req: Request, res: Response) => {
  const restaurantId = req.query.restaurantId ? Number(req.query.restaurantId) : undefined;
  const reviews = await prisma.review.findMany({
    where: { userId: req.userId, ...(restaurantId && { restaurantId }) },
    include: { restaurant: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ reviews });
});

// POST /api/users/me/reviews
router.post('/me/reviews', async (req: Request, res: Response) => {
  const { restaurantId, rating, content } = req.body as {
    restaurantId?: unknown;
    rating?: unknown;
    content?: unknown;
  };

  // restaurantId must be a positive integer — pass NaN/3.14/"5" through to
  // Prisma and you get a confusing 500 instead of a clean 400.
  if (typeof restaurantId !== 'number' || !Number.isInteger(restaurantId) || restaurantId <= 0) {
    res.status(400).json({ error: 'restaurantId must be a positive integer' });
    return;
  }
  // Privacy gate: reviewing a private row owned by another user would
  // both expose the row through the review->restaurant join AND skew its
  // cached community rating with off-platform input.
  if (!(await loadVisibleRestaurant(restaurantId, req.userId))) {
    res.status(404).json({ error: 'Restaurant not found' }); return;
  }
  // rating must be a finite number in 1..5. The old check `rating < 1 || rating > 5`
  // accepts NaN (NaN compares false in both directions) and Infinity (Infinity > 5 — fine
  // but Decimal storage rejects it later anyway). Tighten here so the error is the
  // caller's, not Prisma's.
  if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 1 || rating > 5) {
    res.status(400).json({ error: 'rating must be a finite number between 1 and 5' });
    return;
  }
  // Content is optional but capped — storing megabyte reviews is not a feature.
  let cleanContent: string | undefined;
  if (content !== undefined && content !== null) {
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content must be a string' }); return;
    }
    if (content.length > MAX_REVIEW_CONTENT) {
      res.status(400).json({ error: `content must be ${MAX_REVIEW_CONTENT} characters or fewer` }); return;
    }
    cleanContent = content;
  }

  const review = await prisma.review.create({
    data: { userId: req.userId, restaurantId, rating, content: cleanContent ?? null },
    include: { restaurant: true },
  });
  recomputeCommunityRating(restaurantId).catch((err) => console.warn('[communityRating] recompute failed:', err));
  res.status(201).json({ review });
});

// PATCH /api/users/me/reviews/:reviewId — edit content + rating on an
// existing review. Useful for typo fixes and rating revisions without
// losing the original createdAt timestamp. Same validation rules as the
// POST handler; both fields are optional but at least one must change
// the row (no-op patches just succeed). Recomputes the cached community
// rating only when the rating actually changed.
router.patch('/me/reviews/:reviewId', async (req: Request, res: Response) => {
  const reviewId = parseInt(req.params.reviewId, 10);
  if (!Number.isInteger(reviewId) || reviewId <= 0) {
    res.status(400).json({ error: 'Invalid review ID' });
    return;
  }

  const existing = await prisma.review.findFirst({
    where: { id: reviewId, userId: req.userId },
    select: { restaurantId: true, rating: true },
  });
  if (!existing) { res.status(404).json({ error: 'Review not found' }); return; }

  const { rating, content } = req.body as { rating?: unknown; content?: unknown };

  const data: { rating?: number; content?: string | null } = {};

  if (rating !== undefined) {
    if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 1 || rating > 5) {
      res.status(400).json({ error: 'rating must be a finite number between 1 and 5' });
      return;
    }
    data.rating = rating;
  }

  if (content !== undefined) {
    if (content === null || content === '') {
      data.content = null;
    } else if (typeof content !== 'string') {
      res.status(400).json({ error: 'content must be a string' }); return;
    } else if (content.length > MAX_REVIEW_CONTENT) {
      res.status(400).json({ error: `content must be ${MAX_REVIEW_CONTENT} characters or fewer` }); return;
    } else {
      data.content = content;
    }
  }

  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: 'No editable fields provided' }); return;
  }

  const review = await prisma.review.update({
    where: { id: reviewId },
    data,
    include: { restaurant: true },
  });

  // Only recompute the community aggregate if the rating moved — content-only
  // edits don't affect any cached number.
  if (data.rating !== undefined && Number(existing.rating) !== data.rating) {
    recomputeCommunityRating(existing.restaurantId).catch((err) =>
      console.warn('[communityRating] recompute failed:', err));
  }

  res.json({ review });
});

// DELETE /api/users/me/reviews/:reviewId
router.delete('/me/reviews/:reviewId', async (req: Request, res: Response) => {
  const reviewId = parseInt(req.params.reviewId, 10);
  if (!Number.isInteger(reviewId) || reviewId <= 0) {
    res.status(400).json({ error: 'Invalid review ID' });
    return;
  }

  const review = await prisma.review.findFirst({ where: { id: reviewId, userId: req.userId }, select: { restaurantId: true } });
  if (!review) { res.status(404).json({ error: 'Review not found' }); return; }

  await prisma.review.deleteMany({ where: { id: reviewId, userId: req.userId } });
  recomputeCommunityRating(review.restaurantId).catch((err) => console.warn('[communityRating] recompute failed:', err));
  res.json({ message: 'Review deleted' });
});

// ── History wipe ──────────────────────────────────────────────

// DELETE /api/users/me/history/:restaurantId
// Removes ALL of this user's traces of one restaurant: favorites, options,
// archives, accepted history, and reviews. Used by the History page's "delete"
// action. Atomic so the UI's local optimistic update can't drift from the DB.
router.delete('/me/history/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseRestaurantId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }

  const hadReviews = await prisma.review.count({ where: { userId: req.userId, restaurantId } });

  await prisma.$transaction([
    prisma.userFavorite.deleteMany({ where: { userId: req.userId, restaurantId } }),
    prisma.userOption.deleteMany({ where: { userId: req.userId, restaurantId } }),
    prisma.userArchive.deleteMany({ where: { userId: req.userId, restaurantId } }),
    prisma.userAccepted.deleteMany({ where: { userId: req.userId, restaurantId } }),
    prisma.review.deleteMany({ where: { userId: req.userId, restaurantId } }),
  ]);

  if (hadReviews > 0) {
    recomputeCommunityRating(restaurantId).catch((err) => console.warn('[communityRating] recompute failed:', err));
  }
  res.json({ message: 'Removed from history' });
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

// ── Stale Google Places data refresh ─────────────────────────

const PLACE_PRICE_LEVEL_MAP: Record<string, number | null> = {
  PRICE_LEVEL_FREE:           null,
  PRICE_LEVEL_INEXPENSIVE:    1,
  PRICE_LEVEL_MODERATE:       2,
  PRICE_LEVEL_EXPENSIVE:      3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

// `location` requested so we can back-fill lat/lng on stale rows that
// were created before the lat/lng columns existed. New rows already
// store coords at create time; this catches the legacy rows.
//
// `photos` / `userRatingCount` were added alongside the
// Search/Compare/Choose card redesign so the UI can show photos +
// rating-count breakdown without a per-card Places API call. Reviews
// are intentionally NOT requested — `reviews` is Enterprise-tier and
// roughly doubles the per-call cost. Users get a "View on Google"
// deep-link to the place's Maps page instead.
const DETAIL_FIELD_MASK = [
  'rating', 'userRatingCount', 'priceLevel',
  'takeout', 'delivery',
  'internationalPhoneNumber', 'websiteUri',
  'location',
  'photos',
  // Structured weekly hours — drives the detail modal's hours table
  // AND the open-now / closing-soon indicator on the modal/card. Pro
  // tier, same SKU bucket as the rest of this mask.
  'regularOpeningHours',
].join(',');
// Bumped from 30 to 90 — restaurant photos/phone/website rarely
// change inside a 90-day window, and refresh-places is the single
// most-spent endpoint when a user has a long history of saved
// restaurants. The 30-day default was over-aggressive given the
// kind of data we cache; 90 days cuts refresh spend by ~67% with
// effectively zero perceived staleness. If a specific row really
// needs fresher data, the new on-demand-refresh-on-modal-open
// pattern (planned Tier 2A) covers the hot path.
const STALE_DAYS = 90;
const MAX_PER_SESSION = 20; // cap API calls per login

// Shared helper: fetch fresh Place Details from Google and apply
// them to one Restaurant row. Returns the updated row on success,
// or null on any failure (network / non-200 / shape mismatch).
//
// Used by:
//   - POST /me/refresh-places (batch — refreshes up to N stale rows
//                              for the user in one shot, on demand)
//   - POST /restaurants/:id/refresh-if-stale (single-row — fired by
//                              the detail modal on open, only when
//                              the row is actually stale; cuts
//                              Place Details spend in proportion to
//                              what the user actually views)
//
// Pulled to module scope so both endpoints share one canonical
// transform — previously the field-extraction logic lived inline in
// refresh-places and would drift if duplicated.
async function refreshOnePlace(
  row: { id: number; googlePlaceId: string | null },
  apiKey: string,
  req: Request,
): Promise<Awaited<ReturnType<typeof prisma.restaurant.update>> | null> {
  if (!row.googlePlaceId) return null;
  try {
    const detailRes = await fetch(
      `https://places.googleapis.com/v1/places/${row.googlePlaceId}`,
      { headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': DETAIL_FIELD_MASK } },
    );
    if (!detailRes.ok) {
      console.warn(`[refresh] Place Details failed for ${row.googlePlaceId}: ${detailRes.status}`);
      trackGoogleCall(req, 'placeDetails', { status: 'error' });
      return null;
    }
    trackGoogleCall(req, 'placeDetails');
    const detail = await detailRes.json() as Record<string, unknown>;

    const patch: Prisma.RestaurantUpdateInput = { googleDataUpdatedAt: new Date() };
    if (typeof detail.rating === 'number')           patch.googleRating = detail.rating;
    if (typeof detail.userRatingCount === 'number' && Number.isInteger(detail.userRatingCount))
                                                      patch.ratingCount = detail.userRatingCount;
    if (typeof detail.priceLevel === 'string' && detail.priceLevel in PLACE_PRICE_LEVEL_MAP)
                                                      patch.priceLevel = PLACE_PRICE_LEVEL_MAP[detail.priceLevel];
    if (typeof detail.takeout === 'boolean')          patch.takeout = detail.takeout;
    if (typeof detail.delivery === 'boolean')         patch.delivery = detail.delivery;
    if (typeof detail.internationalPhoneNumber === 'string') patch.phone = detail.internationalPhoneNumber;
    if (typeof detail.websiteUri === 'string')        patch.website = detail.websiteUri;
    const loc = detail.location as { latitude?: number; longitude?: number } | undefined;
    if (loc && typeof loc.latitude === 'number'  && Number.isFinite(loc.latitude))  patch.lat = loc.latitude;
    if (loc && typeof loc.longitude === 'number' && Number.isFinite(loc.longitude)) patch.lng = loc.longitude;
    if (Array.isArray(detail.photos)) {
      const photosSan = (detail.photos as Array<Record<string, unknown>>).slice(0, 10)
        .filter((p) => typeof p?.name === 'string')
        .map((p) => ({
          name:     p.name,
          widthPx:  typeof p.widthPx  === 'number' ? p.widthPx  : null,
          heightPx: typeof p.heightPx === 'number' ? p.heightPx : null,
        }));
      if (photosSan.length > 0) patch.photos = photosSan as unknown as Prisma.InputJsonValue;
    }
    const rawHours = detail.regularOpeningHours;
    if (rawHours && typeof rawHours === 'object') {
      const obj = rawHours as Record<string, unknown>;
      const periods: Array<{ open: { day: number; hour: number; minute: number };
                             close: { day: number; hour: number; minute: number } | null }> = [];
      const cleanPoint = (pt: unknown) => {
        if (!pt || typeof pt !== 'object') return null;
        const x = pt as Record<string, unknown>;
        const day    = typeof x.day    === 'number' && x.day    >= 0 && x.day    <= 6  ? Math.floor(x.day)    : null;
        const hour   = typeof x.hour   === 'number' && x.hour   >= 0 && x.hour   <= 23 ? Math.floor(x.hour)   : null;
        const minute = typeof x.minute === 'number' && x.minute >= 0 && x.minute <= 59 ? Math.floor(x.minute) : null;
        if (day === null || hour === null || minute === null) return null;
        return { day, hour, minute };
      };
      const rawPeriods = Array.isArray(obj.periods) ? obj.periods : [];
      for (const period of rawPeriods.slice(0, 30)) {
        if (!period || typeof period !== 'object') continue;
        const p = period as Record<string, unknown>;
        const open  = cleanPoint(p.open);
        if (!open) continue;
        const close = cleanPoint(p.close);
        periods.push({ open, close });
      }
      const rawDescs = Array.isArray(obj.weekdayDescriptions) ? obj.weekdayDescriptions : [];
      const weekdayDescriptions = rawDescs
        .slice(0, 7)
        .filter((s: unknown): s is string => typeof s === 'string')
        .map((s) => s.slice(0, 200));
      if (periods.length > 0 || weekdayDescriptions.length > 0) {
        patch.regularOpeningHours = ({ periods, weekdayDescriptions } as unknown) as Prisma.InputJsonValue;
      }
    }

    return await prisma.restaurant.update({ where: { id: row.id }, data: patch });
  } catch (err) {
    console.warn(`[refresh] Error refreshing restaurant ${row.id} (${row.googlePlaceId}):`, err);
    trackGoogleCall(req, 'placeDetails', { status: 'error' });
    return null;
  }
}

// POST /api/users/me/refresh-places
// Finds this user's Google-sourced restaurants not updated in the last 30 days and refreshes them.
// Hits the paid Google Places API per record, so it gets the stricter external limiter.
router.post('/me/refresh-places', externalApiLimiter, async (req: Request, res: Response) => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    res.json({ updated: [] });
    return;
  }

  const staleThreshold = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

  const userLinks = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      favorites: { select: { restaurantId: true } },
      options:   { select: { restaurantId: true } },
      accepted:  { select: { restaurantId: true } },
      // Archived rows now ride along on the regular stale sweep so
      // a row that gets unarchived months later doesn't surface with
      // year-old data. The marginal cost is tiny (typical user has
      // ~10 archived rows; 30-day stale-threshold caps the refresh
      // rate; refresh-places is the cheapest of the Google API
      // calls at ~$0.017/row) and stale-archived rows were the
      // most common "where's my photos / phone / etc." complaint.
      // Relation name on User is `archives` (plural), not `archived`.
      archives:  { select: { restaurantId: true } },
    },
  });

  if (!userLinks) { res.json({ updated: [] }); return; }

  const linkedIds = [...new Set([
    ...userLinks.favorites.map((f) => f.restaurantId),
    ...userLinks.options.map((o) => o.restaurantId),
    ...userLinks.accepted.map((a) => a.restaurantId),
    ...userLinks.archives.map((a) => a.restaurantId),
  ])];

  if (linkedIds.length === 0) { res.json({ updated: [] }); return; }

  const stale = await prisma.restaurant.findMany({
    take: MAX_PER_SESSION,
    where: {
      id: { in: linkedIds },
      googlePlaceId: { not: null },
      OR: [
        { googleDataUpdatedAt: null },
        { googleDataUpdatedAt: { lt: staleThreshold } },
        // Critical-data backfill: rows with a placeId but no
        // photos got their timestamp set by an earlier refresh
        // pass that didn't capture photos (or by some other path
        // that bumped the timestamp without populating media).
        // Without this branch, those rows look "fresh" forever
        // even though they're missing the most user-visible
        // field. Cheap to add — every Google call returns photos
        // for places that have any, so this self-heals on next
        // visit. `Prisma.DbNull` matches the column's SQL-level
        // NULL (the JsonNull sentinel matches a stored JSON `null`
        // value, which is a different concept).
        { photos: { equals: Prisma.DbNull } },
      ],
    },
    orderBy: { googleDataUpdatedAt: 'asc' }, // refresh oldest first
  });

  if (stale.length === 0) { res.json({ updated: [] }); return; }

  console.log(`[refresh] Refreshing ${stale.length} stale restaurant(s)`);

  // Refresh each stale place in parallel via the shared helper.
  // Promise.all collapses N round-trips of ~200-400ms each into the
  // slowest single round-trip. refreshOnePlace returns null on any
  // failure (its own try/catch); we filter those out at the end.
  // googleReviews column is intentionally not refreshed — see
  // DETAIL_FIELD_MASK comment for the SKU rationale.
  const results = await Promise.all(
    stale.map((r) => refreshOnePlace(r, apiKey, req)),
  );
  const updated = results.filter((r): r is NonNullable<typeof r> => r !== null);

  console.log(`[refresh] Updated ${updated.length} restaurant(s)`);
  res.json({ updated });
});

// POST /api/users/me/refresh-restaurant/:id
// "Just-in-time" single-row refresh — fired by the detail modal on
// open so we only spend Place Details quota on restaurants the user
// is actually looking at. Replaces the eager "refresh every saved
// restaurant" batching for the typical case where a user views 5
// of their 50 saved rows in a given session.
//
// Three response shapes:
//   1. `{ refreshed: true,  restaurant }`  — row was stale, we
//      refreshed and return the updated row
//   2. `{ refreshed: false, restaurant: null }` — row was fresh
//      (last refresh < STALE_DAYS ago) OR not a Google Place row
//      (custom rows have no upstream to refresh from)
//   3. `{ refreshed: false, restaurant: null }` on error too — we
//      degrade silently rather than failing the modal open
//
// Visibility-gated like the read paths: private rows visible only
// to the creator. Auth required since this spends API quota.
router.post('/me/refresh-restaurant/:id', perRowRefreshLimiter, async (req: Request, res: Response) => {
  const restaurantId = Number(req.params.id);
  if (!Number.isInteger(restaurantId) || restaurantId <= 0) {
    res.status(400).json({ error: 'Invalid restaurant ID' });
    return;
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) { res.json({ refreshed: false, restaurant: null }); return; }

  // Cheap precheck — pull only the columns we need to decide
  // whether to spend a Google call. No findUniqueOrThrow; absent
  // rows fall through to a 200 no-op so modal opens don't error.
  const row = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      googlePlaceId: true,
      googleDataUpdatedAt: true,
      // Pulled so the staleness check can ALSO trigger a refresh
      // when photos are missing — see the "critical-data
      // backfill" branch below.
      photos: true,
      private: true,
      createdBy: true,
    },
  });
  if (!row) { res.json({ refreshed: false, restaurant: null }); return; }

  // Visibility: private rows only visible to creator. Match the
  // GET /api/restaurants/:id behavior so the modal doesn't refresh
  // a row it couldn't read.
  if (row.private && row.createdBy !== req.userId) {
    res.json({ refreshed: false, restaurant: null });
    return;
  }

  // Custom (no googlePlaceId) rows have nothing to refresh — they
  // were user-typed, not Google-sourced.
  if (!row.googlePlaceId) {
    res.json({ refreshed: false, restaurant: null });
    return;
  }

  // Already-fresh rows skip the Google call entirely. This is the
  // common path once a user has a warm cache: same row opened
  // twice in a week pays for the first open, not the second.
  //
  // Exception: if `photos` is null we ALWAYS refresh, regardless
  // of the timestamp. Rows from before the photos column was
  // captured (or refreshed by an earlier pass that didn't request
  // photos) carry a recent timestamp but null photos — without
  // this branch they'd stay photo-less forever because the staleness
  // check would skip them. Every Google call returns photos for
  // places that have any, so this self-heals on first detail-modal
  // open and is cheap (one call per stuck row, one time only).
  const staleThreshold = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
  const photosMissing = row.photos == null;
  const timestampFresh = row.googleDataUpdatedAt && row.googleDataUpdatedAt > staleThreshold;
  if (timestampFresh && !photosMissing) {
    res.json({ refreshed: false, restaurant: null });
    return;
  }

  // Stale → one Place Details call via the shared helper.
  const updated = await refreshOnePlace(row, apiKey, req);
  if (!updated) { res.json({ refreshed: false, restaurant: null }); return; }
  res.json({ refreshed: true, restaurant: updated });
});

// Wire the background-refresh job's late-bound dependency. Module-level
// side effect on import; safe because `registerBackgroundRefresher`
// just stores the function pointer — the job doesn't fire until
// `startBackgroundRefresh()` is called from index.ts at boot.
// See server/src/lib/backgroundRefresh.ts for the rationale on the
// late-binding pattern (avoids a circular import between users.ts and
// the bg refresh module).
import { registerBackgroundRefresher } from '../lib/backgroundRefresh';
registerBackgroundRefresher(refreshOnePlace);

export default router;
