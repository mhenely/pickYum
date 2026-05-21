// Top-level /api/users router. Splits across domain files so 2,700
// lines of formerly-monolithic users.ts logic now lives close to its
// concerns. Auth + writeLimiter are applied here once; every sub-
// router inherits both via the Express middleware stack.
//
// Sub-router paths are still full /me/* (not relative), so app.ts's
// existing `app.use('/api/users', router)` mount keeps the public
// URLs unchanged. The shape is purely organizational.

import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { writeLimiter } from '../../middleware/rateLimits';

import profileRouter from './profile';
import bootstrapRouter from './bootstrap';
import addressesRouter from './addresses';
import favoritesRouter from './favorites';
import collectionsRouter from './collections';
import insightsRouter from './insights';
import refreshRouter from './refresh';
import usageRouter from './usage';

const router = Router();
router.use(requireAuth);
router.use(writeLimiter);

router.use(profileRouter);
router.use(bootstrapRouter);
router.use(addressesRouter);
router.use(favoritesRouter);
router.use(collectionsRouter);
router.use(insightsRouter);
router.use(refreshRouter);
router.use(usageRouter);

// Re-export the test/scaffolding hooks so callers that historically
// imported them from `routes/users` continue to work.
export { _resetRefreshLocksForTests } from './refresh';
export { INSIGHTS_ALL_TIME_CAP_DAYS } from './insights';

export default router;
