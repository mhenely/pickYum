import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

// Lightweight feedback channel for the sync abstraction. Mutations that
// previously failed silently in the listener middleware now go through
// `syncWithFeedback` (../syncHelper.ts), which pushes Toast entries onto
// this slice. The <Toaster> component subscribes and renders them.
//
// Why a slice and not a context: failures happen inside the listener
// middleware (no React tree), and any component that subscribes to the
// store can read the queue. A context would force us to drill into the
// React tree from middleware (we'd need a global ref dance), which is
// uglier than just dispatching an action.

export type ToastStatus = 'pending' | 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  // `pending` shows a subtle in-progress chip and auto-clears on
  // success/error. `success` auto-dismisses after a few seconds.
  // `error` is persistent until the user dismisses or retries — silent
  // failures are the bug we're fixing, so erring on the side of "user
  // sees it" beats "user doesn't notice the data is stale."
  status: ToastStatus;
  label: string;
  detail?: string;
  // Set on `error` toasts: the action creator name the helper used.
  // The retry button reads this to know what to fire. Not used for
  // success/pending — those are display-only.
  retryActionType?: string;
  // Original payload to re-dispatch on retry. Stored as `unknown` because
  // each action's payload shape is its own concern; the retry path just
  // round-trips it back through `dispatch({ type, payload })`.
  retryPayload?: unknown;
  // Sentry breadcrumb id, useful when a user reports "I saw an error
  // toast at 2:31pm" — surfaces in support flows.
  errorId?: string;
  createdAt: number;
}

interface ToastState {
  // Order matters — toasts stack newest-on-bottom in the UI. Cap at
  // ~10 to avoid runaway accumulation when a server is down and every
  // background sync fails.
  queue: Toast[];
}

const MAX_TOASTS = 10;

const initialState: ToastState = { queue: [] };

const toastSlice = createSlice({
  name: 'toast',
  initialState,
  reducers: {
    pushToast: (state, action: PayloadAction<Omit<Toast, 'createdAt'>>) => {
      // De-dup by id: pending → success transitions reuse the same id,
      // so the visible toast in-place upgrades rather than stacking two.
      const existing = state.queue.findIndex((t) => t.id === action.payload.id);
      const next: Toast = { ...action.payload, createdAt: Date.now() };
      if (existing >= 0) {
        state.queue[existing] = next;
      } else {
        state.queue.push(next);
        if (state.queue.length > MAX_TOASTS) state.queue.shift();
      }
    },
    dismissToast: (state, action: PayloadAction<string>) => {
      state.queue = state.queue.filter((t) => t.id !== action.payload);
    },
    clearToasts: (state) => {
      state.queue = [];
    },
  },
});

export const { pushToast, dismissToast, clearToasts } = toastSlice.actions;
export default toastSlice.reducer;
