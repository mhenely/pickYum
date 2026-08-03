import {
  isFoodCategory,
  isFoodPlace,
  cuisineLabel,
  transformOvertureFeature,
  haversineKm,
  bboxForRadius,
} from '../../lib/overture';

// Minimal valid Overture feature builder — tests override just the
// bits they exercise.
function feature(overrides: {
  id?: unknown;
  name?: unknown;
  primary?: unknown;
  alternate?: unknown;
  hierarchy?: unknown;
  coordinates?: unknown;
  geometryType?: string;
  confidence?: unknown;
  addresses?: unknown;
  phones?: unknown;
  websites?: unknown;
} = {}) {
  // `key in overrides` (not `??`) so a test can explicitly pass
  // `undefined` to simulate the field being ABSENT — `?? default`
  // would silently substitute the default and the "missing field"
  // branches would never actually be exercised.
  const has = (k: string) => k in overrides;
  return {
    // GERS id is at the FEATURE level per the real release shape —
    // matching this correctly is load-bearing (a properties-level id
    // assumption once nulled out an entire 99K-feature ingest).
    id: has('id') ? overrides.id : 'gers-abc123',
    geometry: {
      type: overrides.geometryType ?? 'Point',
      coordinates: has('coordinates') ? overrides.coordinates : [-122.68, 45.52],
    },
    properties: {
      names: { primary: has('name') ? overrides.name : 'Tasty Slice' },
      categories: { primary: has('primary') ? overrides.primary : 'pizza_restaurant', alternate: overrides.alternate },
      taxonomy: has('hierarchy') ? { hierarchy: overrides.hierarchy } : undefined,
      addresses: has('addresses')
        ? overrides.addresses
        : [{ freeform: '123 SE Main St', locality: 'Portland', region: 'OR', postcode: '97214' }],
      phones: overrides.phones,
      websites: overrides.websites,
      confidence: has('confidence') ? overrides.confidence : 0.9,
    },
  };
}

describe('isFoodCategory', () => {
  it('accepts any *_restaurant slug', () => {
    expect(isFoodCategory('italian_restaurant')).toBe(true);
    expect(isFoodCategory('fast_food_restaurant')).toBe(true);
  });

  it('accepts enumerated non-restaurant food categories', () => {
    expect(isFoodCategory('coffee_shop')).toBe(true);
    expect(isFoodCategory('bakery')).toBe(true);
    expect(isFoodCategory('wine_bar')).toBe(true);
    expect(isFoodCategory('food_truck')).toBe(true);
  });

  it('rejects non-food and food-retail categories', () => {
    // Grocery/wholesale sell food but aren't dining destinations —
    // same product line the Google deny-list draws.
    expect(isFoodCategory('supermarket')).toBe(false);
    expect(isFoodCategory('grocery_store')).toBe(false);
    expect(isFoodCategory('hair_salon')).toBe(false);
    expect(isFoodCategory(null)).toBe(false);
    expect(isFoodCategory(undefined)).toBe(false);
  });
});

describe('isFoodPlace (taxonomy-first gate)', () => {
  it('accepts any hierarchy rooted at food_and_drink — even slugs the exact list misses', () => {
    // 'winery' isn't in FOOD_EXACT; the taxonomy root decides.
    expect(isFoodPlace(['food_and_drink', 'alcoholic_beverage_venue', 'winery'], 'winery')).toBe(true);
  });

  it('rejects food RETAIL, which roots at shopping (real release shape)', () => {
    // Real hierarchy from the 2026-07 release: supermarkets root at
    // 'shopping', not 'food_and_drink' — the root draws the dining line.
    expect(isFoodPlace(['shopping', 'food_and_beverage_store', 'grocery_store'], 'grocery_store')).toBe(false);
  });

  it('falls back to the slug predicate when taxonomy is absent', () => {
    expect(isFoodPlace(null, 'pizza_restaurant')).toBe(true);
    expect(isFoodPlace(undefined, 'hair_salon')).toBe(false);
    expect(isFoodPlace([], 'cafe')).toBe(true);
  });
});

describe('cuisineLabel', () => {
  it('title-cases taxonomy slugs', () => {
    expect(cuisineLabel('italian_restaurant')).toBe('Italian Restaurant');
    expect(cuisineLabel('coffee_shop')).toBe('Coffee Shop');
  });

  it('returns null for missing input', () => {
    expect(cuisineLabel(null)).toBeNull();
    expect(cuisineLabel(undefined)).toBeNull();
  });
});

describe('transformOvertureFeature', () => {
  it('maps a valid food feature to a row', () => {
    const row = transformOvertureFeature(feature({
      phones: ['+15035551234'],
      websites: ['https://tastyslice.example.com'],
      alternate: ['restaurant'],
    }));
    expect(row).toMatchObject({
      source: 'overture',
      sourceId: 'gers-abc123',
      name: 'Tasty Slice',
      categoryPrimary: 'pizza_restaurant',
      categories: ['restaurant'],
      lat: 45.52,
      lng: -122.68,
      address: '123 SE Main St',
      locality: 'Portland',
      region: 'OR',
      postcode: '97214',
      phone: '+15035551234',
      website: 'https://tastyslice.example.com',
      confidence: 0.9,
    });
  });

  it('returns null for non-food categories', () => {
    expect(transformOvertureFeature(feature({ primary: 'car_repair' }))).toBeNull();
  });

  it('returns null when name or id is missing', () => {
    expect(transformOvertureFeature(feature({ name: '' }))).toBeNull();
    expect(transformOvertureFeature(feature({ id: undefined, name: 'Named' }))).toBeNull();
  });

  it('returns null for missing or non-Point geometry', () => {
    expect(transformOvertureFeature(feature({ geometryType: 'Polygon' }))).toBeNull();
    expect(transformOvertureFeature(feature({ coordinates: 'not-an-array' }))).toBeNull();
  });

  it('returns null for out-of-range coordinates', () => {
    expect(transformOvertureFeature(feature({ coordinates: [-200, 45] }))).toBeNull();
    expect(transformOvertureFeature(feature({ coordinates: [-122, 95] }))).toBeNull();
  });

  it('tolerates absent optional fields (address, phone, website, confidence)', () => {
    const row = transformOvertureFeature(feature({
      addresses: [],
      confidence: undefined,
    }));
    expect(row).toMatchObject({
      name: 'Tasty Slice',
      address: null,
      phone: null,
      website: null,
      confidence: null,
    });
  });

  it('survives garbage input without throwing', () => {
    expect(transformOvertureFeature(null)).toBeNull();
    expect(transformOvertureFeature(42)).toBeNull();
    expect(transformOvertureFeature({})).toBeNull();
    expect(transformOvertureFeature({ properties: { id: 7 } })).toBeNull();
  });

  it('strips NUL bytes from every string field (Postgres rejects them)', () => {
    // Real-world lesson: \u0000 is legal JSON but Postgres TEXT rejects
    // it, and one poisoned row killed the NYC/LA/Chicago ingests
    // wholesale. Every string reaching the DB must pass the sanitizer.
    const row = transformOvertureFeature(feature({
      name: 'Tasty\u0000 Slice',
      addresses: [{ freeform: '123\u0000 SE Main St', locality: 'Port\u0000land' }],
      phones: ['+1503\u00005551234'],
    }));
    expect(row).toMatchObject({
      name: 'Tasty Slice',
      address: '123 SE Main St',
      locality: 'Portland',
      phone: '+15035551234',
    });
  });
});

describe('haversineKm', () => {
  it('computes known distance (Portland → Seattle ≈ 233 km)', () => {
    const d = haversineKm(45.5152, -122.6784, 47.6062, -122.3321);
    expect(d).toBeGreaterThan(225);
    expect(d).toBeLessThan(245);
  });

  it('is zero for identical points', () => {
    expect(haversineKm(45.5, -122.6, 45.5, -122.6)).toBe(0);
  });
});

describe('bboxForRadius', () => {
  it('contains the radius circle (5 mi at Portland latitude)', () => {
    const box = bboxForRadius(45.52, -122.68, 8047);
    // Any point exactly radius meters due N/S/E/W must be inside.
    expect(box.maxLat - 45.52).toBeGreaterThanOrEqual(8047 / 111_320);
    expect(45.52 - box.minLat).toBeGreaterThanOrEqual(8047 / 111_320);
    // Longitude span must be wider than latitude span at 45°N —
    // meridians converge, so a degree of longitude is shorter.
    expect(box.maxLng - box.minLng).toBeGreaterThan(box.maxLat - box.minLat);
  });

  it('clamps to valid coordinate ranges near the poles/antimeridian', () => {
    const box = bboxForRadius(89.9, 179.9, 50_000);
    expect(box.maxLat).toBeLessThanOrEqual(90);
    expect(box.maxLng).toBeLessThanOrEqual(180);
  });
});
