import { DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

jest.mock('../../lib/prisma');
// bcryptjs is the only crypto primitive worth mocking here — we want to
// verify the *flow* (hash on issue, compare on consume, atomic update)
// without paying the real bcrypt cost on every test. The crypto module
// for randomBytes/sha256 is left real because it's fast and deterministic
// behavior is what we want to validate (same input → same lookup key).
jest.mock('bcryptjs', () => ({
  hash:    jest.fn().mockResolvedValue('$2a$10$mocked-hash'),
  compare: jest.fn().mockResolvedValue(true),
}));

import prisma from '../../lib/prisma';
import bcrypt from 'bcryptjs';
import { issueToken, consumeToken, generateRawToken, purgeExpiredTokens } from '../../lib/emailTokens';

const mockPrisma = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

beforeEach(() => {
  jest.clearAllMocks();
  // $transaction in issueToken is `prisma.$transaction([op1, op2])` — the
  // array form. The mock needs to accept the array and resolve to the
  // results of running each op (we don't read the result here).
  (mockPrisma.$transaction as jest.Mock).mockImplementation(async (ops) => {
    if (!Array.isArray(ops)) return ops;
    return Promise.all(ops);
  });
});

describe('generateRawToken', () => {
  it('produces a base64url string of stable length per call', () => {
    const a = generateRawToken();
    const b = generateRawToken();
    // 32 bytes → 43 chars of base64url (no padding).
    expect(a).toHaveLength(43);
    expect(b).toHaveLength(43);
    // Distinct across calls — the crypto.randomBytes source is real.
    expect(a).not.toBe(b);
    // base64url: A-Z, a-z, 0-9, -, _.
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('issueToken', () => {
  it('invalidates prior unused tokens for the same user+purpose before creating a new one', async () => {
    (mockPrisma.emailToken.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
    (mockPrisma.emailToken.create     as jest.Mock).mockResolvedValue({ id: 99 });

    const raw = await issueToken(7, 'PASSWORD_RESET');

    expect(raw).toHaveLength(43);
    // Both ops fired inside the same transaction — we can't observe the
    // transaction wrapper directly but we can confirm both calls happened.
    expect(mockPrisma.emailToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 7, purpose: 'PASSWORD_RESET', usedAt: null },
      data:  expect.objectContaining({ usedAt: expect.any(Date) }),
    });
    expect(mockPrisma.emailToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 7,
        purpose: 'PASSWORD_RESET',
        tokenHash:   '$2a$10$mocked-hash',
        tokenLookup: expect.stringMatching(/^[a-f0-9]{64}$/), // sha256 hex
        expiresAt:   expect.any(Date),
      }),
    });
  });

  it('stores the bcrypt hash of the raw token, never the raw token itself', async () => {
    (mockPrisma.emailToken.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.emailToken.create     as jest.Mock).mockResolvedValue({ id: 1 });

    const raw = await issueToken(1, 'VERIFY_EMAIL');

    // bcrypt.hash was called with the raw token — proves it's the input
    // that gets hashed (not some derived value the caller could regenerate
    // without the original).
    expect(mockBcrypt.hash).toHaveBeenCalledWith(raw, 10);
    // The stored row's tokenHash is the *output* of bcrypt.hash, NOT the
    // raw token. A DB leak gives the attacker the hash, not the secret.
    const createArg = (mockPrisma.emailToken.create as jest.Mock).mock.calls[0][0];
    expect(createArg.data.tokenHash).not.toContain(raw);
    expect(createArg.data.tokenHash).toBe('$2a$10$mocked-hash');
  });

  it('sets the expiry per purpose (PASSWORD_RESET = 1h, VERIFY_EMAIL = 24h)', async () => {
    (mockPrisma.emailToken.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (mockPrisma.emailToken.create     as jest.Mock).mockResolvedValue({ id: 1 });

    const before = Date.now();
    await issueToken(1, 'PASSWORD_RESET');
    const resetArg = (mockPrisma.emailToken.create as jest.Mock).mock.calls[0][0];
    const resetExpiry = (resetArg.data.expiresAt as Date).getTime();

    await issueToken(1, 'VERIFY_EMAIL');
    const verifyArg = (mockPrisma.emailToken.create as jest.Mock).mock.calls[1][0];
    const verifyExpiry = (verifyArg.data.expiresAt as Date).getTime();

    const oneHourMs   = 60 * 60 * 1000;
    const oneDayMs    = 24 * oneHourMs;
    // Allow generous slack since the timestamps are captured at runtime
    // rather than via fake timers.
    expect(resetExpiry  - before).toBeGreaterThanOrEqual(oneHourMs - 1000);
    expect(resetExpiry  - before).toBeLessThanOrEqual(oneHourMs + 2000);
    expect(verifyExpiry - before).toBeGreaterThanOrEqual(oneDayMs - 1000);
    expect(verifyExpiry - before).toBeLessThanOrEqual(oneDayMs + 2000);
  });
});

describe('consumeToken', () => {
  const futureExpiry = () => new Date(Date.now() + 60_000);

  it('returns the userId and marks the row consumed on a valid token', async () => {
    (mockPrisma.emailToken.findUnique as jest.Mock).mockResolvedValue({
      id: 9, userId: 7, purpose: 'PASSWORD_RESET',
      tokenHash: '$2a$10$mocked-hash', tokenLookup: 'irrelevant',
      usedAt: null, expiresAt: futureExpiry(),
    });
    (mockPrisma.emailToken.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    const userId = await consumeToken('a'.repeat(43), 'PASSWORD_RESET');

    expect(userId).toBe(7);
    // The atomic consume gate: WHERE id = ? AND usedAt IS NULL.
    expect(mockPrisma.emailToken.updateMany).toHaveBeenCalledWith({
      where: { id: 9, usedAt: null },
      data:  expect.objectContaining({ usedAt: expect.any(Date) }),
    });
  });

  it('returns null for tokens shorter than 20 chars without hitting the DB', async () => {
    const userId = await consumeToken('short', 'PASSWORD_RESET');
    expect(userId).toBeNull();
    // Hot-path guard against malformed input — we don't even spend a DB
    // round-trip. Verifies findUnique was NOT called.
    expect(mockPrisma.emailToken.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when no row matches the lookup hash', async () => {
    (mockPrisma.emailToken.findUnique as jest.Mock).mockResolvedValue(null);
    const userId = await consumeToken('a'.repeat(43), 'PASSWORD_RESET');
    expect(userId).toBeNull();
    expect(mockPrisma.emailToken.updateMany).not.toHaveBeenCalled();
  });

  it('returns null when the purpose does not match', async () => {
    (mockPrisma.emailToken.findUnique as jest.Mock).mockResolvedValue({
      id: 9, userId: 7, purpose: 'VERIFY_EMAIL', // ← wrong purpose
      tokenHash: '$2a$10$mocked-hash', tokenLookup: 'x',
      usedAt: null, expiresAt: futureExpiry(),
    });

    const userId = await consumeToken('a'.repeat(43), 'PASSWORD_RESET');
    expect(userId).toBeNull();
    // Defense in depth: a reset token can't be used as a verify token
    // (or vice versa) even if their lookup keys somehow collided.
    expect(mockPrisma.emailToken.updateMany).not.toHaveBeenCalled();
  });

  it('returns null for a previously-consumed token', async () => {
    (mockPrisma.emailToken.findUnique as jest.Mock).mockResolvedValue({
      id: 9, userId: 7, purpose: 'PASSWORD_RESET',
      tokenHash: '$2a$10$mocked-hash', tokenLookup: 'x',
      usedAt: new Date(), // ← already consumed
      expiresAt: futureExpiry(),
    });

    const userId = await consumeToken('a'.repeat(43), 'PASSWORD_RESET');
    expect(userId).toBeNull();
    expect(mockPrisma.emailToken.updateMany).not.toHaveBeenCalled();
  });

  it('returns null for an expired token', async () => {
    (mockPrisma.emailToken.findUnique as jest.Mock).mockResolvedValue({
      id: 9, userId: 7, purpose: 'PASSWORD_RESET',
      tokenHash: '$2a$10$mocked-hash', tokenLookup: 'x',
      usedAt: null,
      expiresAt: new Date(Date.now() - 1000), // ← in the past
    });

    const userId = await consumeToken('a'.repeat(43), 'PASSWORD_RESET');
    expect(userId).toBeNull();
    expect(mockPrisma.emailToken.updateMany).not.toHaveBeenCalled();
  });

  it('returns null when bcrypt.compare rejects the matched row (tamper guard)', async () => {
    (mockPrisma.emailToken.findUnique as jest.Mock).mockResolvedValue({
      id: 9, userId: 7, purpose: 'PASSWORD_RESET',
      tokenHash: '$2a$10$mocked-hash', tokenLookup: 'x',
      usedAt: null, expiresAt: futureExpiry(),
    });
    // The sha256 lookup matched, but bcrypt rejects — should never happen
    // in practice (sha256 collision is astronomical) but the belt-and-
    // suspenders verify catches a tampered tokenHash column.
    mockBcrypt.compare.mockResolvedValueOnce(false as never);

    const userId = await consumeToken('a'.repeat(43), 'PASSWORD_RESET');
    expect(userId).toBeNull();
    expect(mockPrisma.emailToken.updateMany).not.toHaveBeenCalled();
  });

  it('returns null when the atomic consume loses a race (updateMany count=0)', async () => {
    (mockPrisma.emailToken.findUnique as jest.Mock).mockResolvedValue({
      id: 9, userId: 7, purpose: 'PASSWORD_RESET',
      tokenHash: '$2a$10$mocked-hash', tokenLookup: 'x',
      usedAt: null, expiresAt: futureExpiry(),
    });
    // Another caller consumed it between findUnique and updateMany. The
    // `WHERE usedAt IS NULL` gate matches zero rows on this caller's
    // attempt — we report a clean failure rather than handing the same
    // userId to two simultaneous reset attempts.
    (mockPrisma.emailToken.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    const userId = await consumeToken('a'.repeat(43), 'PASSWORD_RESET');
    expect(userId).toBeNull();
  });
});

describe('purgeExpiredTokens', () => {
  it('deletes rows that expired more than 24h ago and reports the count', async () => {
    (mockPrisma.emailToken.deleteMany as jest.Mock).mockResolvedValue({ count: 12 });

    const count = await purgeExpiredTokens();

    expect(count).toBe(12);
    // The cutoff is computed against `now` — we just confirm the shape and
    // that the cutoff is a Date (not undefined / NaN).
    const call = (mockPrisma.emailToken.deleteMany as jest.Mock).mock.calls[0][0];
    expect(call.where.expiresAt.lt).toBeInstanceOf(Date);
  });
});
