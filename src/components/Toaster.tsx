import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { dismissToast, type Toast } from '../redux/slices/toastSlice';
import type { RootState } from '../redux/store';

// Render surface for the sync abstraction's toast queue. Lives in a
// portal-friendly fixed-position container so it floats above modals.
//
// UX rules:
//   - `pending` is a quiet chip with a spinner; no auto-dismiss (the
//     helper transitions it to success/error itself).
//   - `success` auto-dismisses after 2.5s — the user doesn't need to
//     dwell on "saved".
//   - `error` is persistent until the user dismisses. Silent failures
//     were the bug we're fixing; the cure has to be loud enough to
//     hear.
//
// Mounted once at the app root (App.tsx). Subscribes via useSelector,
// so unmounted components don't matter — toasts survive page navigation.

const SUCCESS_TIMEOUT_MS = 2500;

// Module-level empty array — referenced by the selector's fallback
// path so the missing-slice branch returns the SAME array reference
// each call. Inline `?? []` would create a fresh ref per call and
// React-Redux's dev-mode stability check (rightly) flags the selector
// as unstable. Same trick as `allLists` in utils/favoriteLists.js.
//
// Not `Object.freeze`-d because TS narrows that to `readonly Toast[]`
// which doesn't satisfy useSelector's expectation of a mutable array
// shape. The convention "module constants are not mutated" is enough
// here — no consumer reaches in to push into this array.
const EMPTY_QUEUE: Toast[] = [];

function ToastItem({ toast }: { toast: Toast }) {
  const dispatch = useDispatch();

  useEffect(() => {
    if (toast.status !== 'success') return undefined;
    const t = setTimeout(() => dispatch(dismissToast(toast.id)), SUCCESS_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [toast.status, toast.id, dispatch]);

  const palette =
    toast.status === 'error'   ? 'bg-red-50 border-red-300 text-red-800'
  : toast.status === 'success' ? 'bg-green-50 border-green-300 text-green-800'
  : toast.status === 'pending' ? 'bg-gray-50 border-gray-300 text-gray-700'
  :                              'bg-blue-50 border-blue-300 text-blue-800';

  const icon =
    toast.status === 'error'   ? '⚠'
  : toast.status === 'success' ? '✓'
  : toast.status === 'pending' ? '⋯'
  :                              'ℹ';

  return (
    <div
      role={toast.status === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2 ${palette} border rounded-lg shadow-sm px-3 py-2 text-sm w-80 pointer-events-auto`}
    >
      <span aria-hidden className="text-base leading-none mt-0.5">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{toast.label}</div>
        {toast.detail && (
          <div className="text-xs opacity-75 mt-0.5 break-words">{toast.detail}</div>
        )}
        {toast.errorId && (
          // Surfaces the Sentry breadcrumb id so a user reporting an
          // issue can paste it and we can find the trace immediately.
          <div className="text-[10px] opacity-50 mt-1 font-mono">ref: {toast.errorId.slice(0, 8)}</div>
        )}
      </div>
      <button
        type="button"
        onClick={() => dispatch(dismissToast(toast.id))}
        aria-label="Dismiss"
        className="text-xs opacity-50 hover:opacity-100 leading-none"
      >
        ✕
      </button>
    </div>
  );
}

export default function Toaster() {
  // Defensive read: if a stale dev-mode build is missing the toast
  // slice (or a future refactor forgets to register it), we degrade
  // to "no toasts visible" rather than crashing the entire app from
  // the root. The whitescreen we saw before this guard was a
  // disproportionate response to a missing background-mutation
  // feedback surface — the user can still use the app without it.
  const queue = useSelector((s: RootState) => s.toast?.queue ?? EMPTY_QUEUE);
  if (queue.length === 0) return null;
  return (
    <div
      className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
    >
      {queue.map((t) => <ToastItem key={t.id} toast={t} />)}
    </div>
  );
}
