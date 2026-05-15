import { describe, it, expect } from 'vitest';
import reducer, { setFlags, loadFlags, defaultFlags } from '../../redux/slices/flagsSlice';

describe('flagsSlice', () => {
  it('starts with documented defaults + loaded=false', () => {
    const state = reducer(undefined, { type: '@@INIT' });
    expect(state.values).toEqual(defaultFlags);
    expect(state.loaded).toBe(false);
  });

  it('merges loadFlags.fulfilled payload onto the defaults', () => {
    // A future server might send only the flags it knows about — the
    // client merges them onto the defaults so any flag the server
    // doesn't ship stays at its safe default rather than going
    // undefined.
    const state = reducer(undefined, {
      type: loadFlags.fulfilled.type,
      payload: { newDetailModal: true },
    });
    expect(state.values.newDetailModal).toBe(true);
    expect(state.values.insightsOptOutVisible).toBe(true); // unchanged default
    expect(state.loaded).toBe(true);
  });

  it('keeps defaults on loadFlags.rejected (fail-open contract)', () => {
    // Flag fetch failing is non-fatal — slice keeps defaults so the
    // app boots normally. `loaded` flips to true so the rest of the
    // UI doesn't wait forever.
    const state = reducer(undefined, { type: loadFlags.rejected.type, payload: undefined });
    expect(state.values).toEqual(defaultFlags);
    expect(state.loaded).toBe(true);
  });

  it('setFlags patches one or more flags in place', () => {
    const state = reducer(undefined, setFlags({ newDetailModal: true, backgroundRefresh: true }));
    expect(state.values.newDetailModal).toBe(true);
    expect(state.values.backgroundRefresh).toBe(true);
    expect(state.values.insightsOptOutVisible).toBe(true); // untouched
  });
});
