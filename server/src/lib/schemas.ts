// Zod schemas for inputs we validate on the server.
//
// Why this exists: route files previously inlined string-length checks,
// regex tests, and Array.isArray gates per handler. The result was a
// pattern that drifted (e.g. one route allowed 80-char names, another
// 100) and made global rules — like "max email length is RFC 5321's
// 254" — invisible across files. This module is the single source of
// truth for those rules.
//
// Two consumption patterns:
//   1. `.parse(input)` — throws on invalid. Use inside try/catch at
//      route entry, return 400 with the Zod error message.
//   2. `.safeParse(input)` — returns `{ success, data | error }`.
//      Preferred when you want to fall through to a different code
//      path on invalid input (e.g. silently drop an unknown cuisine
//      slug rather than 400 the user).
//
// Don't `.parse` user input without a try/catch — Zod throws a ZodError
// that, if uncaught, becomes a 500.

import { z } from 'zod';
import { MIN_PASSWORD_LEN } from '../config/auth';

// ── ID schemas ─────────────────────────────────────────────────
// `z.coerce.number()` accepts string OR number input (URL params are
// strings; JSON bodies may be numbers). Both go through `Number(x)`.
// `.int().positive()` matches the historical parseId contract.
export const IdSchema = z.coerce.number().int().positive();
export const RestaurantIdSchema = IdSchema;
export const UserIdSchema = IdSchema;
export const GroupIdSchema = IdSchema;
export const TripIdSchema = IdSchema;
export const EventIdSchema = IdSchema;
export const ListIdSchema = IdSchema;

// ── Email ──────────────────────────────────────────────────────
// 254-char cap mirrors RFC 5321 §4.5.3.1.1 (the practical maximum
// for an SMTP path) and the existing inline check in users.ts.
// `.toLowerCase().trim()` matches the normalization the registration
// flow does before storage — using the schema everywhere keeps email
// matching consistent (login can find a user even if they typed
// uppercase). `.email()` is intentionally lax because real-world
// addresses are messier than RFC 5322.
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);

// ── Password ───────────────────────────────────────────────────
// Matches the validatePassword() rules in routes/auth.ts:
//   - ≥ MIN_PASSWORD_LEN (8) characters
//   - at least one letter
//   - at least one digit
// No max length here — bcrypt internally caps at 72 bytes; passwords
// longer than that just get silently truncated by the hash, which is
// fine. We don't enforce special characters because the empirical
// security literature is at best mixed on whether the marginal
// strength is worth the friction.
export const PasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LEN, `password must be at least ${MIN_PASSWORD_LEN} characters`)
  .regex(/[A-Za-z]/, 'password must contain at least one letter')
  .regex(/\d/, 'password must contain at least one number');

// ── Display names (group names, trip names, event names) ──────
// 80-char cap chosen to match the existing MAX_EVENT_NAME_LEN in
// trips.ts. Trim before measuring so '   foo   ' (with whitespace
// noise) is stored cleanly. Empty after trim is invalid.
export const NameSchema = z
  .string()
  .trim()
  .min(1, 'name is required')
  .max(80, 'name must be 80 characters or fewer');

// ── Usernames ─────────────────────────────────────────────────
// 32-char cap matches the existing MAX_USERNAME_LEN in users.ts.
// Characters are constrained to alphanumeric + underscore + hyphen
// since usernames are URL-safe (we have profile URLs). Empty after
// trim is invalid; the registration flow guarantees a default if
// the user doesn't pick one.
export const UsernameSchema = z
  .string()
  .trim()
  .min(1, 'username is required')
  .max(32, 'username must be 32 characters or fewer')
  .regex(/^[A-Za-z0-9_-]+$/, 'username may only contain letters, numbers, underscore, or hyphen');

// ── Review content ────────────────────────────────────────────
// 4000-char cap matches MAX_REVIEW_CONTENT in users.ts. Reviews
// can be empty (rating-only submission) — this schema is for the
// content field specifically, not the whole payload.
export const ReviewContentSchema = z.string().max(4000);

// ── Rating ────────────────────────────────────────────────────
// 0-5 in 0.5 increments per the existing rating UI. Stored as a
// number in Prisma; Zod ensures the input is in-range. `.step(0.5)`
// rejects 4.3 etc.; the UI never sends those but a tampered client
// could.
export const RatingSchema = z
  .number()
  .min(0, 'rating must be between 0 and 5')
  .max(5, 'rating must be between 0 and 5')
  .multipleOf(0.5, 'rating must be in 0.5 increments');
