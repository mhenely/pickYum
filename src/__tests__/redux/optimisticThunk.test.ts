import { describe, it, expect, vi } from 'vitest';
import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import toastReducer from '../../redux/slices/toastSlice';
import { optimisticThunk } from '../../redux/optimisticThunk';

// Focused tests for the optimistic-mutation abstraction. Verifies the
// 4-step contract: optimistic dispatch → server call → reconcile on
// success / rollback on failure → toast surface.

interface FixtureState {
  value: number;
  pending: boolean;
}

function buildFixture() {
  const slice = createSlice({
    name: 'fixture',
    initialState: { value: 0, pending: false } as FixtureState,
    reducers: {
      // Tracks optimistic / reconcile / rollback as distinct events for
      // test assertions.
      applyOptimistic: (state, action: PayloadAction<number>) => {
        state.value = action.payload;
        state.pending = true;
      },
      applyReconcile: (state, action: PayloadAction<number>) => {
        state.value = action.payload;
        state.pending = false;
      },
      applyRollback: (state, action: PayloadAction<number>) => {
        state.value = action.payload;
        state.pending = false;
      },
    },
  });
  const store = configureStore({
    reducer: { fixture: slice.reducer, toast: toastReducer },
  });
  return { store, actions: slice.actions };
}

describe('optimisticThunk', () => {
  it('dispatches optimistic immediately, calls server, then dispatches reconcile on success', async () => {
    const { store, actions } = buildFixture();
    const call = vi.fn<(arg: number) => Promise<{ serverValue: number }>>()
      .mockResolvedValue({ serverValue: 42 });

    const thunk = optimisticThunk<number, { serverValue: number }>({
      name: 'fixture/setValue',
      optimistic: (arg) => actions.applyOptimistic(arg),
      call,
      reconcile: (result) => actions.applyReconcile(result.serverValue),
      feedback: { label: 'Saving value' },
    });

    await store.dispatch(thunk(10));

    // Server got called with the arg.
    expect(call).toHaveBeenCalledWith(10);
    // State reflects the RECONCILED value (42), not the optimistic (10).
    expect(store.getState().fixture.value).toBe(42);
    expect(store.getState().fixture.pending).toBe(false);
    // Toast queue shows success.
    expect(store.getState().toast.queue[0].status).toBe('success');
  });

  it('fires rollback on final failure and rejects', async () => {
    const { store, actions } = buildFixture();
    const err500 = Object.assign(new Error('500'), { status: 500 });
    const call = vi.fn<(arg: number) => Promise<{ serverValue: number }>>()
      .mockRejectedValue(err500);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const thunk = optimisticThunk<number, { serverValue: number }>({
      name: 'fixture/setValueFail',
      optimistic: (arg) => actions.applyOptimistic(arg),
      call,
      rollback: () => actions.applyRollback(0), // revert to baseline
      feedback: { label: 'Saving value', retries: 1 },
    });

    const action = await store.dispatch(thunk(10));

    // Rejected via rejectWithValue (not via thrown error).
    expect(action.type).toMatch(/rejected$/);
    // Rollback ran — state is back to 0, not stuck at 10.
    expect(store.getState().fixture.value).toBe(0);
    expect(store.getState().fixture.pending).toBe(false);
    // Visible failure toast.
    expect(store.getState().toast.queue[0].status).toBe('error');

    errSpy.mockRestore();
  });

  it('respects reconcile=null (no follow-up dispatch on success)', async () => {
    const { store, actions } = buildFixture();
    const call = vi.fn<(arg: number) => Promise<void>>().mockResolvedValue(undefined as never);

    const thunk = optimisticThunk<number, void>({
      name: 'fixture/noReconcile',
      optimistic: (arg) => actions.applyOptimistic(arg),
      call,
      reconcile: () => null, // explicit: no reconcile needed
      feedback: { label: 'Fire and forget' },
    });

    await store.dispatch(thunk(99));
    // Optimistic value sticks — reconcile was a no-op by design.
    expect(store.getState().fixture.value).toBe(99);
    expect(store.getState().fixture.pending).toBe(true);
  });

  it('respects rollback=null (no rollback on failure — leaves state applied)', async () => {
    const { store, actions } = buildFixture();
    const err400 = Object.assign(new Error('400'), { status: 400 });
    const call = vi.fn<(arg: number) => Promise<void>>().mockRejectedValue(err400);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const thunk = optimisticThunk<number, void>({
      name: 'fixture/noRollback',
      optimistic: (arg) => actions.applyOptimistic(arg),
      call,
      rollback: () => null, // intentional: keep the optimistic state
      feedback: { label: 'Leave it applied' },
    });

    await store.dispatch(thunk(7));
    // Optimistic value stuck despite the failure.
    expect(store.getState().fixture.value).toBe(7);
    expect(store.getState().toast.queue[0].status).toBe('error');

    errSpy.mockRestore();
  });
});
