// Tier-guard: field masks must never request a Google Places field
// from a SKU tier above ENTERPRISE.
//
// Why this test exists: a search/details call bills at the tier of its
// MOST EXPENSIVE requested field. In launch month, three innocuous-
// looking fields (takeout, delivery, servesVegetarianFood) silently
// bumped every search call to the Enterprise+Atmosphere SKU — the most
// expensive rate AND the smallest monthly free allowance (1K events vs
// 5K for Pro). The result was an untenable bill. Code comments claiming
// "Pro tier, no SKU bump" were wrong and nothing caught it.
//
// This test is the "nothing caught it" fix. If you add a field to any
// of these masks and this test fails, you are about to multiply the
// app's Google Places spend. Check the field's tier first:
// https://developers.google.com/maps/billing-and-pricing/sku-details
// If the product genuinely needs an Atmosphere field, take it to a
// deliberate cost review — don't just extend the allowlist below.

import { FIELD_MASK, TEXT_FIELD_MASK } from '../../routes/places';
import { DETAIL_FIELD_MASK } from '../../routes/users/refresh';

// Fields that trigger the Enterprise + Atmosphere SKU on Nearby
// Search / Text Search / Place Details (New). Hand-copied from
// Google's SKU table (link above) — update if Google re-tiers.
const ATMOSPHERE_TIER_FIELDS = [
  'allowsDogs', 'curbsidePickup', 'delivery', 'dineIn',
  'editorialSummary', 'evChargeAmenitySummary', 'evChargeOptions',
  'fuelOptions', 'generativeSummary', 'goodForChildren',
  'goodForGroups', 'goodForWatchingSports', 'liveMusic',
  'menuForChildren', 'neighborhoodSummary', 'parkingOptions',
  'paymentOptions', 'outdoorSeating', 'reservable', 'restroom',
  'reviews', 'reviewSummary', 'routingSummaries',
  'servesBeer', 'servesBreakfast', 'servesBrunch', 'servesCocktails',
  'servesCoffee', 'servesDessert', 'servesDinner', 'servesLunch',
  'servesVegetarianFood', 'servesWine', 'takeout',
];

// Split a mask string into bare field names. Search masks prefix each
// entry with "places." (e.g. "places.rating"); the Place Details mask
// uses bare names ("rating"). Normalize both to bare names.
function fieldsOf(mask: string): string[] {
  return mask.split(',').map((f) => f.trim().replace(/^places\./, ''));
}

describe.each([
  ['nearby-search FIELD_MASK',      FIELD_MASK],
  ['text-search TEXT_FIELD_MASK',   TEXT_FIELD_MASK],
  ['place-details DETAIL_FIELD_MASK', DETAIL_FIELD_MASK],
])('%s', (_label, mask) => {
  it('contains no Enterprise+Atmosphere-tier field', () => {
    const requested = fieldsOf(mask);
    const violations = requested.filter((f) => ATMOSPHERE_TIER_FIELDS.includes(f));
    // A non-empty list here means every call using this mask will bill
    // at the most expensive Places SKU. See the header comment before
    // "fixing" this test by editing the allowlist.
    expect(violations).toEqual([]);
  });

  it('is a well-formed comma-separated mask (no empty segments)', () => {
    // A trailing comma or double comma silently sends an empty field
    // segment; Google rejects the whole request with INVALID_ARGUMENT.
    for (const f of fieldsOf(mask)) {
      expect(f).not.toBe('');
      expect(f).toMatch(/^[A-Za-z.]+$/);
    }
  });
});
