// Compute fresh open-now / closing-soon status from a Google Places
// `regularOpeningHours.periods` array. We do this client-side rather
// than trusting the snapshot `openNow` boolean Google ships because:
//   - the snapshot is captured at search/refresh time and can be hours
//     stale by modal-open time
//   - it gives us the closing-soon window (60 min) for free, which
//     Google doesn't surface directly
//
// CAVEAT: we evaluate against the user's local clock — there is no
// timezone awareness here. For nearby search this is fine (the user is
// in roughly the same timezone as the restaurant). For saved/cross-
// timezone restaurants this will be wrong; if that turns out to matter,
// the fix is to persist the place's timezone and convert before
// indexing periods.

const CLOSING_SOON_MS = 60 * 60 * 1000; // 60 minutes

// Convert a Google opening Point (day 0-6, hour 0-23, minute 0-59) to
// minutes since the start of the week (Sunday 00:00). Used to normalize
// "open" and "close" so we can do simple arithmetic + handle periods
// that wrap past midnight.
const pointToMinutes = ({ day, hour, minute }) =>
  day * 24 * 60 + hour * 60 + minute;

const WEEK_MINUTES = 7 * 24 * 60;

// Current time as minutes-of-week, plus the underlying Date so callers
// can compose a human "Closes at 9:30 PM" string from a real Date.
function nowAsMinutesOfWeek(now = new Date()) {
  return now.getDay() * 24 * 60 + now.getHours() * 60 + now.getMinutes();
}

// Build a Date in the future representing the "close" of a period that
// currently encloses `now`. close.day may wrap past Saturday, so we use
// the close offset relative to now to compute the absolute timestamp.
function closeTimeForPeriod(now, openMin, closeMin) {
  // closeMin can be < openMin when the period wraps midnight (e.g. open
  // Friday 18:00, close Saturday 02:00). Normalize so the close is
  // always after the open we're evaluating against.
  let normalizedClose = closeMin;
  if (normalizedClose <= openMin) normalizedClose += WEEK_MINUTES;
  const nowMin = nowAsMinutesOfWeek(now);
  // Distance in minutes from now to close. closeMin's week-of-minutes
  // may be earlier in the week — wrap it forward similarly.
  let normalizedNow = nowMin;
  if (normalizedNow < openMin) normalizedNow += WEEK_MINUTES;
  const deltaMs = (normalizedClose - normalizedNow) * 60 * 1000;
  return new Date(now.getTime() + deltaMs);
}

/**
 * Evaluate whether the place is open right now and how close to closing.
 *
 * @param {{ periods?: Array<{ open: { day: number; hour: number; minute: number },
 *                              close: { day: number; hour: number; minute: number } | null }> } | null | undefined} regularOpeningHours
 * @param {Date} [now=new Date()]
 * @returns {{
 *   isOpen: boolean,
 *   closingSoon: boolean,    // open AND closing in <= 60 min
 *   closesAt: Date | null,   // when the current open period ends (null if not open OR 24h)
 *   opensAt: Date | null,    // when the next open period starts (null if no future period; only set when !isOpen)
 *   hasData: boolean,        // false when periods are missing/empty
 * }}
 */
export function getOpenStatus(regularOpeningHours, now = new Date()) {
  const periods = Array.isArray(regularOpeningHours?.periods)
    ? regularOpeningHours.periods
    : [];
  if (periods.length === 0) {
    return { isOpen: false, closingSoon: false, closesAt: null, opensAt: null, hasData: false };
  }

  // 24/7 special case: Google represents always-open as a single period
  // with open at Sunday 00:00 and no close. Treat as permanently open.
  if (periods.length === 1 && periods[0].close == null) {
    return { isOpen: true, closingSoon: false, closesAt: null, opensAt: null, hasData: true };
  }

  const nowMin = nowAsMinutesOfWeek(now);

  // Walk every period and check whether `now` falls inside [open, close)
  // taking into account periods that wrap past midnight (close < open).
  for (const p of periods) {
    if (!p?.open || !p?.close) continue;
    const openMin  = pointToMinutes(p.open);
    const closeMin = pointToMinutes(p.close);

    const wraps = closeMin <= openMin;
    const inside = wraps
      // Wrap case: now is either after open today OR before close (next morning)
      ? (nowMin >= openMin || nowMin < closeMin)
      : (nowMin >= openMin && nowMin < closeMin);

    if (inside) {
      const closesAt = closeTimeForPeriod(now, openMin, closeMin);
      const msUntilClose = closesAt.getTime() - now.getTime();
      return {
        isOpen: true,
        closingSoon: msUntilClose > 0 && msUntilClose <= CLOSING_SOON_MS,
        closesAt,
        opensAt: null,
        hasData: true,
      };
    }
  }

  // Closed — find the soonest upcoming open. Compute minutes-until-open
  // for every period, wrap forward when the period is earlier in the
  // week than now, take the smallest.
  let bestDelta = Infinity;
  let bestPeriod = null;
  for (const p of periods) {
    if (!p?.open) continue;
    const openMin = pointToMinutes(p.open);
    let delta = openMin - nowMin;
    if (delta <= 0) delta += WEEK_MINUTES; // next week
    if (delta < bestDelta) {
      bestDelta = delta;
      bestPeriod = p;
    }
  }
  const opensAt = bestPeriod
    ? new Date(now.getTime() + bestDelta * 60 * 1000)
    : null;

  return { isOpen: false, closingSoon: false, closesAt: null, opensAt, hasData: true };
}

// Format a Date as a friendly local time string like "9:30 PM".
// toLocaleTimeString without options would render seconds in some
// locales; we restrict to hour + minute and let the locale decide
// 12h/24h based on user preferences.
export function formatLocalTime(date) {
  if (!date) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
