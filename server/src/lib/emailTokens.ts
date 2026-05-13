import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { EmailTokenPurpose } from '@prisma/client';
import prisma from './prisma';

// Tokens are 32 bytes of randomness rendered as base64url (43 chars).
// We store two derivatives of the raw token, never the raw itself:
//   - tokenHash:   bcrypt hash — defense in depth, verified post-lookup
//   - tokenLookup: sha256 hex  — deterministic index for O(1) consume
// A DB leak still gives an attacker nothing usable (both are one-way).
//
// Why both? The lookup column is what makes consume fast — without it we'd
// have to bcrypt-compare against every outstanding token, which is a CPU DoS
// vector. The bcrypt column stays as a belt-and-suspenders verify on the
// matched row, kept cheap by only being run once after the index hit.

const TOKEN_BYTES = 32;
const HASH_COST   = 10; // lower than password hashing — these are short-lived

export const TOKEN_TTL_MS: Record<EmailTokenPurpose, number> = {
  VERIFY_EMAIL:   24 * 60 * 60 * 1000, // 24 hours
  PASSWORD_RESET:  1 * 60 * 60 * 1000, // 1 hour
};

export function generateRawToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

async function hashToken(raw: string): Promise<string> {
  return bcrypt.hash(raw, HASH_COST);
}

// Deterministic — same raw input always produces the same hex string. Used as
// the lookup key in the DB. sha256 is collision-resistant enough that for 256
// bits of random input, a collision is astronomically unlikely.
function lookupKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Issues a fresh single-use token. Invalidates any prior unused tokens of the
 * same purpose for the user (so spamming "forgot password" gives only the
 * latest link any utility).
 */
export async function issueToken(userId: number, purpose: EmailTokenPurpose): Promise<string> {
  const raw = generateRawToken();
  const tokenHash   = await hashToken(raw);
  const tokenLookup = lookupKey(raw);
  const ttl = TOKEN_TTL_MS[purpose];

  await prisma.$transaction([
    prisma.emailToken.updateMany({
      where: { userId, purpose, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.emailToken.create({
      data: {
        userId,
        purpose,
        tokenHash,
        tokenLookup,
        expiresAt: new Date(Date.now() + ttl),
      },
    }),
  ]);

  return raw;
}

/**
 * Validates a token and consumes it (marks usedAt). Returns the user id on
 * success. Errors are intentionally generic to avoid leaking which step failed.
 *
 * Consume is now O(1): we sha256 the input and look up the indexed column.
 * The bcrypt compare runs only against the matched row — once at most, not
 * once per outstanding token. Legacy rows (tokenLookup IS NULL) can no longer
 * be consumed; they were issued before this column existed and expire within
 * 24h. Users with a stale verify/reset link must request a fresh one.
 */
export async function consumeToken(raw: string, purpose: EmailTokenPurpose): Promise<number | null> {
  if (typeof raw !== 'string' || raw.length < 20) return null;

  const tokenLookup = lookupKey(raw);
  const candidate = await prisma.emailToken.findUnique({
    where: { tokenLookup },
  });
  if (!candidate) return null;
  if (candidate.purpose !== purpose) return null;
  if (candidate.usedAt) return null;
  if (candidate.expiresAt <= new Date()) return null;

  // Belt and suspenders: bcrypt-verify the matched row. If the lookup hash
  // collided (impossible in practice) or the row was tampered with, this fails.
  if (!await bcrypt.compare(raw, candidate.tokenHash)) return null;

  // Consume atomically — second use returns 0 rows updated and we reject.
  const result = await prisma.emailToken.updateMany({
    where: { id: candidate.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (result.count === 0) return null;
  return candidate.userId;
}

/**
 * Background sweep — drops tokens that expired more than a day ago.
 * Cheap to call on a cron; safe to call every request.
 */
export async function purgeExpiredTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await prisma.emailToken.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return result.count;
}
