import {
  parseDietaryParam,
  filterableSubset,
  dietaryKeyFragment,
  infoOnlyTags,
  placeSatisfiesDietary,
  applyDietaryFilter,
} from '../../lib/dietaryFilters';

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

describe('filterableSubset', () => {
  it('keeps only tags we actually filter on', () => {
    expect(filterableSubset(['vegetarian', 'gluten-free', 'vegan', 'nut-allergy'])).toEqual(['vegan', 'vegetarian']);
  });

  it('returns empty when no filterable tags present', () => {
    expect(filterableSubset(['gluten-free', 'kosher', 'halal'])).toEqual([]);
  });
});

describe('infoOnlyTags', () => {
  it('returns the known-but-unfilterable tags from the input', () => {
    // Vegetarian/vegan are filterable; gluten-free and nut-allergy
    // are known dietary tags but not filterable server-side.
    expect(infoOnlyTags(['vegetarian', 'gluten-free', 'nut-allergy'])).toEqual(['gluten-free', 'nut-allergy']);
  });

  it('drops completely unknown tags from the info list', () => {
    // The "informational" surface only shows tags we recognize but
    // can't filter on. A tag we don't recognize at all is just dropped.
    expect(infoOnlyTags(['vegetarian', 'made-up-tag'])).toEqual([]);
  });
});

describe('dietaryKeyFragment', () => {
  it('returns an empty string when no filterable tags', () => {
    expect(dietaryKeyFragment([])).toBe('');
    expect(dietaryKeyFragment(['gluten-free'])).toBe('');
  });

  it('returns a stable sorted suffix when filterable tags are present', () => {
    expect(dietaryKeyFragment(['vegan', 'vegetarian'])).toBe('::diet=vegan+vegetarian');
    expect(dietaryKeyFragment(['vegetarian', 'vegan'])).toBe('::diet=vegan+vegetarian');
  });
});

describe('placeSatisfiesDietary', () => {
  const veggieOk    = { servesVegetarianFood: true  };
  const veggieNo    = { servesVegetarianFood: false };
  const veggieUnknown = { servesVegetarianFood: null };
  const noField     = {};

  it('lets everything through when no filterable tags requested', () => {
    expect(placeSatisfiesDietary(veggieNo, [])).toBe(true);
    expect(placeSatisfiesDietary(veggieNo, ['gluten-free'])).toBe(true);
  });

  it('requires explicit servesVegetarianFood=true for vegetarian filter', () => {
    expect(placeSatisfiesDietary(veggieOk,      ['vegetarian'])).toBe(true);
    expect(placeSatisfiesDietary(veggieNo,      ['vegetarian'])).toBe(false);
    expect(placeSatisfiesDietary(veggieUnknown, ['vegetarian'])).toBe(false);
    expect(placeSatisfiesDietary(noField,       ['vegetarian'])).toBe(false);
  });

  it('treats vegan as vegetarian-equivalent (Google has no vegan field)', () => {
    expect(placeSatisfiesDietary(veggieOk, ['vegan'])).toBe(true);
    expect(placeSatisfiesDietary(veggieNo, ['vegan'])).toBe(false);
  });
});

describe('applyDietaryFilter', () => {
  const places = [
    { name: 'Veggie Town',  servesVegetarianFood: true  },
    { name: 'Meat Palace',  servesVegetarianFood: false },
    { name: 'Mystery Diner', servesVegetarianFood: null },
  ];

  it('returns input as-is (same array) when no filterable tag is set', () => {
    // Hot-path optimization: unfiltered requests pay no extra cost.
    const result = applyDietaryFilter(places, []);
    expect(result).toBe(places);
  });

  it('returns input as-is when only info-only tags are requested', () => {
    const result = applyDietaryFilter(places, ['gluten-free']);
    expect(result).toBe(places);
  });

  it('drops places that fail the filter', () => {
    const result = applyDietaryFilter(places, ['vegetarian']);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Veggie Town');
  });
});
