// Standardized wrapper for fire-and-forget background promises.
//
// Why this exists: a recurring pattern across route files is "kick off
// background work without awaiting it, but log if it fails." Without a
// shared helper, every call site reinvents it slightly differently —
// some use `console.warn`, some use `logger.warn`, some forget the
// .catch entirely and risk unhandledRejection.
//
// On Node 15+, unhandledRejection defaults to crashing the process —
// so a missing .catch on a background task can take the server down.
// Using `logTaskFailure(promise, name)` makes that impossible.
//
// Usage:
//   logTaskFailure(
//     recomputeCommunityRating(restaurantId),
//     'recomputeCommunityRating',
//     { restaurantId },
//   );
//
// Don't use this for promises whose result you actually need — only for
// genuinely fire-and-forget side effects (notification sends, cache
// warming, denormalization, etc.). If the result matters, await it and
// let it surface to the user.

import { logger } from './logger';

export function logTaskFailure(
  promise: Promise<unknown>,
  taskName: string,
  context?: Record<string, unknown>,
): void {
  promise.catch((err: unknown) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err: errMsg, taskName, ...(context ?? {}) },
      `[bg-task] ${taskName} failed`,
    );
  });
}
