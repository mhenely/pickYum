// Shared voting-flow helpers used by /api/groups + /api/trips.
//
// Why this exists: until Phase 7, the accept-result endpoint was
// implemented twice — once in groups.ts (~150 lines) and once in
// trips.ts (~70 lines) — sharing ~70% of the body. Small validators
// for `votingStartsAt` and `voteMethod` were duplicated even more
// exactly. This module is the one place those concerns live.
//
// The split mirrors what's truly shared vs entity-specific:
//   - Shared (here):       lock-bound finalization, body validators,
//                          restaurant-pool snapshot, ballot snapshot,
//                          UserAccepted backfill for the recovery path
//   - Entity-specific      auth checks (host vs member),
//     (still in routes):   parent-FK guard (event.groupId vs event.tripId),
//                          archive guards (Group/Trip.archivedAt),
//                          response shapes / error messages
//
// The route handler still owns the pre-lock work (auth + cheap event
// read). Once we know the sessionId, we delegate the lock-bound work
// here. The function returns a discriminated union the caller maps
// to (status, body).

import { Prisma } from '@prisma/client';
import prisma from './prisma';
import {
  type GroupSession,
  getSession,
  withSessionLock,
} from '../sessions';

// ── Body validators ──────────────────────────────────────────────

/**
 * Parse the `votingStartsAt` body field for the schedule route.
 * - null/empty → clear the schedule
 * - valid future ISO string → Date
 * - anything else → { ok: false, error }
 */
export type ParseScheduleResult =
  | { ok: true; time: Date | null }
  | { ok: false; error: string };

export function parseVotingStartsAt(raw: unknown): ParseScheduleResult {
  if (raw == null || raw === '') return { ok: true, time: null };
  if (typeof raw !== 'string') return { ok: false, error: 'Invalid date format' };
  const parsed = Date.parse(raw);
  if (isNaN(parsed)) return { ok: false, error: 'Invalid date format' };
  const t = new Date(parsed);
  if (t <= new Date()) return { ok: false, error: 'Schedule must be set to a future time' };
  return { ok: true, time: t };
}

/**
 * Body validator for the vote-method route. Returns null on invalid
 * input so the caller can 400 with a route-specific message.
 */
export function parseVoteMethod(raw: unknown): 'SIMPLE' | 'RANKED' | null {
  return raw === 'SIMPLE' || raw === 'RANKED' ? raw : null;
}

// ── Lock-bound finalization ──────────────────────────────────────

/**
 * Discriminated result of `finalizeVoteUnderLock`. Caller maps each
 * kind to its (status, body) response shape:
 *   - 'concluded'         → 200 { message: 'Event concluded' }
 *   - 'already-concluded' → 200 { message: 'Event already concluded' }
 *   - 'invalid-state'     → 400 { error: message }
 */
export type FinalizeResult =
  | { kind: 'concluded' }
  | { kind: 'already-concluded' }
  | { kind: 'invalid-state'; message: string };

export interface FinalizeOptions {
  /**
   * When true (group context), creates UserAccepted rows for the host
   * and every signed-in voter pulled from session.voterMeta. When
   * false (trip context), the finalize is purely about persisting
   * GroupEventResult + flipping event status; trip flows don't yet
   * surface personal Insights, so the trip path skips these writes.
   */
  recordPersonalAcceptance: boolean;

  /**
   * The acting user (the host invoking accept-result). When
   * recordPersonalAcceptance is true, this user is the first
   * UserAccepted row we create; other voters are deduped against this id.
   */
  actingUserId: number;
}

/**
 * Run the finalization sequence under the session lock:
 *   1. Re-read the event (catches a concurrent accept-result that
 *      already flipped status to DONE).
 *   2. Get the Redis-backed session.
 *   3. Happy path: build the result payload + transactionally upsert
 *      GroupEventResult, flip event.status='DONE', and optionally
 *      write UserAccepted rows.
 *   4. Recovery path (session expired but result already persisted):
 *      back-fill any missing UserAccepted rows and re-stamp event status.
 *
 * Callers MUST have already validated auth + that the pre-event read
 * shows status='VOTING' with a non-null sessionId. This function
 * re-validates inside the lock because a concurrent caller may have
 * moved the event between the pre-read and the lock acquisition.
 */
export async function finalizeVoteUnderLock(
  eventId: number,
  sessionId: string,
  opts: FinalizeOptions,
): Promise<FinalizeResult> {
  return withSessionLock(sessionId, async (): Promise<FinalizeResult> => {
    // Re-read under the lock — a concurrent accept-result on this
    // session may have already finalized between the caller's pre-read
    // and lock acquisition.
    const event = await prisma.groupEvent.findUnique({ where: { id: eventId } });
    if (!event || event.status === 'DONE') {
      return { kind: 'already-concluded' };
    }
    if (event.status !== 'VOTING' || !event.sessionId) {
      return { kind: 'invalid-state', message: 'Event is not in voting state' };
    }

    const session = await getSession(event.sessionId);

    // Recovery path: session not done OR missing entirely. If a
    // GroupEventResult already exists from a prior crashed call,
    // back-fill UserAccepted (when applicable) and idempotently flip
    // event status.
    if (!session || session.status !== 'done') {
      const existing = await prisma.groupEventResult.findUnique({ where: { eventId } });
      if (!existing) {
        return { kind: 'invalid-state', message: 'Voting session is not complete or has expired' };
      }

      if (opts.recordPersonalAcceptance) {
        await backfillMissingUserAccepted(eventId, existing, opts.actingUserId);
      }
      await prisma.groupEvent.update({ where: { id: eventId }, data: { status: 'DONE', sessionId: null } });
      return { kind: 'concluded' };
    }

    // Happy path: session is done. Persist the result + flip event status
    // + (when applicable) credit UserAccepted rows in one transaction.
    const restaurantPool = await buildRestaurantPool(session);
    const ballotsSnapshot = pickBallotsSnapshot(session);
    const participants = [
      session.hostName,
      ...Object.keys(session.voters).filter((n) => n !== session.hostName),
    ];

    const winnerSnap = session.result ? session.restaurants[session.result] : null;
    const winnerName = winnerSnap?.name ?? session.result ?? '';
    const winnerId = session.result ? Number(session.result) : NaN;

    // Resolve participant → userId via session.voterMeta (the authoritative
    // identity sidecar) rather than by matching display name to group
    // member username. Voters whose display name differs from their auth
    // username used to be silently dropped from UserAccepted writes; this
    // approach credits them correctly. Guests (isGuest: true, userId: null)
    // are skipped because they don't have an account to credit.
    const memberUserIds: number[] = [];
    if (opts.recordPersonalAcceptance && !isNaN(winnerId)) {
      const seen = new Set<number>([opts.actingUserId]); // host dedupe
      for (const meta of Object.values(session.voterMeta ?? {})) {
        if (!meta || meta.isGuest || meta.userId == null) continue;
        if (seen.has(meta.userId)) continue;
        seen.add(meta.userId);
        memberUserIds.push(meta.userId);
      }
    }

    const transactionOps: Prisma.PrismaPromise<unknown>[] = [
      prisma.groupEventResult.upsert({
        where: { eventId },
        create: {
          eventId,
          hostUsername: session.hostName,
          winnerName,
          method: session.method ?? 'flip',
          // voteMethod is only meaningful when the winner came from a vote —
          // a pure flip/spin gets null here (the `method` field tells the story).
          voteMethod: session.method === 'vote' ? session.voteMethod : null,
          participants,
          scores: session.scores ?? undefined,
          // Prisma's InputJsonValue is an indexed signature; our session shapes
          // are typed records that don't structurally widen to it. The cast
          // is safe — every value here is JSON-serializable by construction.
          ballots: ballotsSnapshot as unknown as Prisma.InputJsonValue,
          voterMeta: session.voterMeta as unknown as Prisma.InputJsonValue,
          irvRounds: (session.irvRounds ?? undefined) as unknown as Prisma.InputJsonValue,
          restaurantPool: restaurantPool as unknown as Prisma.InputJsonValue,
        },
        update: {},
      }),
      prisma.groupEvent.update({
        where: { id: eventId },
        data: { status: 'DONE', sessionId: null },
      }),
    ];

    if (opts.recordPersonalAcceptance && !isNaN(winnerId)) {
      // One createMany INSERT for everyone — host + all signed-in voters
      // resolved from voterMeta. The @@unique([userId, eventId]) constraint
      // (migration 20260519000000) makes `skipDuplicates: true` work, which
      // also bakes in idempotency: a host who retries doesn't get P2002 and
      // never produces dup rows even if the lock check missed.
      transactionOps.push(
        prisma.userAccepted.createMany({
          data: [
            {
              userId: opts.actingUserId,
              restaurantId: winnerId,
              eventId,
              optionsSnapshot: session.candidates as Prisma.InputJsonValue,
              chooseMethod: session.method ?? null,
            },
            ...memberUserIds.map((userId) => ({
              userId,
              restaurantId: winnerId,
              eventId,
              optionsSnapshot: session.candidates as Prisma.InputJsonValue,
              chooseMethod: session.method ?? null,
            })),
          ],
          skipDuplicates: true,
        }),
      );
    }

    await prisma.$transaction(transactionOps);
    return { kind: 'concluded' };
  });
}

// ── Internals ────────────────────────────────────────────────────

interface RestaurantPoolEntry {
  id: string;
  name: string;
  type?: unknown;
  price?: unknown;
  address: string | null;
  website: string | null;
}

async function buildRestaurantPool(session: GroupSession): Promise<RestaurantPoolEntry[]> {
  // The session only carries in-memory display fields (name, type,
  // price). For the persisted snapshot we also pull address + website
  // from the DB so the ballot-detail modal can show contact info long
  // after the session has expired.
  const dbRestaurants = await prisma.restaurant.findMany({
    where: { id: { in: session.candidates.map(Number).filter(Boolean) } },
    select: { id: true, address: true, website: true },
  });
  const dbMap = Object.fromEntries(dbRestaurants.map((r) => [String(r.id), r]));
  return session.candidates.map((id) => ({
    id,
    name: session.restaurants[id]?.name ?? id,
    type: session.restaurants[id]?.type,
    price: session.restaurants[id]?.price,
    address: dbMap[id]?.address ?? null,
    website: dbMap[id]?.website ?? null,
  }));
}

function pickBallotsSnapshot(session: GroupSession): unknown {
  // Approval ballots for SIMPLE; ranked ballots for RANKED. Both
  // structures are kept on the session; we just route to the right one.
  return session.voteMethod === 'ranked' ? session.rankings : session.voters;
}

/**
 * Recovery-path back-fill: re-create any UserAccepted rows that
 * should have been written by a prior accept-result but weren't
 * (e.g. the original call crashed mid-transaction after writing
 * GroupEventResult). Idempotent via the @@unique([userId, eventId])
 * constraint + skipDuplicates.
 */
async function backfillMissingUserAccepted(
  eventId: number,
  existing: {
    restaurantPool: unknown;
    voterMeta: unknown;
    winnerName: string;
    method: string | null;
  },
  actingUserId: number,
): Promise<void> {
  const pool = (existing.restaurantPool as Array<{ id?: string; name?: string }>) ?? [];
  const winnerEntry = pool.find((p) => p?.name === existing.winnerName);
  const winnerId = winnerEntry?.id ? Number(winnerEntry.id) : NaN;
  if (isNaN(winnerId)) return;

  const meta = (existing.voterMeta as Record<string, { isGuest?: boolean; userId?: number | null } | null>) ?? {};
  const wantedUserIds = new Set<number>([actingUserId]);
  for (const v of Object.values(meta)) {
    if (!v || v.isGuest || v.userId == null) continue;
    wantedUserIds.add(v.userId);
  }

  const already = await prisma.userAccepted.findMany({
    where: { eventId, userId: { in: [...wantedUserIds] } },
    select: { userId: true },
  });
  const alreadySet = new Set(already.map((r) => r.userId));
  const missing = [...wantedUserIds].filter((id) => !alreadySet.has(id));
  if (missing.length === 0) return;

  const optionsSnapshot = pool.map((p) => p?.id).filter((x): x is string => typeof x === 'string');
  await prisma.userAccepted.createMany({
    data: missing.map((userId) => ({
      userId,
      restaurantId: winnerId,
      eventId,
      optionsSnapshot: optionsSnapshot as Prisma.InputJsonValue,
      chooseMethod: existing.method ?? null,
    })),
    skipDuplicates: true,
  });
}
