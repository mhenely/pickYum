import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

interface JwtPayload {
  userId: number;
}

// Extend Express Request so downstream handlers get req.userId typed
declare global {
  namespace Express {
    interface Request {
      userId: number;
    }
  }
}

// Read JWT_SECRET once at module load instead of `process.env.JWT_SECRET` per
// call. Env var access in Node hits a JS object lookup every time; the
// startup validator in index.ts already aborts if the var is missing, so by
// the time this module runs we can trust the value. Saves a small but
// per-request constant on every authenticated route (which is most of them).
const JWT_SECRET = process.env.JWT_SECRET ?? '';

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const token = req.cookies?.token as string | undefined;
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Returns the auth user's id if a valid `token` cookie is present, else null.
// Used by routes that accept both signed-in and anonymous callers and need to
// adjust their response based on who's asking (e.g. private-restaurant
// visibility, voter identity on session join). Never throws — bad/missing
// tokens just yield null.
export function getOptionalAuthUserId(req: Request): number | null {
  const token = req.cookies?.token as string | undefined;
  if (!token || !JWT_SECRET) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId?: number };
    return typeof payload.userId === 'number' ? payload.userId : null;
  } catch {
    return null;
  }
}
