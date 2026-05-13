// Normalize a possibly-bare URL into something safe to drop into an `<a href>`.
// Returns null when the input is missing or carries a scheme we don't want to
// render (anything non-http(s) — javascript:, data:, vbscript:, etc).
//
// Server-side restaurant create now rejects non-http(s) scheme strings at write
// time too, so post-rename the only place a hostile value could slip in is a
// legacy row written before that fix. The frontend belt-and-suspenders here
// means rendering stays safe even against legacy data.

const DEFAULT_SENTINEL = 'N/A';

export function normalizeUrl(raw) {
  if (!raw || raw === DEFAULT_SENTINEL) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // If it already has a scheme...
  if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) {
    // ...accept only http/https; otherwise refuse rather than try to scrub.
    return /^https?:\/\//i.test(trimmed) ? trimmed : null;
  }
  // Bare host like "thefatduck.co.uk" — default to https.
  return `https://${trimmed}`;
}
