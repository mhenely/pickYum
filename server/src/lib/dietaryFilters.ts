// Dietary-aware filtering for nearby + text-search results. Promotes
// the previously-descriptive `user.dietaryTags` to an active search
// filter so a vegan user's random pick doesn't keep landing on
// steakhouses. Shared between routes/places.ts and the cache key so
// the same query with different dietary filters never poisons the
// unfiltered cache.
//
// Approach:
//   - For tags Google's Places API exposes as a structured field
//     (today: vegetarian via `servesVegetarianFood`), apply a hard
//     filter — drop places that don't satisfy the constraint.
//   - For tags Google doesn't expose (allergies, halal, kosher,
//     gluten-free, etc.), the tag is "informational" — surfaced in
//     the UI so the user knows we don't filter for it, but no
//     server-side dropping. The user has to check the menu.
//
// Both behaviors are encoded here so adding a new filterable tag is a
// one-liner addition to FILTERABLE_TAGS — the cache key, route, and
// response shape auto-pick it up. Cuisine pre-filtering stays in the
// nearby fan-out (cuisineType param) since it predates this layer
// and uses a different Google API contract (includedTypes).

// ── Tag taxonomy ─────────────────────────────────────────────────

// Mirrors the RECOMMENDED_TAGS list shown to users in UserInfoPage.
// Free-form tags (anything the user types) still get persisted, just
// not honored by any of the filters here — they pass through with
// the "informational" treatment.
export const KNOWN_DIETARY_TAGS = [
  'vegetarian',
  'vegan',
  'gluten-free',
  'halal',
  'kosher',
  'dairy-free',
  'nut-allergy',
  'shellfish-allergy',
  'pescatarian',
] as const;

export type DietaryTag = typeof KNOWN_DIETARY_TAGS[number];

// Subset that translates to an actual server-side filter.
//
// EMPTY as of the Enterprise+Atmosphere cost fix: vegetarian/vegan
// previously hard-filtered on Google's `servesVegetarianFood` field,
// but requesting that field bumped every search call to the
// Enterprise+Atmosphere SKU (the most expensive tier — see the
// TEXT_FIELD_MASK warning in routes/places.ts). The field was dropped
// from the masks, so the data no longer arrives and every dietary tag
// is informational-only. CRITICAL: with the field absent, leaving
// vegetarian/vegan in this set would make the filter drop EVERY place
// (the predicate treats missing data as "doesn't satisfy") — an
// enabled vegetarian filter would silently return zero results.
//
// If a cheap vegetarian signal ever becomes available (own data,
// user-contributed tags, a lower-tier Google field), re-add the tag
// here and the cache key / route / response shape pick it up again.
export const FILTERABLE_TAGS: ReadonlySet<DietaryTag> = new Set<DietaryTag>([]);

// Tags surfaced as "we don't filter for this" in the response. The
// client renders them as a small sidebar note so the user knows the
// dietary tag is informational rather than acting silently.
export function infoOnlyTags(requested: readonly string[]): string[] {
  return requested.filter((t) =>
    (KNOWN_DIETARY_TAGS as readonly string[]).includes(t) && !FILTERABLE_TAGS.has(t as DietaryTag),
  );
}

// ── Input parsing ────────────────────────────────────────────────

/**
 * Normalize a `?dietary=` query-param value into a deduplicated,
 * lowercased list. Accepts comma-separated form (`?dietary=vegetarian,vegan`)
 * because URLs and we don't expect more than ~3 tags per search.
 * Returns an empty list for missing / empty input — callers can use
 * `.length` to detect "no dietary filter requested."
 */
export function parseDietaryParam(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const parts = raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  return [...new Set(parts)];
}

/**
 * Subset of the parsed dietary list that we can actually act on
 * server-side. The cache key uses this (not the raw list) so two
 * requests that differ only in their info-only tags share the cache.
 */
export function filterableSubset(dietary: readonly string[]): string[] {
  return dietary.filter((t) => FILTERABLE_TAGS.has(t as DietaryTag)).sort();
}

// ── Cache-key fragment ───────────────────────────────────────────

/**
 * Stable string fragment for the cache key. Empty when no filterable
 * dietary tags are requested — keeps unfiltered cache entries shared
 * with the previous (pre-Phase-E) cache shape.
 */
export function dietaryKeyFragment(dietary: readonly string[]): string {
  const filterable = filterableSubset(dietary);
  return filterable.length === 0 ? '' : `::diet=${filterable.join('+')}`;
}

// ── Place predicate ──────────────────────────────────────────────

// Subset of fields we care about. Defined inline rather than importing
// a Place type to keep this module dependency-free + easy to mock in
// tests.
export interface PlaceLike {
  servesVegetarianFood?: boolean | null;
  // Future filterable fields land here as they're added.
}

/**
 * Returns true when the place satisfies all filterable dietary
 * constraints. Info-only tags are ignored — they don't change the
 * predicate. Conservative on missing data: when a Google field is
 * `null` / `undefined` (Google didn't tell us either way), we treat
 * it as "doesn't satisfy." Otherwise an opt-in vegetarian filter
 * would leak through every place that just happens to lack metadata.
 *
 * Tradeoff: this drops some places that ARE vegetarian-friendly but
 * Google never tagged. Acceptable for an opt-in hard filter — the
 * user can disable it if results are too sparse, and inclusion of
 * false positives would defeat the whole purpose ("vegan user lands
 * on a steakhouse").
 */
export function placeSatisfiesDietary(
  place: PlaceLike,
  dietary: readonly string[],
): boolean {
  const filterable = filterableSubset(dietary);
  if (filterable.length === 0) return true;

  // Vegetarian (and vegan-as-proxy): require explicit true from Google.
  if (filterable.includes('vegetarian') || filterable.includes('vegan')) {
    if (place.servesVegetarianFood !== true) return false;
  }

  return true;
}

/**
 * Bulk variant of `placeSatisfiesDietary` — apply the filter to an
 * entire restaurant list. Short-circuits when no filterable dietary
 * tags are requested so the unfiltered hot path doesn't pay an array
 * walk it doesn't need.
 */
export function applyDietaryFilter<T extends PlaceLike>(
  places: readonly T[],
  dietary: readonly string[],
): T[] {
  if (filterableSubset(dietary).length === 0) return places as T[];
  return places.filter((p) => placeSatisfiesDietary(p, dietary));
}
