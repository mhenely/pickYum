// Match-detection helpers used by the SearchPage after a nearby
// search returns. Scans the user's CUSTOM restaurants (rows with no
// googlePlaceId — i.e. typed manually before they had a Google
// match) against the search results and reports any that fuzzy-
// match by name, so the user can be prompted to merge their custom
// row into the canonical Google Place.
//
// Custom rows that the user has opted out of matching
// (`excludeFromPlaceMatching === true`) are skipped — that's the
// "stop asking about my 'Cooking at home' entry" escape hatch.
//
// Matching is intentionally conservative — we'd rather miss a true
// match than surface a false one, since false positives invite the
// user to overwrite their custom data with the wrong place.

// Words that don't help discriminate restaurants. Stripped during
// normalization so "The Pizza Place" and "Pizza Place" match. Doesn't
// include cuisine names — those usually ARE discriminating.
const STOP_WORDS = new Set([
  'the', 'a', 'an',
  'restaurant', 'cafe', 'café', 'bar', 'grill', 'kitchen',
  'place', 'house',
  'and', '&',
]);

// Normalize a restaurant name for comparison:
//   - lowercase
//   - strip apostrophes / quotes (so "Joe's" matches "Joes")
//   - non-alphanumeric → spaces (drops punctuation, ampersands, etc.)
//   - drop stop words
//   - collapse whitespace
// Returns '' for empty/null input.
export function normalizeName(s) {
  if (!s || typeof s !== 'string') return '';
  return s.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .join(' ')
    .trim();
}

// Levenshtein distance — edit distance between two strings.
// O(m × n) time, O(min(m, n)) space via two-row alternation.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  // Make `a` the shorter string to bound space at O(min).
  if (a.length > b.length) { const t = a; a = b; b = t; }
  let prev = new Array(a.length + 1);
  let curr = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;
  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= a.length; i++) {
      curr[i] = a[i - 1] === b[j - 1]
        ? prev[i - 1]
        : Math.min(prev[i - 1], prev[i], curr[i - 1]) + 1;
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[a.length];
}

// Similarity ratio in [0, 1] — 1 = identical, 0 = completely different.
// `(longer - distance) / longer` is the conventional formulation; it
// punishes length disparity, which is desirable here ("Pizza" vs
// "Pizza Place Of Chicago" shouldn't be a strong match).
export function nameSimilarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const longer = a.length >= b.length ? a : b;
  if (longer.length === 0) return 1;
  return (longer.length - levenshtein(a, b)) / longer.length;
}

// Optional helper: address similarity. Used as a tiebreaker when
// two custom rows have similar names — the one whose address tokens
// overlap with the Place result wins. Cheap word-overlap ratio, not
// a full string-distance.
export function addressOverlap(a, b) {
  if (!a || !b) return 0;
  const toks = (s) => new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  );
  const A = toks(a), B = toks(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

// Threshold tuned conservatively. 0.80 means a small (~20%) edit
// distance after normalization is allowed — covers typos, plural
// vs singular, abbreviated chain names — but rejects "Pizza" vs
// "Pizzeria" (0.625 — too far). Bump down if recall is more
// important than precision.
const DEFAULT_THRESHOLD = 0.80;

/**
 * Find which custom restaurants in `customRestaurants` look like
 * matches for the search results in `places`.
 *
 * @param {Record<string, { name: string; googlePlaceId: string | null;
 *                          excludeFromPlaceMatching?: boolean;
 *                          address?: string | null }>} customRestaurants
 *   The Redux customRestaurants dict (id → row).
 * @param {Array<{ googlePlaceId: string; name: string;
 *                 address?: string | null }>} places
 *   Search results from /api/places/nearby or /api/places/text-search.
 * @param {number} [threshold=0.80] Minimum name similarity for a match.
 * @returns {Array<{ customId: string; customName: string; place: object;
 *                   similarity: number; addressBoost: number }>}
 *   Sorted descending by combined score (name similarity + small
 *   address-overlap bonus). Empty array when no matches found.
 */
export function findCustomMatches(customRestaurants, places, threshold = DEFAULT_THRESHOLD) {
  if (!customRestaurants || !Array.isArray(places) || places.length === 0) return [];

  // Pre-normalize customs once — these are O(N) and we'd recompute
  // for every place inside the loop otherwise.
  const customEntries = [];
  for (const [id, r] of Object.entries(customRestaurants)) {
    if (!r || r.googlePlaceId || r.excludeFromPlaceMatching) continue;
    const norm = normalizeName(r.name);
    if (!norm) continue;
    customEntries.push({ id, name: r.name, norm, address: r.address ?? null });
  }
  if (customEntries.length === 0) return [];

  const matches = [];
  for (const place of places) {
    if (!place?.googlePlaceId) continue;
    const placeNorm = normalizeName(place.name);
    if (!placeNorm) continue;
    for (const custom of customEntries) {
      const sim = nameSimilarity(custom.norm, placeNorm);
      if (sim < threshold) continue;
      const addressBoost = addressOverlap(custom.address, place.address);
      matches.push({
        customId: custom.id,
        customName: custom.name,
        place,
        similarity: sim,
        addressBoost,
      });
    }
  }

  // Sort by combined score (name similarity weighted heavier than
  // address overlap, since address may be missing). One custom row
  // can match multiple places and vice-versa — caller is free to
  // dedupe further if desired.
  matches.sort((a, b) =>
    (b.similarity + 0.15 * b.addressBoost) - (a.similarity + 0.15 * a.addressBoost),
  );
  return matches;
}
