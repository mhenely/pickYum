import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';

// Gate /api/admin/* routes to users whose `role` column is 'admin'.
// `requireAuth` MUST run before this middleware — we need a verified
// `req.userId` to look up. Returns 403 for authenticated-but-not-admin
// callers, 401 for missing auth (defers to requireAuth's check).
//
// Implementation note: every request does a small SELECT for the role.
// At admin-route scale (low-volume; ops surface) this is negligible.
// If admin endpoints ever become high-traffic, swap to a JWT-claim
// approach (sign the role into the token at login, re-issue tokens
// on role change). For now, DB lookup is simpler and lets a role
// change take effect on the next request without forcing re-login.
//
// String comparison rather than enum so adding new roles later
// (e.g. 'support', 'readOnly') doesn't require changing this gate —
// only the lookup needs to know that 'admin' grants access.
export const requireAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { role: true },
  });
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  next();
};
