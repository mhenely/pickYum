import { describe, it, expect } from 'vitest';
import reducer, { setIsOpen } from '../../redux/slices/chooseModalSlice';

const base = reducer(undefined, { type: '@@INIT' });

describe('chooseModalSlice', () => {
  it('initialises with isOpen false', () => {
    expect(base.isOpen).toBe(false);
  });

  it('setIsOpen toggles isOpen to true', () => {
    const state = reducer(base, setIsOpen());
    expect(state.isOpen).toBe(true);
  });

  it('setIsOpen toggles isOpen back to false', () => {
    const opened = reducer(base, setIsOpen());
    const closed = reducer(opened, setIsOpen());
    expect(closed.isOpen).toBe(false);
  });
});
