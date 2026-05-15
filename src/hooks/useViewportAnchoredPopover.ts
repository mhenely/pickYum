import { useEffect, useRef, useState, type RefObject } from 'react';

// Positioning hook for portaled popovers anchored to an in-tree trigger
// element.
//
// The problem this solves: cards on Compare / Choose / Search / History
// live inside `overflow-y-auto` containers (sidebars, modal bodies, etc).
// A normal `absolute top-full right-0 mt-1` popover would clip at the
// scroll container's boundary. The fix is to portal the popover to
// `document.body` so it escapes the clip, but then we need explicit
// viewport coordinates to position it — which is what this hook
// computes from the trigger button's bounding rect.
//
// Behavior:
//   - When `isOpen` is true, measures `ref.current.getBoundingClientRect()`
//     and returns `{ top, right }` in viewport coordinates.
//   - Re-measures on scroll (capture phase, so nested overflow containers
//     fire too — not just window scroll) and on resize.
//   - When `isOpen` flips false, returns `null` so the caller can skip
//     rendering the portaled wrapper entirely.
//
// Usage:
//   const btnRef = useRef<HTMLButtonElement>(null);
//   const [open, setOpen] = useState(false);
//   const pos = useViewportAnchoredPopover(btnRef, open);
//
//   {open && pos && createPortal(
//     <div className="fixed z-[60]" style={{ top: pos.top, right: pos.right }}>
//       <MyPopover />
//     </div>,
//     document.body,
//   )}
//
// Extracted from HeartWithKebab + HistoryRowKebab where the same dance
// was inlined twice (TIER_2_3_PLAN.md #13). New kebab components should
// reach for this hook instead of duplicating the pattern again.
export interface PopoverPosition {
  top: number;
  // Offset from the RIGHT edge of the viewport (`window.innerWidth - rect.right`).
  // Anchoring on the right makes the popover hug the trigger's right
  // edge — same visual result the legacy `right-0` Tailwind class had,
  // without taking the popover out of the normal flow.
  right: number;
}

export function useViewportAnchoredPopover(
  ref: RefObject<HTMLElement | null>,
  isOpen: boolean,
): PopoverPosition | null {
  const [pos, setPos] = useState<PopoverPosition | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setPos(null);
      return undefined;
    }
    const measure = () => {
      const btn = ref.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setPos({
        top:   r.bottom + 4,
        right: window.innerWidth - r.right,
      });
    };
    measure();
    // Capture-phase scroll listener catches nested overflow containers,
    // not just window scroll. Without `true` here, a sidebar's scroll
    // wouldn't fire this listener and the popover would drift off-screen.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [ref, isOpen]);

  return pos;
}

// Companion: register an outside-click handler that closes the popover
// when the user clicks anywhere except the trigger (clicks inside the
// popover itself bubble up to document but typically have their own
// e.stopPropagation()-ing handlers).
//
// Separate hook because not every popover wants outside-click
// dismissal — sometimes the consumer wants Escape-only (e.g. forms in
// progress where a stray click shouldn't lose state).
export function useOutsideClickClose(
  triggerRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  onClose: () => void,
): void {
  // Pin onClose in a ref so the listener doesn't re-bind on every
  // render — without this, an arrow-function `onClose={() => ...}`
  // would cause the effect to detach/reattach on every parent render,
  // dropping clicks that race the rebind.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (triggerRef.current && target && triggerRef.current.contains(target)) return;
      onCloseRef.current();
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [triggerRef, isOpen]);
}
