import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { writeLimiter, externalApiLimiter } from '../middleware/rateLimits';
import { validatePassword } from './auth';
import { issueToken } from '../lib/emailTokens';
import { sendEmail, verifyEmailTemplate } from '../lib/email';
import { logger } from '../lib/logger';

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
// project them server-side to slim the response by ~40%. Anything not in
// here is unused at the call site; if you need a new field on cards, add
// it here AND in the addCustomRestaurant mapping in the slice.
const RESTAURANT_CARD_SELECT = {
  id: true,
  name: true,
  cuisineType: true,
  priceLevel: true,
  googleRating: true,
  hours: true,
  phone: true,
  website: true,
  yelpUrl: true,
  takeout: true,
  delivery: true,
  googlePlaceId: true,
  // Needed for the Compare-page map. ~16 bytes per row — negligible
  // payload addition. Frontend skips rows where these are null.
  lat: true,
  lng: true,
} as const;

router.get('/me/all', async (req: Request, res: Response) => {
  const [favRows, optRows, accRows, arcRows, revRows, addrRows] = await Promise.all([
    prisma.userFavorite.findMany({
      where: { userId: req.userId },
      select: { restaurant: { select: RESTAURANT_CARD_SELECT } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.userOption.findMany({
      where: { userId: req.userId },
      select: { restaurant: { select: RESTAURANT_CARD_SELECT } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.userAccepted.findMany({
      where: { userId: req.userId },
      // Only restaurantId + acceptedAt are read here; the slice doesn't
      // touch optionsSnapshot / chooseMethod / eventId in this path
      // (Insights has its own endpoint that fetches those).
      select: { restaurantId: true, acceptedAt: true },
      orderBy: { acceptedAt: 'desc' },
    }),
    prisma.userArchive.findMany({
      where: { userId: req.userId },
      select: { restaurant: { select: RESTAURANT_CARD_SELECT } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.review.findMany({
      where: { userId: req.userId },
      // Slice reads id, content, rating, restaurantId, createdAt; restaurant
      // is also walked so we populate customRestaurants on hydrate.
      select: {
        id: true,
        content: true,
        rating: true,
        restaurantId: true,
        createdAt: true,
        restaurant: { select: RESTAURANT_CARD_SELECT },
      },
      orderBy: { createdAt: 'desc' },
    }),
    // Address book — same ordering as the dedicated /me/addresses
    // endpoint so the Search-page dropdown gets the default first.
    prisma.savedAddress.findMany({
      where: { userId: req.userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    }),
  ]);

  res.json({
    favorites: favRows.map((f) => f.restaurant),
    options: optRows.map((o) => o.restaurant),
    accepted: accRows,
    archived: arcRows.map((a) => a.restaurant),
    reviews: revRows,
    addresses: addrRows,
  });
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
router.delete('/me/favorites/:restaurantId', async (req: Request, res: Response) => {
  const restaurantId = parseRestaurantId(req.params.restaurantId);
  if (!restaurantId) { res.status(400).json({ error: 'Invalid restaurant ID' }); return; }
  await prisma.userFavorite.deleteMany({
    where: { userId: req.userId, restaurantId },
  });
  res.json({ message: 'Removed from favorites' });
});

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
  const { restaurantId, optionsSnapshot, chooseMethod } = req.body as {
    restaurantId?: number;
    optionsSnapshot?: unknown;
    chooseMethod?: unknown;
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

  const record = await prisma.userAccepted.create({
    data: {
      userId: req.userId,
      restaurantId,
      // Prisma's Json input type rejects `undefined` differently from `null`;
      // omitting via spread keeps legacy clients (no snapshot) working unchanged.
      ...(cleanSnapshot !== undefined && { optionsSnapshot: cleanSnapshot }),
      chooseMethod: cleanMethod ?? null,
    },
    include: { restaurant: true },
  });
  res.status(201).json({ accepted: record });
});

// ── Insights ──────────────────────────────────────────────────
//
// Aggregate analytics over the user's acceptance history. Compute in one pass
// over UserAccepted: a single findMany + an in-memory rollup, which is fine
// for any realistic per-user history size (acceptances are sparse).

// Window options accepted by /me/insights — sliding from "now" rather than
// calendar boundaries so "this week" doesn't reset every Monday. `all` is the
// default and stays unbounded.
const INSIGHT_WINDOW_DAYS: Record<string, number> = {
  week:  7,
  month: 30,
  year:  365,
};

// "Neglected" = a favorite the user hasn't picked in this many days (or ever).
// 60 days feels right — long enough that a "hey, remember this place?" nudge
// is welcome, short enough that the list isn't empty for active users.
const NEGLECT_THRESHOLD_DAYS = 60;

// Cuisine sparklines show 12 weekly buckets, independent of the `since`
// dropdown — the trend line is most readable as a fixed window so filter
// changes don't redraw it.
const SPARKLINE_WEEKS = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  const sinceDate  = windowDays ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000) : null;

  const rows = await prisma.userAccepted.findMany({
    where: {
      userId,
      ...(sinceDate && { acceptedAt: { gte: sinceDate } }),
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
  });

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
  // `?? []` guards against jest automocks that resolve to undefined for any
  // Prisma call we haven't explicitly mocked in a given test. Real Prisma
  // always returns an array here, so this is a test-only fallback.
  const favoriteRows = (await prisma.userFavorite.findMany({
    where: { userId },
    include: { restaurant: { select: { id: true, name: true, cuisineType: true } } },
  })) ?? [];

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
      where: { userId, restaurantId: { in: favIds } },
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
  // A small dedicated query over the last 12 weeks of acceptances. Selects
  // only acceptedAt + cuisineType to keep the payload tiny. Bucket index 0 is
  // the oldest week, so the sparkline reads left-to-right oldest→newest.
  const sparklineStart = sparklineWindowStartUtc();
  const sparklineRows = (await prisma.userAccepted.findMany({
    where: { userId, acceptedAt: { gte: sparklineStart } },
    select: {
      acceptedAt: true,
      restaurant: { select: { cuisineType: true } },
    },
  })) ?? [];

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
  // Only computed when the user is viewing a windowed slice — there's no
  // "previous all-time", so we return null and the UI hides the indicator.
  let previousPeriodCount: number | null = null;
  if (windowDays) {
    const prevStart = new Date(Date.now() - 2 * windowDays * DAY_MS);
    const prevEnd   = new Date(Date.now() - windowDays * DAY_MS);
    previousPeriodCount = await prisma.userAccepted.count({
      where: { userId, acceptedAt: { gte: prevStart, lt: prevEnd } },
    }) ?? 0;
  }

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
const STALE_DAYS = 30;
const MAX_PER_SESSION = 20; // cap API calls per login

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
    },
  });

  if (!userLinks) { res.json({ updated: [] }); return; }

  const linkedIds = [...new Set([
    ...userLinks.favorites.map((f) => f.restaurantId),
    ...userLinks.options.map((o) => o.restaurantId),
    ...userLinks.accepted.map((a) => a.restaurantId),
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
      ],
    },
    orderBy: { googleDataUpdatedAt: 'asc' }, // refresh oldest first
  });

  if (stale.length === 0) { res.json({ updated: [] }); return; }

  console.log(`[refresh] Refreshing ${stale.length} stale restaurant(s)`);

  // Refresh each stale place in parallel. The old `for…await` loop
  // serialized N Google Places round-trips (~200-400ms each); with
  // MAX_PER_SESSION up to 20, that was 4-8s of pure latency. Promise.all
  // collapses that to roughly the slowest single round-trip.
  //
  // Each iteration is a small contained task with its own try/catch — a
  // failure on one place doesn't affect the others. Returning `null`
  // marks a skip; filterMap below drops them.
  const results = await Promise.all(stale.map(async (r) => {
    try {
      const detailRes = await fetch(
        `https://places.googleapis.com/v1/places/${r.googlePlaceId}`,
        { headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': DETAIL_FIELD_MASK } },
      );
      if (!detailRes.ok) {
        console.warn(`[refresh] Place Details failed for ${r.googlePlaceId}: ${detailRes.status}`);
        return null;
      }
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
      // Back-fill coords on rows created before the lat/lng columns
      // existed (or rows whose initial create somehow missed them).
      const loc = detail.location as { latitude?: number; longitude?: number } | undefined;
      if (loc && typeof loc.latitude === 'number'  && Number.isFinite(loc.latitude))  patch.lat = loc.latitude;
      if (loc && typeof loc.longitude === 'number' && Number.isFinite(loc.longitude)) patch.lng = loc.longitude;
      // Photos are JSON. We normalize into the same shape as the
      // materialize endpoint persists so frontend consumers see one
      // schema regardless of which write path produced the row.
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
      // Structured opening hours. Same shape constraints as the
      // materialize-time sanitizer in restaurants.ts — kept inline here
      // to avoid a cross-route import. Drops anything that doesn't
      // shape-match.
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
      // googleReviews column stays in the schema but we no longer
      // refresh it — see DETAIL_FIELD_MASK comment for the cost
      // rationale. Existing rows with cached reviews are left alone.

      return await prisma.restaurant.update({ where: { id: r.id }, data: patch });
    } catch (err) {
      console.warn(`[refresh] Error refreshing restaurant ${r.id} (${r.googlePlaceId}):`, err);
      return null;
    }
  }));
  const updated = results.filter((r): r is NonNullable<typeof r> => r !== null);

  console.log(`[refresh] Updated ${updated.length} restaurant(s)`);
  res.json({ updated });
});

export default router;
