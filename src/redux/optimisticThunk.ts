import { createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import { syncWithFeedback, type SyncOptions } from './syncHelper';

// Generalized optimistic-mutation helper. Each mutation that:
//   1. updates Redux first for instant UI feedback,
//   2. fires a server call,
//   3. reconciles state with the server's response on success,
//   4. rolls back on failure,
// used to be written inline with its own try/catch/dispatch pattern.
// This abstraction lifts the pattern into one place so corrections in
// one mutation propagate to every other.
//
// Compare to the previous shape (see e.g. toggleAcceptedExcludeFromInsights
// in userInfoSlice — currently the most representative example):
//
//   export const fooThunk = createAsyncThunk('foo', async (arg, { dispatch }) => {
//     dispatch(optimisticAction(arg));
//     try {
//       const result = await api.foo(arg);
//       dispatch(reconcileAction(result));
//       return result;
//     } catch (err) {
//       dispatch(rollbackAction(arg));
//       throw err;
//     }
//   });
//
// becomes:
//
//   export const fooThunk = optimisticThunk({
//     name: 'foo',
//     optimistic: (arg) => optimisticAction(arg),
//     call: (arg) => api.foo(arg),
//     reconcile: (result, arg) => reconcileAction(result),
//     rollback: (arg) => rollbackAction(arg),
//     feedback: { label: 'Saving foo' },
//   });
//
// Benefits:
//   - Reuses syncWithFeedback for retry + Sentry capture + toast surface.
//     Every optimistic mutation gets the same failure UX for free.
//   - Rollback action is symmetric with the optimistic action and lives
//     next to it in the slice — no inline `if (err) { dispatch(...) }`
//     scattered through the thunk.
//   - The thunk's typed Arg/Result flow through to TypeScript callers.
//
// Not the right helper for:
//   - Mutations where the user is awaiting a UI result that depends on
//     the server response (createReview's `id`). Those want a regular
//     createAsyncThunk that throws on failure so the component can
//     render an error state inline.
//   - Synchronous-only state changes (no server call). Use a reducer.

export interface OptimisticThunkConfig<Arg, ServerResult> {
  // Unique action type prefix — `${name}/pending`, `${name}/fulfilled`,
  // `${name}/rejected` will be the dispatched action types.
  name: string;

  // Dispatched immediately on call — applies the optimistic local
  // change. Return whatever action creator the slice exports for the
  // visible state change.
  optimistic: (arg: Arg) => PayloadAction<unknown> | { type: string; payload?: unknown };

  // The actual server call. Errors should throw.
  call: (arg: Arg) => Promise<ServerResult>;

  // Fired with the server's result on success. Use to backfill server-
  // assigned ids onto optimistic rows, swap local-* ids for real ones,
  // or reconcile any field the optimistic version couldn't know.
  // Return null to skip the reconcile dispatch.
  reconcile?: (result: ServerResult, arg: Arg) => PayloadAction<unknown> | { type: string; payload?: unknown } | null;

  // Fired on final failure (after retries). Use to undo the optimistic
  // state change. Return null to skip — some mutations are best left
  // applied locally (the user explicitly chose this state; the server
  // will reconcile on next refresh).
  rollback?: (arg: Arg) => PayloadAction<unknown> | { type: string; payload?: unknown } | null;

  // Toast / retry config passed through to syncWithFeedback.
  feedback: Omit<SyncOptions<ServerResult>, 'call' | 'onSuccess' | 'rollback'>;
}

/**
 * Build a typed createAsyncThunk that wraps the optimistic-then-server
 * pattern. The returned thunk can be dispatched like any other:
 *
 *     dispatch(myThunk(arg))
 *
 * The thunk:
 *   - Always dispatches `optimistic(arg)` first (synchronously).
 *   - Calls `call(arg)` via syncWithFeedback (retry + telemetry + toast).
 *   - On success: dispatches `reconcile?.(result, arg)` if non-null, then
 *     resolves with the server result.
 *   - On final failure: dispatches `rollback?.(arg)` if non-null, then
 *     rejects with the error. syncWithFeedback already surfaced an error
 *     toast; callers don't need to handle the rejection unless they
 *     have additional UI to update.
 */
export function optimisticThunk<Arg, ServerResult>(
  config: OptimisticThunkConfig<Arg, ServerResult>,
) {
  return createAsyncThunk<ServerResult, Arg>(
    config.name,
    async (arg, { dispatch, rejectWithValue }) => {
      const opt = config.optimistic(arg);
      // The cast keeps the thunk's dispatch type comfortable with both
      // PayloadAction and ad-hoc { type, payload } shapes.
      dispatch(opt as PayloadAction<unknown>);

      const result = await syncWithFeedback({ dispatch }, {
        ...config.feedback,
        call: () => config.call(arg),
      });

      if (result === undefined) {
        // syncWithFeedback returns undefined on final failure. Run
        // rollback (if provided), then reject so callers can `await`
        // the thunk and learn whether it succeeded.
        const rb = config.rollback?.(arg);
        if (rb) dispatch(rb as PayloadAction<unknown>);
        return rejectWithValue('Sync failed; see toast for details.' as never);
      }

      const rec = config.reconcile?.(result, arg);
      if (rec) dispatch(rec as PayloadAction<unknown>);
      return result;
    },
  );
}
