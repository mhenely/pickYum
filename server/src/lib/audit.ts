import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import prisma from './prisma';
import { logger } from './logger';

// Append-only audit log helper. Writes a single AuditLog row, fail-open:
// audit-log writes must NEVER block the user-facing flow. If the DB
// insert fails (network blip, table missing in a misconfigured env),
// we log to Pino and swallow — the alternative would be denying the
// user's login because we couldn't log the success, which is worse.
//
// Callers are intentionally NOT awaited from hot paths; pass the result
// to `.catch(...)` and move on. That said, in tests the await is fine —
// the mocked prisma returns immediately.
//
// Known `kind` values are documented inline in schema.prisma. New kinds
// don't need a migration — just write the row and document it there.

export type AuditKind =
  | 'login.success'
  | 'login.failure'
  | 'login.locked'
  | 'login.locked-attempt'
  | 'password.reset'
  | 'password.changed'
  | 'email.verified'
  | 'admin.action';

export interface AuditEntry {
  kind: AuditKind | (string & {}); // allow ad-hoc kinds without breaking type-narrowing
  actorUserId?: number | null;
  targetUserId?: number | null;
  req?: Request;                   // for IP capture; optional for system events
  metadata?: Record<string, unknown>;
}

// Extracts a best-effort IP from the request. Express's `req.ip` already
// respects `app.set('trust proxy', ...)` so behind App Runner / CloudFront
// it sees the real client IP. Falls back to socket.remoteAddress when
// req.ip is undefined (shouldn't happen in our setup, but cheap defense).
function extractIp(req?: Request): string | null {
  if (!req) return null;
  if (typeof req.ip === 'string' && req.ip.length > 0) return req.ip.slice(0, 45);
  const remote = req.socket?.remoteAddress;
  return remote ? remote.slice(0, 45) : null;
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        kind: entry.kind,
        actorUserId:  entry.actorUserId  ?? null,
        targetUserId: entry.targetUserId ?? null,
        ip:           extractIp(entry.req),
        // Prisma's JSON input requires the InputJsonValue cast for an
        // unstructured object.
        metadata: (entry.metadata ?? null) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    logger.error({ err, auditEntry: entry }, 'audit log write failed');
  }
}
