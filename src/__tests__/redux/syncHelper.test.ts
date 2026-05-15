import { describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import toastReducer from '../../redux/slices/toastSlice';
import { syncWithFeedback } from '../../redux/syncHelper';

// Focused tests for the sync abstraction. The listener middleware tests
// cover the end-to-end "listener → helper → toast" path; these cover
// the helper's contract directly so failures localize cleanly.

function buildStore() {
  return configureStore({ reducer: { toast: toastReducer } });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('syncWithFeedback', () => {
  it('pushes pending → success toasts on a happy path and calls onSuccess', async () => {
    const store = buildStore();
    const onSuccess = vi.fn();
    const result = await syncWithFeedback(store, {
      label: 'Test action',
      call: async () => 'ok',
      onSuccess,
    });

    expect(result).toBe('ok');
    expect(onSuccess).toHaveBeenCalledWith('ok');
    // The pending toast was upgraded in-place to success — same id, same
    // visual slot. Queue should hold exactly one entry, in 'success'.
    const queue = store.getState().toast.queue;
    expect(queue).toHaveLength(1);
    expect(queue[0].status).toBe('success');
    expect(queue[0].label).toBe('Test action');
  });

  it('retries on a transient (5xx) error before giving up', async () => {
    const store = buildStore();
    const call = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error('502'), { status: 502 }))
      .mockResolvedValueOnce('finally');

    const result = await syncWithFeedback(store, { label: 'Flaky', call });
    expect(result).toBe('finally');
    expect(call).toHaveBeenCalledTimes(2);
    // Final state is success — the retry transparently recovered.
    const queue = store.getState().toast.queue;
    expect(queue[0].status).toBe('success');
  });

  it('does NOT retry a 4xx (client error) — that\'s a logic bug, retrying hides it', async () => {
    const store = buildStore();
    const call = vi.fn<() => Promise<string>>()
      .mockRejectedValue(Object.assign(new Error('400'), { status: 400 }));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await syncWithFeedback(store, { label: 'Bad request', call });
    expect(result).toBeUndefined();
    // Single attempt — no retry on 400. Retrying would mask validation bugs.
    expect(call).toHaveBeenCalledTimes(1);
    const queue = store.getState().toast.queue;
    expect(queue[0].status).toBe('error');
    errSpy.mockRestore();
  });

  it('fires rollback on final failure (after retries exhausted)', async () => {
    const store = buildStore();
    const rollback = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const call = vi.fn<() => Promise<string>>()
      .mockRejectedValue(Object.assign(new Error('500'), { status: 500 }));

    await syncWithFeedback(store, {
      label: 'Will fail',
      call,
      rollback,
      retries: 1,
    });

    // retries=1 → 2 attempts. Both rejected → rollback fires once.
    expect(call).toHaveBeenCalledTimes(2);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(store.getState().toast.queue[0].status).toBe('error');
    errSpy.mockRestore();
  });

  it('respects silent: true — Sentry capture happens but no toast push', async () => {
    const store = buildStore();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const call = vi.fn<() => Promise<void>>()
      .mockRejectedValue(Object.assign(new Error('500'), { status: 500 }));

    await syncWithFeedback(store, {
      label: 'Telemetry-only',
      call,
      silent: true,
      retries: 0,
    });

    // No toast surfaced (silent mode), but the failure was still logged
    // — silent doesn't mean invisible to engineers, just invisible to
    // end users.
    expect(store.getState().toast.queue).toHaveLength(0);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('returns the call\'s resolved value to the caller', async () => {
    const store = buildStore();
    const result = await syncWithFeedback(store, {
      label: 'Returns value',
      call: async () => ({ id: 42, name: 'test' }),
    });
    expect(result).toEqual({ id: 42, name: 'test' });
  });

  // Just for visibility — retry backoff is 0ms in test env (see syncHelper)
  // so this completes synchronously enough not to need fake timers.
  it('does not introduce real-time delays in test env', async () => {
    const store = buildStore();
    const start = Date.now();
    const call = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error('500'), { status: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('500'), { status: 500 }))
      .mockResolvedValueOnce('ok');

    await syncWithFeedback(store, { label: 'Retry timing', call });
    const elapsed = Date.now() - start;
    // Production backoff is 400+1200=1600ms. Test env should be < 200ms
    // even under noisy CI; 500ms is a wide safety margin.
    expect(elapsed).toBeLessThan(500);
    await flush(); // drain any remaining microtasks
  });
});
