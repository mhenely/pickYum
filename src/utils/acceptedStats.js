// acceptedStats — O(N) precompute over the user's accepted history that
// every restaurant-list page can read in O(1) per row.
//
// The legacy `getMostRecentDate(accepted, id)` / `getChosenCount(accepted, id)`
// helpers scan the full accepted array on every call. Pages like HistoryPage
// call them inside a `.sort()` comparator (O(N log N × M)) and HelpMeChoose
// / RestaurantPage call them inside their row maps (O(cards × M)). With ~50
// accepted entries and ~10 cards that's ~5,000 array scans per render — and
// those pages re-render on every keystroke into a search box.
//
// Build the stats map ONCE per `accepted` array (memoized at the call site
// via `useMemo([accepted], …)`) and let row maps do `stats.get(id)`.

/**
 * @param {Array<{ restaurantId: string|number; date: string }>} accepted
 * @returns {Map<string, { lastTs: number; count: number }>}
 */
export function buildAcceptedStats(accepted) {
  const m = new Map();
  if (!Array.isArray(accepted)) return m;
  for (const a of accepted) {
    if (!a || a.restaurantId == null) continue;
    const id = String(a.restaurantId);
    const ts = new Date(a.date).getTime();
    const prev = m.get(id);
    if (prev) {
      if (ts > prev.lastTs) prev.lastTs = ts;
      prev.count += 1;
    } else {
      m.set(id, { lastTs: Number.isFinite(ts) ? ts : 0, count: 1 });
    }
  }
  return m;
}

/**
 * Format the last-chosen timestamp for a card's "Last chosen …" line.
 * Returns null when the restaurant has never been chosen — callers can
 * conditionally render the line. Output matches the legacy
 * getMostRecentDate format so visual diffs are zero.
 */
export function formatLastChosen(stats, restaurantId) {
  const entry = stats.get(String(restaurantId));
  if (!entry || entry.lastTs === 0) return null;
  return new Date(entry.lastTs).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

/**
 * Count of acceptances for a restaurant — 0 when never chosen.
 */
export function getChosenCount(stats, restaurantId) {
  return stats.get(String(restaurantId))?.count ?? 0;
}
