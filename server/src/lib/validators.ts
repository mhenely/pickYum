// Numeric ID parser shared across route files.
//
// Why this exists: every route that takes `:id` (or `:restaurantId`,
// `:tripId`, etc.) needs the same shape of validation — coerce string
// to integer, reject non-positive / non-finite. Before consolidation,
// at least three identical implementations lived in trips.ts,
// restaurants.ts, and users.ts. A username-length or radius-cap
// change in this shape would have to be made N times.
//
// Use the return value to decide between 400 (route-level bad input,
// e.g. malformed URL param) and 404 (well-formed but row missing).
// The function itself doesn't draw that distinction — it just tells
// you the input shape was valid.
//
// Returns null on:
//   - non-finite (Number('abc') → NaN)
//   - non-integer (Number('1.5') → 1.5)
//   - non-positive (zero or negative)

export function parseNumericId(raw: string | undefined): number | null {
  if (raw == null) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}
