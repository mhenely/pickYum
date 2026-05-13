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

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const token = req.cookies?.token as string | undefined;
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};
