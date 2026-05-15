import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import passport from 'passport';
import rateLimit from 'express-rate-limit';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as FacebookStrategy } from 'passport-facebook';
import prisma from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { sendEmail, verifyEmailTemplate, passwordResetTemplate } from '../lib/email';
import { issueToken, consumeToken } from '../lib/emailTokens';
import { logger } from '../lib/logger';

const router = Router();

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

const SESSION_DURATION = '7d';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  maxAge: SESSION_MAX_AGE_MS,
};

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many requests, please try again later' },
});

// Stricter limit for password-reset / resend-verify to slow email-flooding abuse.
const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many email requests, please try again later' },
});

// Pre-computed bcrypt hash used as a timing dummy when no real hash exists.
// Ensures bcrypt.compare always runs regardless of whether the account exists.
const DUMMY_HASH = '$2a$12$KIXxwf7pVdaFGaFVMxJAOuLgc0X1Xk6pJz9mV3RwUqHnYeD5tsBqS';

// Minimum requirements: ≥8 chars and at least one letter + one number.
// Generous on symbols/length to avoid frustrating real users; tight enough
// to block trivial passwords like "password" / "12345678".
const MIN_PASSWORD_LEN = 8;
export function validatePassword(pw: unknown): string | null {
  if (typeof pw !== 'string') return 'password is required';
  if (pw.length < MIN_PASSWORD_LEN) return `password must be at least ${MIN_PASSWORD_LEN} characters`;
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    return 'password must contain at least one letter and one number';
  }
  return null;
}

// ── Username generation ───────────────────────────────────────

async function generateUniqueUsername(base: string): Promise<string> {
  const slug = base.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
  let candidate = slug;
  // 6-digit crypto-random suffix — wider than the original 4-digit space (1e6
  // vs 9e3) so collision retries are rare, and using the CSPRNG over Math.random
  // means an attacker probing for OAuth-account-name patterns can't predict them.
  // username column is citext (see prisma/schema.prisma) — equality is
  // case-insensitive at the DB level and uses the unique B-tree index.
  // Dropped `mode: 'insensitive'` to take the simple `=` planner path.
  while (await prisma.user.findFirst({ where: { username: { equals: candidate } } })) {
    candidate = `${slug}${100000 + crypto.randomInt(900000)}`;
  }
  return candidate;
}

// ── OAuth find-or-create ──────────────────────────────────────

async function findOrCreateOAuthUser(
  provider: string,
  providerId: string,
  email: string | undefined,
  displayName: string,
  avatarUrl?: string,
  // The provider must vouch that this email is verified before we'll link the
  // OAuth login to an existing email-password account with the same address.
  // Without this guard, an OAuth provider that returns unverified emails would
  // become an account-takeover vector: attacker registers OAuth under a
  // victim's email, gets logged in as the victim. Google and Supabase mark
  // verified addresses explicitly; Facebook never passes an email through here.
  emailVerified: boolean = false,
) {
  // 1. Existing OAuth link — update avatar if it changed
  const linked = await prisma.oAuthAccount.findUnique({
    where: { provider_providerId: { provider, providerId } },
    include: { user: true },
  });
  if (linked) {
    if (avatarUrl && linked.user.avatarUrl !== avatarUrl) {
      return prisma.user.update({
        where: { id: linked.user.id },
        data: { avatarUrl },
      });
    }
    return linked.user;
  }

  // 2. Existing user with same email — link only if the provider confirmed
  //    the email is verified. An unverified address creates a fresh account
  //    under a synthetic email so the legit account isn't silently joined.
  // email column is citext — see schema.prisma. The unique index serves
  // this lookup directly; no need for the ILIKE-translating insensitive mode.
  let user = email && emailVerified
    ? await prisma.user.findFirst({ where: { email: { equals: email } } })
    : null;

  // Create / update User and link OAuthAccount in one transaction so a
  // failure between the two writes can't leave a User with no auth path —
  // a stale row no one can sign back into. The unique constraint on
  // (provider, providerId) also makes concurrent OAuth callbacks for the
  // same external account collide; the transaction rolls back cleanly,
  // and the caller's retry hits the linked-account fast path above.
  const result = await prisma.$transaction(async (tx) => {
    let resolvedUser = user;
    if (!resolvedUser) {
      const username = await generateUniqueUsername(displayName);
      // Synthetic fallback email is used when we can't safely link by email
      // (no email at all, or email present but unverified). Keeps the User row's
      // unique email constraint satisfied without colliding with real addresses.
      const safeEmail = email && emailVerified ? email : `${providerId}@oauth.pickyum`;
      resolvedUser = await tx.user.create({
        data: { email: safeEmail, username, avatarUrl, emailVerified, emailVerifiedAt: emailVerified ? new Date() : null },
      });
    } else if (avatarUrl && !resolvedUser.avatarUrl) {
      resolvedUser = await tx.user.update({ where: { id: resolvedUser.id }, data: { avatarUrl } });
    }

    await tx.oAuthAccount.create({
      data: { userId: resolvedUser.id, provider, providerId },
    });

    return resolvedUser;
  });

  return result;
}

// ── Passport strategies ───────────────────────────────────────

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${process.env.API_URL || 'http://localhost:3000'}/api/auth/google/callback`,
      scope: ['profile', 'email'],
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const emailEntry = profile.emails?.[0];
        const email = emailEntry?.value;
        // Google sets `verified: true` (string or boolean depending on version)
        // on the primary email when the user has confirmed it. Coerce broadly —
        // anything truthy counts as verified, anything else does not.
        const verified = Boolean((emailEntry as { verified?: unknown } | undefined)?.verified);
        const user = await findOrCreateOAuthUser('google', profile.id, email, profile.displayName, undefined, verified);
        done(null, user);
      } catch (err) {
        done(err as Error);
      }
    },
  ));
}

if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
  passport.use(new FacebookStrategy(
    {
      clientID: process.env.FACEBOOK_APP_ID,
      clientSecret: process.env.FACEBOOK_APP_SECRET,
      callbackURL: `${process.env.API_URL || 'http://localhost:3000'}/api/auth/facebook/callback`,
      profileFields: ['id', 'displayName'],
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        // Facebook doesn't expose email without extra app review — use provider ID as fallback
        // (and so emailVerified stays false — there's no email to verify).
        const user = await findOrCreateOAuthUser('facebook', profile.id, undefined, profile.displayName, undefined, false);
        done(null, user);
      } catch (err) {
        done(err as Error);
      }
    },
  ));
}

// ── Helper: issue JWT cookie after OAuth ─────────────────────

function issueTokenAndRedirect(req: Request, res: Response) {
  const user = req.user as { id: number } | undefined;
  if (!user) {
    res.redirect(`${CLIENT_URL}/authentication?error=oauth_failed`);
    return;
  }
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: SESSION_DURATION });
  res.cookie('token', token, COOKIE_OPTIONS).redirect(CLIENT_URL);
}

// ── Email / password routes ───────────────────────────────────

// Input caps for register — keep in lockstep with users.ts MAX_USERNAME_LEN /
// MAX_EMAIL_LEN. Duplicated rather than imported because auth.ts loads before
// users.ts in some test setups and we want auth.ts standalone.
const MAX_USERNAME_LEN = 32;
const MAX_EMAIL_LEN    = 254;

// POST /api/auth/register
router.post('/register', authLimiter, async (req: Request, res: Response) => {
  const { email, username, password } = req.body as {
    email?: string;
    username?: string;
    password?: string;
  };

  if (!email || !username || !password) {
    res.status(400).json({ error: 'Email, username, and password are required' });
    return;
  }
  if (typeof email !== 'string' || email.length > MAX_EMAIL_LEN) {
    res.status(400).json({ error: `email must be ${MAX_EMAIL_LEN} characters or fewer` });
    return;
  }
  if (typeof username !== 'string' || username.length === 0 || username.length > MAX_USERNAME_LEN) {
    res.status(400).json({ error: `username must be 1-${MAX_USERNAME_LEN} characters` });
    return;
  }
  const pwError = validatePassword(password);
  if (pwError) {
    res.status(400).json({ error: pwError });
    return;
  }

  // email + username are citext and have unique B-tree indexes. We rely on
  // the DB for uniqueness (P2002 on `user.create`) rather than a pre-check,
  // because two concurrent registrations can both pass a findFirst probe
  // and only one would survive `create` — without a try/catch that violation
  // bubbles to a generic 500 instead of the field-specific 409 below.
  const passwordHash = await bcrypt.hash(password, 12);
  let user;
  try {
    user = await prisma.user.create({
      data: { email, username, passwordHash },
      select: { id: true, email: true, username: true, flipCount: true, avatarUrl: true, createdAt: true },
    });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
      // meta.target tells us which constraint fired — `User_email_key` vs
      // `User_username_key`. Without it we'd have to disclose generically.
      const target = (err as { meta?: { target?: string[] | string } }).meta?.target;
      const targetStr = Array.isArray(target) ? target.join(',') : (target ?? '');
      const field = targetStr.includes('email') ? 'email'
                  : targetStr.includes('username') ? 'username'
                  : 'value';
      res.status(409).json({ error: `That ${field} is already taken` }); return;
    }
    throw err;
  }

  // Fire verification email — send is fail-open and async-fire-and-forget;
  // a failed send doesn't block account creation. The user can request a
  // resend later via /api/auth/resend-verification.
  sendVerificationEmail(user.id, user.email).catch((err) =>
    logger.error({ err, userId: user.id }, 'failed to send verification email at registration'),
  );

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: SESSION_DURATION });
  res.cookie('token', token, COOKIE_OPTIONS).status(201).json({ user });
});

// ── Email verification ────────────────────────────────────────

async function sendVerificationEmail(userId: number, email: string): Promise<void> {
  const raw = await issueToken(userId, 'VERIFY_EMAIL');
  const url = `${CLIENT_URL}/verify-email?token=${encodeURIComponent(raw)}`;
  const tmpl = verifyEmailTemplate(url);
  await sendEmail({ to: email, ...tmpl });
}

// POST /api/auth/verify-email — consume token, flip emailVerified=true.
// Behind `authLimiter` for parity with /reset-password — defense in depth
// against any future regression that weakens token generation.
router.post('/verify-email', authLimiter, async (req: Request, res: Response) => {
  const { token } = req.body as { token?: string };
  if (typeof token !== 'string' || !token) {
    res.status(400).json({ error: 'Token is required' });
    return;
  }
  const userId = await consumeToken(token, 'VERIFY_EMAIL');
  if (!userId) {
    res.status(400).json({ error: 'Invalid or expired verification link' });
    return;
  }
  await prisma.user.update({
    where: { id: userId },
    data: { emailVerified: true, emailVerifiedAt: new Date() },
  });
  res.json({ message: 'Email verified' });
});

// POST /api/auth/resend-verification — for already-authenticated users only
router.post('/resend-verification', emailLimiter, requireAuth, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, email: true, emailVerified: true },
  });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  if (user.emailVerified) { res.json({ message: 'Email already verified' }); return; }
  await sendVerificationEmail(user.id, user.email);
  res.json({ message: 'Verification email sent' });
});

// ── Password reset ────────────────────────────────────────────

// POST /api/auth/forgot-password — always returns 200 to avoid leaking which
// emails exist. Sends a reset email only if the address matches a real account
// with a password (OAuth-only accounts get nothing).
//
// Lookup is case-insensitive because the registration uniqueness check is too —
// a case-sensitive lookup here would silently drop reset emails for any user
// whose stored email differs in case from what they typed.
router.post('/forgot-password', emailLimiter, async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string };
  if (typeof email !== 'string' || !email.trim()) {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  // email column is citext — case-insensitive equality via unique index.
  const user = await prisma.user.findFirst({
    where: { email: { equals: email } },
    select: { id: true, email: true, passwordHash: true },
  });

  // Generic response regardless of outcome — no enumeration.
  if (user && user.passwordHash) {
    try {
      const raw = await issueToken(user.id, 'PASSWORD_RESET');
      const url = `${CLIENT_URL}/reset-password?token=${encodeURIComponent(raw)}`;
      const tmpl = passwordResetTemplate(url);
      await sendEmail({ to: user.email, ...tmpl });
    } catch (err) {
      logger.error({ err, userId: user.id }, 'failed to send password reset email');
    }
  }
  res.json({ message: 'If that email is registered, a reset link is on its way.' });
});

// POST /api/auth/reset-password — consume token, set new password, optionally sign in
router.post('/reset-password', authLimiter, async (req: Request, res: Response) => {
  const { token, password } = req.body as { token?: string; password?: string };
  if (typeof token !== 'string' || !token) {
    res.status(400).json({ error: 'Token is required' });
    return;
  }
  const pwError = validatePassword(password);
  if (pwError) {
    res.status(400).json({ error: pwError });
    return;
  }

  const userId = await consumeToken(token, 'PASSWORD_RESET');
  if (!userId) {
    res.status(400).json({ error: 'Invalid or expired reset link' });
    return;
  }

  const passwordHash = await bcrypt.hash(password as string, 12);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

  // Issue a session cookie so the user is signed in after reset
  const sessionToken = jwt.sign({ userId }, process.env.JWT_SECRET!, { expiresIn: SESSION_DURATION });
  res.cookie('token', sessionToken, COOKIE_OPTIONS).json({ message: 'Password reset' });
});

// POST /api/auth/login
router.post('/login', authLimiter, async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  // Case-insensitive — the uniqueness check at registration is too. A user who
  // registered "Alice@x.com" can sign in as "alice@x.com" (or any case).
  // email column is citext (schema.prisma) — `equals` does case-insensitive
  // index-backed lookup. This is the hottest auth query in the app.
  const user = await prisma.user.findFirst({
    where: { email: { equals: email } },
  });
  // Always run bcrypt regardless of whether the user exists to prevent timing-based email enumeration
  const passwordMatch = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);

  // Single opaque error for every "failure to authenticate" path: missing
  // user, OAuth-only account, wrong password. Distinct messages here leak
  // exactly which: "email exists?" and "is it password-protected?" — the
  // same enumeration vector /forgot-password already avoids. The OAuth-only
  // hint that used to live here is moved to the UI side (after the user
  // tries social sign-in successfully).
  if (!user || !user.passwordHash || !passwordMatch) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: SESSION_DURATION });
  res.cookie('token', token, COOKIE_OPTIONS).json({
    user: { id: user.id, email: user.email, username: user.username, flipCount: user.flipCount, avatarUrl: user.avatarUrl },
  });
});

// POST /api/auth/logout
// clearCookie must match the options the cookie was set with — otherwise the
// browser ignores the clear and the session JWT lives on until expiry. The
// fields below mirror COOKIE_OPTIONS exactly (maxAge/expires are excluded per
// Express's contract — clear sends Expires=epoch automatically).
router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie('token', {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
  }).json({ message: 'Logged out' });
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, email: true, username: true, flipCount: true, avatarUrl: true, createdAt: true },
  });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ user });
});

// ── Supabase OAuth callback ───────────────────────────────────
// Called by the frontend after Supabase completes an OAuth flow.
// Validates the token by calling Supabase's own /auth/v1/user endpoint
// (avoids any JWT-secret encoding issues), then finds/creates the user
// in our Prisma DB and issues an app JWT cookie.

// Behind `authLimiter` because every other account-creation / sign-in path
// is — leaving this one open would let credential-stuffing of leaked
// Supabase tokens, or un-throttled account creation via synthetic
// `{providerId}@oauth.pickyum` emails, fly past every other rate limit.
router.post('/supabase', authLimiter, async (req: Request, res: Response) => {
  const { access_token } = req.body as { access_token?: string };
  if (!access_token) {
    res.status(400).json({ error: 'access_token is required' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(503).json({ error: 'Supabase not configured on server' });
    return;
  }

  // Let Supabase verify its own token — no JWT secret needed on our side
  const supabaseRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'apikey': supabaseAnonKey,
    },
  });

  if (!supabaseRes.ok) {
    res.status(401).json({ error: 'Invalid or expired Supabase token' });
    return;
  }

  const raw = await supabaseRes.json().catch(() => null) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') {
    res.status(502).json({ error: 'Malformed response from Supabase' });
    return;
  }

  // Treat the response as untrusted — validate every field we use rather than
  // splatting `as any` and trusting whatever showed up.
  const asString = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const supabaseId = asString(raw.id);
  if (!supabaseId) {
    res.status(502).json({ error: 'Supabase response missing user id' });
    return;
  }
  const email = asString(raw.email);
  // Supabase's /auth/v1/user sets `email_confirmed_at` to an ISO string when
  // the email is verified, or null/missing otherwise. Treat any non-empty
  // string as verified — the verification flow is owned by Supabase, not us.
  const emailVerified = typeof raw.email_confirmed_at === 'string' && raw.email_confirmed_at.length > 0;
  const appMeta = (raw.app_metadata && typeof raw.app_metadata === 'object') ? raw.app_metadata as Record<string, unknown> : {};
  const userMeta = (raw.user_metadata && typeof raw.user_metadata === 'object') ? raw.user_metadata as Record<string, unknown> : {};

  const provider    = asString(appMeta.provider) ?? 'oauth';
  const displayName = asString(userMeta.full_name) ?? email?.split('@')[0] ?? 'user';
  const avatarUrl   = asString(userMeta.avatar_url) ?? asString(userMeta.picture);

  try {
    const user = await findOrCreateOAuthUser(provider, supabaseId, email, displayName, avatarUrl, emailVerified);
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: SESSION_DURATION });
    res.cookie('token', token, COOKIE_OPTIONS).json({
      user: { id: user.id, email: user.email, username: user.username, flipCount: user.flipCount, avatarUrl: user.avatarUrl },
    });
  } catch (err) {
    console.error('[supabase auth] findOrCreateOAuthUser failed:', err);
    res.status(500).json({ error: 'Failed to create or retrieve user account' });
  }
});

// ── Google OAuth routes (Passport / direct — kept for fallback) ──

router.get('/google', passport.authenticate('google', { session: false, scope: ['profile', 'email'] }));

router.get(
  '/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: `${CLIENT_URL}/authentication?error=oauth_failed` }),
  issueTokenAndRedirect,
);

// ── Facebook OAuth routes ─────────────────────────────────────

router.get('/facebook', passport.authenticate('facebook', { session: false }));

router.get(
  '/facebook/callback',
  passport.authenticate('facebook', { session: false, failureRedirect: `${CLIENT_URL}/authentication?error=oauth_failed` }),
  issueTokenAndRedirect,
);

export default router;
