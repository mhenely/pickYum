import { z } from 'zod';

// API response schemas. The TS interfaces in api.ts are derived from
// these via `z.infer<typeof Schema>` so the two can't drift — change a
// schema, change every consumer that uses the inferred type.
//
// Why this exists (TIER_2_3_PLAN.md #9): the client previously trusted
// whatever the server sent and coerced defensively (`Boolean(x)`,
// `x ?? null`, `Array.isArray(x) ? x : []`). A server contract change
// surfaced as a downstream `Cannot read property of undefined` instead
// of a localized parse error.
//
// With zod, every endpoint reads through `requestParsed(schema)`:
//   - Right shape → typed result, business as usual.
//   - Wrong shape → ZodError thrown with the exact field path. Sentry
//     captures it; an error toast surfaces.
//
// Rollout strategy: schemas live next to their interfaces; new endpoints
// use `requestParsed` from day one; existing endpoints migrate
// opportunistically. Strictness is intentional — `.strict()` would
// reject extra fields and break the additive-shape-change contract, so
// we don't use it. Missing required fields and wrong types still throw.

// ─── Reusable atoms ───────────────────────────────────────────

// Stringly-typed dates (ISO timestamps) — Prisma serializes Dates as
// strings over JSON. We don't z.coerce.date() because consumers do
// their own formatting and want the raw string.
const ISODateString = z.string();

// ─── Restaurant ────────────────────────────────────────────────

export const PlacesPhotoSchema = z.object({
  name: z.string(),
  widthPx: z.number().nullable().optional(),
  heightPx: z.number().nullable().optional(),
  authorAttributions: z.array(z.unknown()).optional(),
}).passthrough();

export const RegularOpeningHoursSchema = z.object({
  openNow: z.boolean().optional(),
  periods: z.array(z.unknown()).optional(),
  weekdayDescriptions: z.array(z.string()).optional(),
}).passthrough().nullable();

export const ApiRestaurantSchema = z.object({
  id: z.number(),
  googlePlaceId: z.string().nullable(),
  name: z.string(),
  cuisineType: z.string().nullable(),
  priceLevel: z.number().nullable(),
  hours: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  // yelpUrl was originally part of the contract but the server stopped
  // selecting it once no UI surface consumed it (see RESTAURANT_CARD_SELECT
  // in server/src/routes/users.ts — there's a comment to this effect).
  // Schema makes it optional + nullable so a future server that brings it
  // back doesn't fail-shape, and the current server's omission stops
  // tripping a parse error. ApiRestaurant in api.ts has the same gap.
  yelpUrl: z.string().nullable().optional(),
  takeout: z.boolean(),
  delivery: z.boolean(),
  googleRating: z.string().nullable(),
  ratingCount: z.number().nullable(),
  address: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  photos: z.array(PlacesPhotoSchema).nullable(),
  regularOpeningHours: RegularOpeningHoursSchema,
  // Recently-added fields — `.optional()` because pre-rollout servers
  // omit them. New shape changes go to the END of the schema like this
  // so they're forward-compatible from the moment they ship.
  excludeFromPlaceMatching: z.boolean().optional(),
  googleDataUpdatedAt: ISODateString.nullable().optional(),
}).passthrough();

// ─── Auth ──────────────────────────────────────────────────────

export const AuthUserSchema = z.object({
  id: z.number(),
  email: z.string(),
  username: z.string(),
  flipCount: z.number().optional(),
  avatarUrl: z.string().nullable().optional(),
});

// ─── /me/identity (the new fast path) ─────────────────────────

export const MeIdentitySchema = z.object({
  apiVersion: z.number(),
  user: z.object({
    id: z.number(),
    email: z.string(),
    username: z.string(),
    flipCount: z.number(),
    avatarUrl: z.string().nullable(),
    role: z.string(),
    emailVerified: z.boolean(),
  }),
  defaultListId: z.number().nullable(),
  favoriteIds: z.array(z.number()),
});

// ─── Accepted ──────────────────────────────────────────────────

export const ApiAcceptedSchema = z.object({
  id: z.number(),
  restaurantId: z.number(),
  acceptedAt: ISODateString,
  excludeFromInsights: z.boolean(),
  restaurant: ApiRestaurantSchema,
});

export const ApiAcceptedEntrySchema = z.object({
  id: z.number(),
  restaurantId: z.number(),
  acceptedAt: ISODateString,
  excludeFromInsights: z.boolean(),
});

// PATCH /me/accepted/:id response.
export const SetAcceptedExcludeResponseSchema = z.object({
  accepted: ApiAcceptedSchema,
});

// ─── Favorite lists ────────────────────────────────────────────

export const ApiFavoriteListEntrySchema = z.object({
  restaurantId: z.number(),
  note: z.string().nullable(),
  addedAt: ISODateString,
});

export const ApiFavoriteListSchema = z.object({
  id: z.number(),
  // userId / groupId aren't in the response — server's `serializeList`
  // omits them deliberately (the client already knows whose list it is
  // from the request context). The TS interface in api.ts still names
  // them; both got fixed together to make the schema match reality.
  userId: z.number().nullable().optional(),
  groupId: z.number().nullable().optional(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  isDefault: z.boolean(),
  position: z.number(),
  createdAt: ISODateString,
  entries: z.array(ApiFavoriteListEntrySchema),
});

// ─── /me/data (the heavier extended payload) ──────────────────

export const ApiReviewSchema = z.object({
  id: z.number(),
  content: z.string().nullable(),
  rating: z.union([z.string(), z.number()]), // server sends Decimal as string
  restaurantId: z.number(),
  createdAt: ISODateString,
});

export const SavedAddressSchema = z.object({
  id: z.number(),
  label: z.string(),
  address: z.string(),
  isDefault: z.boolean(),
  createdAt: ISODateString,
});

export const MeDataSchema = z.object({
  apiVersion: z.number(),
  restaurants:     z.array(ApiRestaurantSchema),
  favoriteIds:     z.array(z.number()),
  optionIds:       z.array(z.number()),
  archivedIds:     z.array(z.number()),
  acceptedEntries: z.array(ApiAcceptedEntrySchema),
  reviews:         z.array(ApiReviewSchema),
  addresses:       z.array(SavedAddressSchema),
  favoriteLists:   z.array(ApiFavoriteListSchema),
});

// ─── Inferred types (re-export for callers that prefer the schema-derived shape) ───

export type ApiRestaurantParsed     = z.infer<typeof ApiRestaurantSchema>;
export type ApiAcceptedParsed       = z.infer<typeof ApiAcceptedSchema>;
export type ApiAcceptedEntryParsed  = z.infer<typeof ApiAcceptedEntrySchema>;
export type ApiFavoriteListParsed   = z.infer<typeof ApiFavoriteListSchema>;
export type MeIdentityParsed        = z.infer<typeof MeIdentitySchema>;
export type MeDataParsed            = z.infer<typeof MeDataSchema>;
