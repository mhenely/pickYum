// Tunable constants for the /me/insights aggregation pipeline.
//
// These values were inlined in the route handler until TIER_2_3_PLAN.md
// #14. Moving them here:
//   - Documents WHY each value is what it is, in one place.
//   - Makes it possible to override them per-environment (a future env-
//     var pass would import these and replace with `process.env.X ?? N`).
//   - Lets tests import + assert against the exported constant rather
//     than re-deriving the math.

/** Window sizes (in days) for the `since=` query parameter on /me/insights.
 *  Sliding from "now" rather than calendar boundaries so "this week"
 *  doesn't reset every Monday. */
export const INSIGHT_WINDOW_DAYS: Record<string, number> = {
  week:  7,
  month: 30,
  year:  365,
};

/** Cap for `since=all` (and any unrecognized value). Without a cap, the
 *  in-memory rollup grows unbounded as a user's history accumulates. At
 *  5 years × ~300 picks/year = ~1500 rows worst case, the rollup stays
 *  comfortably aggregatable in-process without streaming.
 *
 *  If real users complain that they want literal "since forever," we'll
 *  move the aggregation into a materialized view (TIER_2_3_PLAN.md #12). */
export const INSIGHTS_ALL_TIME_CAP_DAYS = 5 * 365;

/** A favorite the user hasn't picked in this many days (or ever) shows
 *  up in the Insights "Neglected favorites" panel. 60 days is the sweet
 *  spot — long enough that a "hey, remember this place?" nudge is
 *  welcome, short enough that the list isn't empty for active users. */
export const NEGLECT_THRESHOLD_DAYS = 60;

/** Cuisine sparklines render this many weekly buckets, independent of
 *  the `since` dropdown. Fixed window keeps the trend line readable —
 *  filter changes don't redraw the cuisine sparklines. */
export const SPARKLINE_WEEKS = 12;

/** Milliseconds in a day. Exported because every time-bucket calc in
 *  this module needed it; cheaper to import once than declare four
 *  times. */
export const DAY_MS = 24 * 60 * 60 * 1000;
