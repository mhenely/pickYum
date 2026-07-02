import {
  parseDietaryParam,
  filterableSubset,
  dietaryKeyFragment,
  infoOnlyTags,
  placeSatisfiesDietary,
  applyDietaryFilter,
  FILTERABLE_TAGS,
} from '../../lib/dietaryFilters';

// NOTE on the current contract: FILTERABLE_TAGS is EMPTY as of the
// Enterprise+Atmosphere cost fix — `servesVegetarianFood` was dropped
// from the Places field masks (it bumped every search call to the most
// expensive SKU), so no dietary tag can be hard-filtered server-side.
// Every known tag is informational-only. These tests pin that
// behavior: if a tag is ever re-added to FILTERABLE_TAGS (e.g. from a
// non-Google data source), the sections below marked "reactivation"
// document what needs re-testing.

describe('parseDietaryParam', () => {
  it('returns empty list for missing input', () => {
    expect(parseDietaryParam(undefined)).toEqual([]);
    expect(parseDietaryParam('')).toEqual([]);
    expect(parseDietaryParam(null)).toEqual([]);
  });

  it('parses a comma-separated list', () => {
    expect(parseDietaryParam('vegetarian,vegan')).toEqual(['vegetarian', 'vegan']);
  });

  it('lowercases + trims + dedupes', () => {
    expect(parseDietaryParam(' Vegetarian , vegan ,vegetarian')).toEqual(['vegetarian', 'vegan']);
  });

  it('ignores non-string inputs', () => {
    expect(parseDietaryParam(42)).toEqual([]);
    expect(parseDietaryParam(['vegetarian'])).toEqual([]);
  });
});

describe('FILTERABLE_TAGS (cost-fix contract)', () => {
  it('is empty — no dietary tag hard-filters server-side', () => {
    // If this fails because a tag was re-added: confirm the data source
    // powering the filter does NOT come from an Enterprise+Atmosphere
    // Places field (see the tier-guard test + TEXT_FIELD_MASK warning
    // in routes/places.ts), then update the reactivation cases below.
    expect(FILTERABLE_TAGS.size).toBe(0);
  });
});

describe('filterableSubset', () => {
  it('returns empty for every tag — nothing is filterable today', () => {
    expect(filterableSubset(['vegetarian', 'gluten-free', 'vegan', 'nut-allergy'])).toEqual([]);
    expect(filterableSubset(['gluten-free', 'kosher', 'halal'])).toEqual([]);
  });
});

describe('infoOnlyTags', () => {
  it('surfaces every known tag as informational (including vegetarian/vegan)', () => {
    // Reactivation note: pre-cost-fix, vegetarian/vegan were excluded
    // from this list because they hard-filtered. Now they're
    // informational like everything else — the UI shows "we can't
    // filter for this; check the menu" instead of silently dropping
    // every result (which is what an active filter with no data field
    // would do).
    expect(infoOnlyTags(['vegetarian', 'gluten-free', 'nut-allergy']))
      .toEqual(['vegetarian', 'gluten-free', 'nut-allergy']);
  });

  it('drops completely unknown tags from the info list', () => {
    expect(infoOnlyTags(['made-up-tag'])).toEqual([]);
    expect(infoOnlyTags(['vegetarian', 'made-up-tag'])).toEqual(['vegetarian']);
  });
});

describe('dietaryKeyFragment', () => {
  it('is always empty — no filterable tags means no cache-key split', () => {
    // Cache entries stay shared across users regardless of dietary
    // prefs, which is exactly what we want for spend.
    expect(dietaryKeyFragment([])).toBe('');
    expect(dietaryKeyFragment(['gluten-free'])).toBe('');
    expect(dietaryKeyFragment(['vegan', 'vegetarian'])).toBe('');
  });
});

describe('placeSatisfiesDietary', () => {
  const veggieOk = { servesVegetarianFood: true  };
  const veggieNo = { servesVegetarianFood: false };
  const noField  = {};

  it('lets everything through — all tags are informational now', () => {
    // THE regression this suite must catch: with servesVegetarianFood
    // absent from API responses, a still-active vegetarian hard-filter
    // would drop EVERY place (missing data = conservative fail) and
    // the search would silently return zero results. The predicate
    // must treat vegetarian/vegan as info-only pass-throughs.
    expect(placeSatisfiesDietary(veggieNo, [])).toBe(true);
    expect(placeSatisfiesDietary(veggieNo, ['gluten-free'])).toBe(true);
    expect(placeSatisfiesDietary(veggieNo, ['vegetarian'])).toBe(true);
    expect(placeSatisfiesDietary(noField,  ['vegetarian'])).toBe(true);
    expect(placeSatisfiesDietary(noField,  ['vegan'])).toBe(true);
    expect(placeSatisfiesDietary(veggieOk, ['vegan'])).toBe(true);
  });
});

describe('applyDietaryFilter', () => {
  const places = [
    { name: 'Veggie Town',   servesVegetarianFood: true  },
    { name: 'Meat Palace',   servesVegetarianFood: false },
    { name: 'Mystery Diner', servesVegetarianFood: null  },
    { name: 'Post-Fix Cafe' }, // fresh rows no longer carry the field at all
  ];

  it('returns input as-is (same array reference) for any tag mix', () => {
    // Hot-path contract: with no filterable tags, the filter must
    // short-circuit and never allocate — every request takes this path.
    expect(applyDietaryFilter(places, [])).toBe(places);
    expect(applyDietaryFilter(places, ['gluten-free'])).toBe(places);
    expect(applyDietaryFilter(places, ['vegetarian'])).toBe(places);
    expect(applyDietaryFilter(places, ['vegetarian', 'vegan', 'kosher'])).toBe(places);
  });
});
