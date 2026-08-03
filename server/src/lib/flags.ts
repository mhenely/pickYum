// Lightweight feature flag system. Env-var driven, read at boot.
//
// Why env vars and not a service (LaunchDarkly/Statsig/Unleash):
//   - The cost of an external flag service isn't justified at this stage —
//     setup, network dependency, runtime fetch overhead.
//   - We need flags for two things right now: (a) canarying a risky
//     refactor before flipping for all users, (b) emergency kill-switches
//     when a new feature misbehaves. Env vars cover both via redeploy.
//   - Migration to a service later is one-helper-change.
//
// Add a flag (TIER_2_3_PLAN.md #15):
//   1. Add a key to the FLAGS object below with a documented default.
//   2. Reference `flags.<key>` server-side OR rely on /api/flags's
//      response to gate the corresponding UI on the client.
//   3. Add a one-line removal note here so flags don't pile up forever.
//
// Naming convention:
//   - Boolean keys named after the feature ("newDetailModal"), not
//     "enable_newDetailModal" — readable as English: `if (flags.newDetailModal)`.
//   - Env var follows the same camelCase: `FLAG_NEW_DETAIL_MODAL=true`.
//     (Upper-snake env var; converted by the helper below.)

export interface FeatureFlags {
  /** Replacement RestaurantDetailModal that's being decomposed
   *  (TIER_2_3_PLAN.md #10). Default false; flip to true to canary
   *  the new path before the old code is removed. Remove flag when
   *  the new modal has been default-on for ~2 weeks with no incident. */
  newDetailModal: boolean;

  /** Whether the per-entry insights opt-out toggle is visible in
   *  History rows. Default true (already shipped to all users); kept
   *  as a kill-switch in case the toggle exposes a bug. Remove flag
   *  once we're confident it stays on forever. */
  insightsOptOutVisible: boolean;

  /** Whether to fire the nightly background refresh job
   *  (TIER_2_3_PLAN.md #16). Default false until the job is rolled
   *  out + budget caps are validated against `api_usage`. */
  backgroundRefresh: boolean;

  /** Serve nearby search from the self-hosted Overture places index
   *  (/api/places-v2) instead of Google Places. Default false; flip on
   *  via FLAG_PLACES_V2_SEARCH=true once the region a deployment
   *  serves is loaded in open_places. Kill-switch back to Google is
   *  an env change + restart. */
  placesV2Search: boolean;

  /** Whether the client-side zod validation throws on contract drift.
   *  Default true; set false during a server change rollout so a brief
   *  contract gap doesn't lock users out (downgrade to a Sentry breadcrumb
   *  instead). */
  strictApiSchemaValidation: boolean;
}

/** Parse an env var as a boolean. `"true"` / `"1"` → true. Anything else
 *  (including unset) → fall back to the default. We never coerce "0"
 *  or "false" to true — explicit positive opt-in only. */
function envFlag(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return defaultValue;
}

// Read once at boot. Flags don't change at runtime — restart the server
// to pick up env-var changes. (This is the trade-off for not running a
// service: instant flip needs a redeploy.)
export const flags: FeatureFlags = {
  newDetailModal:            envFlag('FLAG_NEW_DETAIL_MODAL',           false),
  insightsOptOutVisible:     envFlag('FLAG_INSIGHTS_OPT_OUT_VISIBLE',   true),
  backgroundRefresh:         envFlag('FLAG_BACKGROUND_REFRESH',         false),
  strictApiSchemaValidation: envFlag('FLAG_STRICT_API_SCHEMA',          true),
  placesV2Search:            envFlag('FLAG_PLACES_V2_SEARCH',           false),
};
