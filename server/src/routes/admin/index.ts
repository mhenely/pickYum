// Admin router. Mounts at /api/admin and gates every sub-route with
// requireAuth + requireAdmin so unauthenticated callers get 401 and
// non-admin authenticated callers get 403 (semantics match what other
// auth-required routes use).
//
// Sub-routers live under ./usage etc. — new admin tools (user search,
// audit log viewer, manual cache invalidation, etc.) get their own
// file and a `router.use(...)` line here.

import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/admin';
import usageRouter from './usage';

const router = Router();

// Order matters: requireAuth must run before requireAdmin, which reads
// req.userId. The admin middleware's 401 branch is defensive but the
// real check is "auth verified the cookie + populated req.userId, now
// is this user an admin?"
router.use(requireAuth);
router.use(requireAdmin);

router.use('/usage', usageRouter);

export default router;
