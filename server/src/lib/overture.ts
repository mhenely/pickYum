// Overture Maps ingestion + query helpers for the open-data places
// index (open_places table). Pure functions only — no I/O — so the
// ingest script and the nearby-v2 route share one tested core.
//
// Overture's place schema (theme=places, type=place) as emitted by the
// `overturemaps` CLI in GeoJSON form (verified against the 2026-07
// release — shapes drift between releases, check a real line before
// assuming):
//   feature.id                         → GERS id (TOP LEVEL, not in properties!)
//   feature.geometry.coordinates       → [lng, lat]
//   feature.properties.names.primary   → display name
//   feature.properties.categories.primary    → taxonomy slug
//   feature.properties.categories.alternate  → string[] | null extra slugs
//   feature.properties.taxonomy.hierarchy    → string[] root-first path,
//     e.g. ["food_and_drink","casual_eatery","bakery"]. Dining roots at
//     food_and_drink; grocery/supermarket root at "shopping" — so the
//     hierarchy root alone is a clean dining-vs-food-retail gate.
//   feature.properties.addresses[0]    → { freeform, locality, region, postcode }
//   feature.properties.phones[0] / websites[0]
//   feature.properties.confidence      → 0..1 existence confidence

// ── Food-category predicate ──────────────────────────────────────
//
// Overture's category taxonomy descends from Meta's places taxonomy,
// so most food slugs match Google's shape (`italian_restaurant`,
// `coffee_shop`). Anything ending in `_restaurant` is food; the rest
// of the dining long tail is enumerated. Grocery / convenience /
// wholesale are intentionally absent — same product decision as the
// Google deny-list in routes/places.ts (a supermarket sells food but
// isn't a dining destination).
const FOOD_EXACT = new Set([
  'restaurant', 'cafe', 'coffee_shop', 'tea_house', 'bubble_tea_shop',
  'bakery', 'patisserie', 'dessert_shop', 'ice_cream_shop', 'gelato_shop',
  'donut_shop', 'juice_bar', 'smoothie_shop', 'sandwich_shop', 'deli',
  'diner', 'bistro', 'brasserie', 'gastropub', 'food_truck', 'food_court',
  'bar', 'pub', 'wine_bar', 'cocktail_bar', 'sports_bar', 'beer_garden',
  'brewery', 'brewpub', 'cafeteria', 'buffet', 'creperie', 'noodle_house',
  'taqueria', 'pizzeria', 'steakhouse', 'sushi_bar', 'oyster_bar',
]);

export function isFoodCategory(primary: string | null | undefined): boolean {
  if (!primary) return false;
  return primary.endsWith('_restaurant') || FOOD_EXACT.has(primary);
}

// Preferred food gate: Overture's own taxonomy hierarchy. Dining
// places root at 'food_and_drink'; food RETAIL (grocery, supermarket)
// roots at 'shopping', so the root alone draws the dining line without
// us enumerating slugs. The slug predicate above stays as the fallback
// for features that ship without a taxonomy block.
export function isFoodPlace(
  hierarchy: readonly unknown[] | null | undefined,
  primary: string | null | undefined,
): boolean {
  if (Array.isArray(hierarchy) && hierarchy.length > 0) {
    return hierarchy[0] === 'food_and_drink';
  }
  return isFoodCategory(primary);
}

// Human label from a taxonomy slug: "italian_restaurant" → "Italian
// Restaurant". Mirrors what Google's primaryTypeDisplayName gives us
// on the v1 path so cards render the same cuisine text either way.
export function cuisineLabel(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return slug
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// ── Feature transform ────────────────────────────────────────────

export interface OpenPlaceRow {
  source: string;
  sourceId: string;
  name: string;
  categoryPrimary: string | null;
  categories: string[];
  lat: number;
  lng: number;
  address: string | null;
  locality: string | null;
  region: string | null;
  postcode: string | null;
  phone: string | null;
  website: string | null;
  confidence: number | null;
}

// Loosely-typed because the input is a third-party file the user
// downloaded — every field access is defensive. Returns null for
// anything that isn't an ingestible food place (wrong geometry,
// missing name/id, non-food category) so the ingest loop can just
// filter(Boolean).
export function transformOvertureFeature(feature: unknown): OpenPlaceRow | null {
  const f = feature as {
    id?: unknown;
    geometry?: { type?: string; coordinates?: unknown };
    properties?: {
      id?: unknown;
      names?: { primary?: unknown };
      categories?: { primary?: unknown; alternate?: unknown };
      taxonomy?: { hierarchy?: unknown };
      addresses?: Array<{ freeform?: unknown; locality?: unknown; region?: unknown; postcode?: unknown }>;
      phones?: unknown[];
      websites?: unknown[];
      confidence?: unknown;
    };
  } | null;

  const props = f?.properties;
  if (!props) return null;

  // GERS id lives at the FEATURE level in current releases; older
  // tooling put it in properties. Accept either — this exact mismatch
  // once made an ingest run silently reject all 99K features.
  const rawId = typeof f?.id === 'string' ? f.id : (typeof props.id === 'string' ? props.id : null);
  const name = typeof props.names?.primary === 'string' ? props.names.primary.trim() : '';
  if (!rawId || !name) return null;
  const sourceId = rawId;

  const coords = f?.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates)
    ? f.geometry.coordinates
    : null;
  const lng = typeof coords?.[0] === 'number' ? coords[0] : null;
  const lat = typeof coords?.[1] === 'number' ? coords[1] : null;
  if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const primary = typeof props.categories?.primary === 'string' ? props.categories.primary : null;
  const hierarchy = Array.isArray(props.taxonomy?.hierarchy) ? props.taxonomy?.hierarchy : null;
  if (!isFoodPlace(hierarchy, primary)) return null;

  const alternates = Array.isArray(props.categories?.alternate)
    ? (props.categories?.alternate as unknown[]).filter((c): c is string => typeof c === 'string').slice(0, 10)
    : [];

  const addr = Array.isArray(props.addresses) ? props.addresses[0] : undefined;
  const str = (v: unknown, max: number): string | null =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

  return {
    source: 'overture',
    sourceId: sourceId.slice(0, 64),
    name: name.slice(0, 200),
    categoryPrimary: primary,
    categories: alternates,
    lat, lng,
    address: str(addr?.freeform, 300),
    locality: str(addr?.locality, 100),
    region: str(addr?.region, 50),
    postcode: str(addr?.postcode, 20),
    phone: str(props.phones?.[0], 40),
    website: str(props.websites?.[0], 500),
    confidence: typeof props.confidence === 'number' ? props.confidence : null,
  };
}

// ── Geo math ─────────────────────────────────────────────────────

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Bounding box that fully contains a radius circle — the SQL
// prefilter (lat/lng BETWEEN) that lets the composite index do the
// heavy lifting before the exact haversine pass in JS. The longitude
// span widens with latitude (meridians converge); cos() handles it.
// Clamped at high latitudes where the box would exceed the valid
// range — fine for a restaurant app, nobody is searching at 89°N.
export function bboxForRadius(lat: number, lng: number, radiusMeters: number): {
  minLat: number; maxLat: number; minLng: number; maxLng: number;
} {
  const latDelta = radiusMeters / 111_320; // meters per degree latitude
  const lngDelta = radiusMeters / (111_320 * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
  return {
    minLat: Math.max(-90, lat - latDelta),
    maxLat: Math.min(90, lat + latDelta),
    minLng: Math.max(-180, lng - lngDelta),
    maxLng: Math.min(180, lng + lngDelta),
  };
}
