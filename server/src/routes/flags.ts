import { Router, Request, Response } from 'express';
import { flags } from '../lib/flags';

// Public endpoint that exposes the current feature-flag values to the
// frontend. The shape mirrors `FeatureFlags` from lib/flags.ts.
//
// Public on purpose — flag values aren't secrets. They control which
// code paths the UI takes; leaking "we're testing newDetailModal" to a
// curl request reveals nothing exploitable. Authentication would only
// matter if a flag itself was sensitive (e.g. "admin-feature visible
// to current user") — and those should live in /api/users/me, not here.
//
// 5 minute cache — flags are read once at server boot, so the response
// is constant until the next redeploy. The client's getFlags call can
// safely use a longer TTL than the standard 60s GET cache.

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ flags });
});

export default router;
