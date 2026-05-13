import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { EmailTokenPurpose } from '@prisma/client';
import prisma from './prisma';

// Tokens are 32 bytes of randomness rendered as base64url (43 chars).
// We store the bcrypt hash, never the raw token, so a DB leak doesn't grant
// access. Lookup is by hash so the index works in O(log n).

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

/**
 * Issues a fresh single-use token. Invalidates any prior unused tokens of the
 * same purpose for the user (so spamming "forgot password" gives only the
 * latest link any utility).
 */
export async function issueToken(userId: number, purpose: EmailTokenPurpose): Promise<string> {
  const raw = generateRawToken();
  const tokenHash = await hashToken(raw);
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
        expiresAt: new Date(Date.now() + ttl),
      },
    }),
  ]);

  return raw;
}

/**
 * Validates a token and consumes it (marks usedAt). Returns the user id on
 * success. Errors are intentionally generic to avoid leaking which step failed.
 */
export async function consumeToken(raw: string, purpose: EmailTokenPurpose): Promise<number | null> {
  if (typeof raw !== 'string' || raw.length < 20) return null;

  // Find unused, non-expired tokens for this purpose. The index is on
  // (userId, purpose) — for a token-first lookup we have to scan candidates.
  // In practice we narrow to ~handful by expiresAt, then bcrypt-compare.
  const candidates = await prisma.emailToken.findMany({
    where: {
      purpose,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
    take: 50, // cap — anything older is unlikely to be the one
  });

  for (const candidate of candidates) {
    if (await bcrypt.compare(raw, candidate.tokenHash)) {
      // Consume atomically — second use returns 0 rows updated and we reject.
      const result = await prisma.emailToken.updateMany({
        where: { id: candidate.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (result.count === 0) return null;
      return candidate.userId;
    }
  }
  return null;
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
