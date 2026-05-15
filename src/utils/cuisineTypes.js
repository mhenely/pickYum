// Google Places (New) primary types used to filter the nearby search at
// API level. When a user picks a cuisine from the SearchPage dropdown,
// we pass that `value` to /api/places/nearby — the server validates it
// against this same whitelist and issues a single searchNearby call
// with `includedTypes: [value]` instead of the default 3-slice fan-out
// across all food categories.
//
// Note: distinct from the existing client-side `cuisineFilter` in
// searchSlice, which post-filters the already-fetched results. This
// list drives the SEARCH-TIME filter; that one drives the
// REFINE-WITHIN-RESULTS filter. Both can be active simultaneously.
//
// Sorted by label so the dropdown reads alphabetically. Every entry
// here must also be in ALLOWED_CUISINE_TYPES on the server
// (places.ts) — keep the two in sync. The slug-style `value`
// matches Google's Place Types Table A exactly (no transformation
// needed before passing to the Places API).
export const CUISINE_OPTIONS = [
  { value: 'american_restaurant',       label: 'American' },
  { value: 'bakery',                    label: 'Bakery' },
  { value: 'bar',                       label: 'Bar' },
  { value: 'bar_and_grill',             label: 'Bar & Grill' },
  { value: 'barbecue_restaurant',       label: 'BBQ' },
  { value: 'breakfast_restaurant',      label: 'Breakfast' },
  { value: 'brunch_restaurant',         label: 'Brunch' },
  { value: 'buffet_restaurant',         label: 'Buffet' },
  { value: 'hamburger_restaurant',      label: 'Burgers' },
  { value: 'cafe',                      label: 'Café' },
  { value: 'chinese_restaurant',        label: 'Chinese' },
  { value: 'coffee_shop',               label: 'Coffee Shop' },
  { value: 'deli',                      label: 'Deli' },
  { value: 'dessert_restaurant',        label: 'Dessert' },
  { value: 'diner',                     label: 'Diner' },
  { value: 'fast_food_restaurant',      label: 'Fast Food' },
  { value: 'fine_dining_restaurant',    label: 'Fine Dining' },
  { value: 'french_restaurant',         label: 'French' },
  { value: 'greek_restaurant',          label: 'Greek' },
  { value: 'ice_cream_shop',            label: 'Ice Cream' },
  { value: 'indian_restaurant',         label: 'Indian' },
  { value: 'indonesian_restaurant',     label: 'Indonesian' },
  { value: 'italian_restaurant',        label: 'Italian' },
  { value: 'japanese_restaurant',       label: 'Japanese' },
  { value: 'korean_restaurant',         label: 'Korean' },
  { value: 'lebanese_restaurant',       label: 'Lebanese' },
  { value: 'mediterranean_restaurant',  label: 'Mediterranean' },
  { value: 'mexican_restaurant',        label: 'Mexican' },
  { value: 'middle_eastern_restaurant', label: 'Middle Eastern' },
  { value: 'pizza_restaurant',          label: 'Pizza' },
  { value: 'pub',                       label: 'Pub' },
  { value: 'ramen_restaurant',          label: 'Ramen' },
  { value: 'sandwich_shop',             label: 'Sandwich' },
  { value: 'seafood_restaurant',        label: 'Seafood' },
  { value: 'spanish_restaurant',        label: 'Spanish' },
  { value: 'steak_house',               label: 'Steakhouse' },
  { value: 'sushi_restaurant',          label: 'Sushi' },
  { value: 'thai_restaurant',           label: 'Thai' },
  { value: 'turkish_restaurant',        label: 'Turkish' },
  { value: 'vegan_restaurant',          label: 'Vegan' },
  { value: 'vegetarian_restaurant',     label: 'Vegetarian' },
  { value: 'vietnamese_restaurant',     label: 'Vietnamese' },
  { value: 'wine_bar',                  label: 'Wine Bar' },
];
