// Build a Google Maps deep-link to a restaurant's place page. We use this
// in place of fetching `places.reviews` from the Places API — the
// reviews field bumps the call to Enterprise-tier pricing, but linking
// out to Maps shows users the same reviews (plus photos, hours,
// directions, etc.) on Google's own surface for free.
//
// Prefer `googlePlaceId` when available — it deep-links to the canonical
// listing for the place. Fall back to a name+address text search for
// custom user-typed entries that have no Google reference.
//
// Returns null when neither path can produce a meaningful link (no
// placeId AND no name) so callers can omit the button entirely.
export function googleMapsUrl(restaurant) {
  if (!restaurant) return null;
  // `place_id:` form is Google's canonical deep-link. Maps resolves it
  // server-side to the place's permanent listing — same content as a
  // user clicking the place from a search result.
  if (restaurant.googlePlaceId) {
    return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(restaurant.googlePlaceId)}`;
  }
  // Custom (non-Places) row — best we can do is a Maps text search with
  // the name and address. Address is appended when present so a common
  // restaurant name like "Pizza Hut" doesn't pin a random nearest
  // location for the viewer.
  const name = restaurant.name?.trim();
  if (!name) return null;
  const parts = [name, restaurant.address?.trim()].filter(Boolean);
  const query = encodeURIComponent(parts.join(' '));
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}
