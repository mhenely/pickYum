import { useEffect, useRef, useState } from 'react';

/**
 * Track which item inside a scrollable list is currently most-visible
 * (closest to the container's vertical center) and return its 0-based
 * index. Used to render "3 / 7"-style position indicators next to
 * scrollable sidebar lists (Favorites / Options on Compare; Favorites
 * on Choose) so the user knows both the total count AND where in the
 * list they currently are as they scroll.
 *
 * Why center-distance instead of "first visible" or "top-aligned":
 *   - "Top-aligned" flickers between adjacent items at scroll
 *     boundaries (a card scrolled half-off is technically not at the
 *     top, but the next one isn't either, so the indicator jumps).
 *   - Center-distance picks the card most visibly dominant in the
 *     viewport — matches user intuition of "what am I looking at".
 *
 * Why getBoundingClientRect + scroll events instead of
 * IntersectionObserver: IO callbacks fire only on threshold crossings
 * and we'd need to maintain a Map of last-known ratios to compute
 * "currently most visible". A 1-line scroll handler with
 * getBoundingClientRect + RAF throttling is simpler and equivalently
 * cheap at this scale (≤30 items per list).
 *
 * Why the VIEWPORT center (not the container center) as the reference
 * point: many of our list containers have `max-h-[80vh]` but few-
 * enough items to fit without overflowing. In that case the container
 * has no internal scrollbar and the user scrolls the PAGE instead.
 * Measuring distance to the container's center would lock in the
 * middle item forever (container and items move together when the
 * page scrolls, so relative distances never change). Measuring
 * against `window.innerHeight / 2` works for both:
 *   - internally-scrolling container: container is stationary in
 *     viewport coords, cards move within it, the card nearest the
 *     viewport center is the most visually dominant. Equivalent to
 *     the old "container center" behavior in practice because the
 *     container fills most of the visible area.
 *   - page-scrolling container: cards move with the page, but the
 *     viewport center is anchored — items pass through it as the
 *     user scrolls. Indicator updates correctly.
 *
 * @param {React.RefObject<HTMLElement>} scrollRef Ref on the
 *   overflow-y-auto container. Items are looked up via getItems(container).
 * @param {number} itemCount Used as a dependency to re-attach the
 *   observer when the list grows/shrinks. Pass the source list's
 *   `.length` to keep the indicator in sync with adds/removes.
 * @param {(container: HTMLElement) => Iterable<Element>} [getItems]
 *   Returns the list of card elements inside the container. Default
 *   picks direct children — works for `<scroll>{cards}</scroll>`.
 *   For wrapped layouts (e.g. left-scrollbar lists with an outer
 *   `direction:rtl` and inner `direction:ltr` wrapper) pass
 *   `c => c.firstElementChild?.children`.
 * @returns {number} 0-based index of the currently-centered item,
 *   or 0 when the list is empty.
 */
export function useScrollListIndex(scrollRef, itemCount, getItems) {
  const [activeIdx, setActiveIdx] = useState(0);

  // Pin `getItems` through a ref so the effect doesn't have to take it
  // as a dependency. Previously, callers had to pass an inline arrow
  // every render to force the effect to re-run (otherwise stable
  // `getItems` meant the scroll listener attached once and never
  // re-measured on resize / DOM swaps). With the ref pattern the
  // effect attaches the listener once and we always read the latest
  // `getItems` inside the scroll handler. Eliminates the footgun.
  const getItemsRef = useRef(getItems);
  getItemsRef.current = getItems;

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || itemCount === 0) {
      setActiveIdx(0);
      return;
    }

    const update = () => {
      // Read the latest getItems each call — falls back to direct
      // children when the caller didn't customize.
      const itemsOf = getItemsRef.current ?? ((c) => c.children);
      const items = Array.from(itemsOf(container) ?? []);
      if (items.length === 0) return;

      // Viewport center as the reference point (see header comment
      // for the rationale — handles both internally-scrolling AND
      // page-scrolling list containers).
      const viewportCenter = window.innerHeight / 2;

      // Skip items that aren't even on screen — gives a sensible
      // result when the list is scrolled completely past or before
      // the viewport, instead of picking whichever item happens to
      // be "closest" to the viewport center while off-screen.
      let bestIdx = 0;
      let bestDistance = Infinity;
      items.forEach((item, idx) => {
        const r = item.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) return;
        const center = (r.top + r.bottom) / 2;
        const d = Math.abs(center - viewportCenter);
        if (d < bestDistance) {
          bestDistance = d;
          bestIdx = idx;
        }
      });
      // bestDistance stayed Infinity → nothing on screen. Leave the
      // active index where it was rather than reset to 0; that keeps
      // the indicator stable while the list is fully off-screen.
      if (bestDistance !== Infinity) setActiveIdx(bestIdx);
    };

    // RAF-throttle: scroll events fire at the device refresh rate
    // (~120Hz on a ProMotion display); coalescing to one update per
    // animation frame caps recompute at the paint rate without
    // missing any meaningful position change.
    let rafId = null;
    const onScroll = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        update();
      });
    };

    update(); // seed with initial position
    container.addEventListener('scroll', onScroll, { passive: true });
    // ALSO listen on the window so page scrolls drive the indicator
    // when the container doesn't overflow internally (e.g. a list
    // small enough to fit inside its `max-h` without scrollbars —
    // the user still scrolls the page to reach it).
    window.addEventListener('scroll', onScroll, { passive: true });
    // Re-measure on viewport resize too — the viewport center shifts
    // when the window changes height, which would otherwise leave
    // the indicator stale until the next scroll event.
    window.addEventListener('resize', onScroll, { passive: true });

    // Cards' heights can change after mount — the photo carousel
    // swaps in an `<img>` once it loads, the collapsible hours
    // section expands, etc. Re-measure when the container resizes
    // (its scrollHeight changes when children reflow) so the
    // indicator doesn't lag the actual visible card.
    const ro = new ResizeObserver(onScroll);
    ro.observe(container);

    return () => {
      container.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [scrollRef, itemCount]);

  return activeIdx;
}
