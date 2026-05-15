// Tunable constants for authentication + account-security policy.
//
// These were inlined in auth.ts until TIER_2_3_PLAN.md #14. Same
// reasoning as config/insights.ts: gather the "why this number?"
// explanations in one place + make per-env overrides easy when needed.

/** JWT lifetime (jsonwebtoken-compatible duration string). Cookie's
 *  maxAge mirrors this. 7 days balances UX (no constant re-auth) with
 *  blast radius if a token leaks. */
export const SESSION_DURATION = '7d';
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum password length. Generous on the upper bound — frustrating
 *  real users with 64-char caps backfires; bcrypt's own 72-byte
 *  truncation is the practical ceiling. */
export const MIN_PASSWORD_LEN = 8;

/** Per-account failed-login lockout. Defends against credential-stuffing
 *  botnets that distribute attempts across many IPs (sidestepping the
 *  IP-based authLimiter). After this many consecutive failures, the
 *  account locks for LOCKOUT_DURATION_MS regardless of correct password
 *  or source IP. Cleared by a successful login OR a password reset. */
export const FAILED_LOGIN_LIMIT = 8;
export const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 minutes

/** Pre-computed bcrypt hash used as a timing dummy when no real hash
 *  exists. Ensures bcrypt.compare always runs regardless of whether
 *  the account exists or is currently locked — prevents timing-based
 *  email enumeration. */
export const BCRYPT_TIMING_DUMMY = '$2a$12$KIXxwf7pVdaFGaFVMxJAOuLgc0X1Xk6pJz9mV3RwUqHnYeD5tsBqS';

/** Identity caps used by registration + profile-update validators.
 *  Email cap is RFC 5321's maximum; username cap is product-imposed
 *  (longer usernames render poorly in the nav + group rosters). */
export const MAX_USERNAME_LEN = 32;
export const MAX_EMAIL_LEN    = 254;

/** Auth-route rate limiter values. Two limiters:
 *   - `auth`  applied to /login + /register + /reset-password + OAuth
 *   - `email` applied to /forgot-password + /resend-verification
 *  The email path is stricter because each call can trigger a real
 *  transactional email send. */
export const AUTH_LIMITER_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_LIMITER_MAX       = 20;
export const EMAIL_LIMITER_WINDOW_MS = 60 * 60 * 1000;
export const EMAIL_LIMITER_MAX       = 5;
