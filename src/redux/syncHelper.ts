import { pushToast, type Toast } from './slices/toastSlice';

// Replacement for the silent `try { await api.x(...) } catch (err) { console.error(...) }`
// pattern that pervaded listenerMiddleware. Wraps a server call with:
//   1. Optimistic-friendly contract: the caller has ALREADY dispatched the
//      local state change before calling this — that's the "feel instant"
//      part. This helper takes over from the network call onward.
//   2. Retry-with-backoff for transient errors (network, 5xx). Most real
//      outages are transient and a single retry resolves them; we don't
//      want to surface "Couldn't save" the instant a wifi packet drops.
//   3. Visible failure surface: a persistent error toast with a Retry
//      button when retries are exhausted. The user sees the failure
//      instead of finding it days later when Insights disagrees with
//      History.
//   4. Optional rollback: if the caller passes `rollback`, it fires on
//      final failure so local state un-applies the optimistic change.
//      Components that DON'T want to rollback (e.g. "best effort log
//      this view") omit it and the local state stays.
//   5. Telemetry: errors flow through Sentry via the global error
//      reporter on `window`. Quiet otherwise.
//
// Why this isn't `createAsyncThunk`: thunks are great for "the component
// is awaiting the result" flows. Listener middleware effects are
// background — the component already moved on. We want fire-and-track,
// not fire-and-await-result, and the toast queue IS the result surface.

export interface SyncOptions<T> {
  // Short label shown in the toast. "Saving favorite", "Removing from
  // history", etc. Use sentence-case, no period.
  label: string;
  // The network call. Return whatever the success path needs to
  // reconcile state (e.g. the row id from POST). Errors should throw.
  call: () => Promise<T>;
  // Fired with the resolved value on success. Reconciliation goes
  // here — dispatching server-id backfills, swapping a local-id for
  // a real one, etc.
  onSuccess?: (result: T) => void;
  // Fired on final failure (after retries). Use this to undo the local
  // optimistic state. Omit when the local state should persist (e.g.
  // a flag the user explicitly set that we'll re-sync next mount).
  rollback?: () => void;
  // How many times to retry on transient failure before giving up.
  // Default 2 (3 total attempts). Transient = network error, 5xx, 429.
  // 4xx other than 429 don't retry — they're caller bugs.
  retries?: number;
  // Some calls (logging, recording flip counts) shouldn't surface a
  // toast at all — failure is acceptable. Set silent=true to skip the
  // toast push but keep retry + Sentry capture.
  silent?: boolean;
  // Sentry tags for debugging. e.g. { feature: 'favorites', action: 'toggle' }.
  context?: Record<string, string | number | boolean>;
}

// Permissive dispatch type — accepts the AppDispatch from the store as
// well as the ListenerEffectApi's dispatch (which is structurally the
// same but narrower in TS). Using a wide function signature here lets
// both callers pass without `as any` at the call site. The pushToast
// action conforms to whichever dispatch shape Redux requires at runtime.
interface SyncMinimalDispatch {
  dispatch: (action: { type: string; payload?: unknown }) => unknown;
}

// 1st retry after 400ms, 2nd after 1.2s. Gentle pacing — we don't want a
// thundering-herd retry storm if the API is overloaded.
//
// In test env (Vitest) the backoff is forced to zero so unit tests
// don't pay real-time waits. The retry logic itself still runs; only the
// `setTimeout(...)` delay shortens. Detected via Vite's `import.meta.env.MODE`,
// which is injected at build/test time. The Node-only `process.env.NODE_ENV`
// fallback was removed — this file is browser-bundled and pulling in
// `@types/node` here would bleed Node globals into the browser typescript
// world. Vitest runs through Vite, so MODE=test is reliable.
function isTestEnv(): boolean {
  try {
    // `as any` because the field isn't in lib.dom and we don't want to
    // import vite types here.
    const viteMode = (import.meta as unknown as { env?: { MODE?: string } })?.env?.MODE;
    if (viteMode === 'test') return true;
  } catch { /* not in a Vite context */ }
  return false;
}
const RETRY_BACKOFF_MS = isTestEnv() ? [0, 0] : [400, 1200];

function isTransientError(err: unknown): boolean {
  // Heuristic: if it has an HTTP status, retry on 0 (network fail), 408,
  // 429, and 5xx. Without a status (thrown by fetch on actual network
  // failure) it's also transient. With a 4xx (other than 408/429) it's
  // a logic error or auth issue, no point retrying.
  const status = (err as { status?: number })?.status;
  if (status == null) return true;             // network / parse / no response
  if (status === 0 || status === 408 || status === 429) return true;
  if (status >= 500) return true;
  return false;
}

function captureSentry(err: unknown, label: string, context?: Record<string, unknown>): string | undefined {
  // Pino on the server, Sentry on the browser. Sentry-SDK is loaded
  // lazily — we don't want a hard dependency from this helper, so we
  // probe for the global. Falls back to console.error when missing
  // (dev / Sentry-not-configured), but ALWAYS logs so failures are
  // never invisible. The error toast is the user-facing surface;
  // this is the engineer-facing surface.
  const sentry = (typeof window !== 'undefined' ? (window as unknown as {
    Sentry?: { captureException: (e: unknown, ctx?: unknown) => string };
  }).Sentry : undefined);
  if (sentry?.captureException) {
    try {
      return sentry.captureException(err, { tags: { syncLabel: label, ...context } });
    } catch { /* belt + suspenders */ }
  }
  // eslint-disable-next-line no-console
  console.error(`[sync] ${label} failed:`, err, context);
  return undefined;
}

let _toastCounter = 0;
function nextToastId(label: string): string {
  // Including the label keeps the ids semi-readable in Redux devtools
  // and the counter prevents collisions when the same call fires twice
  // in quick succession (e.g. user double-clicks).
  _toastCounter += 1;
  return `sync:${label.toLowerCase().replace(/\s+/g, '-')}:${_toastCounter}`;
}

/**
 * Run a server call with retry, telemetry, and visible feedback. Returns
 * the resolved value on success, or `undefined` on final failure (after
 * rollback has fired). The function intentionally does NOT throw — the
 * background sync contract is "best effort, user is informed."
 *
 * For thunks that DO want to throw (component awaits and shows its own
 * UI), this isn't the right helper — call the api directly.
 */
export async function syncWithFeedback<T>(
  { dispatch }: SyncMinimalDispatch,
  opts: SyncOptions<T>,
): Promise<T | undefined> {
  const { label, call, onSuccess, rollback, retries = 2, silent = false, context } = opts;
  const id = nextToastId(label);

  if (!silent) {
    dispatch(pushToast({ id, status: 'pending', label } satisfies Omit<Toast, 'createdAt'>));
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await call();
      if (!silent) {
        dispatch(pushToast({ id, status: 'success', label } satisfies Omit<Toast, 'createdAt'>));
      }
      onSuccess?.(result);
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isTransientError(err)) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt] ?? 1500));
        continue;
      }
      break;
    }
  }

  // Final failure path.
  const errorId = captureSentry(lastErr, label, context);
  rollback?.();
  if (!silent) {
    const detail = (lastErr as { message?: string })?.message ?? 'Couldn’t reach the server.';
    dispatch(pushToast({
      id,
      status: 'error',
      label,
      detail,
      errorId,
    } satisfies Omit<Toast, 'createdAt'>));
  }
  return undefined;
}
