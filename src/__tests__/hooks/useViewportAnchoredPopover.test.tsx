import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useViewportAnchoredPopover, useOutsideClickClose } from '../../hooks/useViewportAnchoredPopover';

// Sanity tests for the shared popover hook (TIER_2_3_PLAN.md #13).
// We're checking the contract — returns null when closed, measures
// when open, re-measures on scroll — not the visual outcome (that's
// E2E territory).

function mockBoundingRect(el: HTMLElement, rect: Partial<DOMRect>) {
  el.getBoundingClientRect = vi.fn(() => ({
    x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0,
    width: 0, height: 0, toJSON: () => ({}),
    ...rect,
  } as DOMRect));
}

describe('useViewportAnchoredPopover', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  });

  it('returns null when isOpen is false', () => {
    const btn = document.createElement('button');
    const ref = { current: btn };
    const { result } = renderHook(() => useViewportAnchoredPopover(ref, false));
    expect(result.current).toBeNull();
  });

  it('measures the trigger element when isOpen flips to true', () => {
    const btn = document.createElement('button');
    mockBoundingRect(btn, { bottom: 100, right: 900 });
    const ref = { current: btn };

    const { result } = renderHook(({ open }) => useViewportAnchoredPopover(ref, open), {
      initialProps: { open: true },
    });

    expect(result.current).not.toBeNull();
    // Top sits 4px below the trigger's bottom edge.
    expect(result.current?.top).toBe(104);
    // Right is offset from viewport's right edge (1024 - 900 = 124).
    expect(result.current?.right).toBe(124);
  });

  it('clears the position when isOpen flips back to false', () => {
    const btn = document.createElement('button');
    mockBoundingRect(btn, { bottom: 100, right: 900 });
    const ref = { current: btn };

    const { result, rerender } = renderHook(({ open }) => useViewportAnchoredPopover(ref, open), {
      initialProps: { open: true },
    });
    expect(result.current).not.toBeNull();

    rerender({ open: false });
    expect(result.current).toBeNull();
  });

  it('re-measures on window scroll while open', () => {
    const btn = document.createElement('button');
    mockBoundingRect(btn, { bottom: 100, right: 900 });
    const ref = { current: btn };

    const { result } = renderHook(() => useViewportAnchoredPopover(ref, true));
    expect(result.current?.top).toBe(104);

    // Simulate the trigger moving (scroll repositioned the page) — the
    // hook should re-measure and update the position.
    mockBoundingRect(btn, { bottom: 50, right: 900 });
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(result.current?.top).toBe(54);
  });
});

describe('useOutsideClickClose', () => {
  it('fires onClose when a mousedown happens outside the trigger', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    const ref = { current: btn };
    const onClose = vi.fn();

    renderHook(() => useOutsideClickClose(ref, true, onClose));

    // Click on the trigger — should NOT close.
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();

    // Click on something else — should close.
    const other = document.createElement('div');
    document.body.appendChild(other);
    other.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);

    document.body.removeChild(btn);
    document.body.removeChild(other);
  });

  it('does NOT fire when isOpen is false (listener not attached)', () => {
    const btn = document.createElement('button');
    const ref = { current: btn };
    const onClose = vi.fn();

    renderHook(() => useOutsideClickClose(ref, false, onClose));

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
