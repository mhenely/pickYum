import { describe, it, expect } from 'vitest';
import { MeIdentitySchema, MeDataSchema, SetAcceptedExcludeResponseSchema } from '../../lib/api.schemas';

// Schema sanity tests. These don't exercise the server — they pin the
// expected response shapes so contract drift surfaces as a localized
// test failure (with a field-level error path) instead of a runtime
// "Cannot read property of undefined" at the consumer.
//
// Add a case here when you add a schema.

describe('MeIdentitySchema', () => {
  it('accepts a well-formed /me/identity payload', () => {
    const payload = {
      apiVersion: 1,
      user: {
        id: 1, email: 'a@b.c', username: 'alice', flipCount: 7,
        avatarUrl: null, role: 'user', emailVerified: true,
      },
      defaultListId: 42,
      favoriteIds: [1, 2, 3],
    };
    expect(MeIdentitySchema.safeParse(payload).success).toBe(true);
  });

  it('rejects a payload missing required fields with a usable error path', () => {
    const broken = { apiVersion: 1, user: { id: 1, email: 'a@b.c' } }; // missing username + everything else
    const parsed = MeIdentitySchema.safeParse(broken);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path.join('.'));
      // We expect specific field paths so a server-side rename here
      // surfaces with the right complaint, not a generic "invalid input".
      expect(paths).toContain('user.username');
      expect(paths).toContain('defaultListId');
    }
  });

  it('rejects defaultListId being a string instead of number|null', () => {
    const wrongType = {
      apiVersion: 1,
      user: { id: 1, email: 'a', username: 'a', flipCount: 0, avatarUrl: null, role: 'user', emailVerified: true },
      defaultListId: '42', // server contract says number|null
      favoriteIds: [],
    };
    expect(MeIdentitySchema.safeParse(wrongType).success).toBe(false);
  });
});

describe('MeDataSchema', () => {
  it('accepts the documented /me/data payload with empty collections', () => {
    const payload = {
      apiVersion: 2,
      restaurants: [],
      favoriteIds: [],
      optionIds: [],
      archivedIds: [],
      acceptedEntries: [],
      reviews: [],
      addresses: [],
      favoriteLists: [],
    };
    expect(MeDataSchema.safeParse(payload).success).toBe(true);
  });

  it('tolerates additive new fields (forward compat)', () => {
    // A future server adds a `someNewField` — we should NOT reject the
    // payload, since strictness would break the additive-shape contract.
    const payload = {
      apiVersion: 3,
      restaurants: [],
      favoriteIds: [],
      optionIds: [],
      archivedIds: [],
      acceptedEntries: [],
      reviews: [],
      addresses: [],
      favoriteLists: [],
      someNewField: 'tolerated',
    };
    expect(MeDataSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects when an acceptedEntry is missing its server id', () => {
    const payload = {
      apiVersion: 2,
      restaurants: [],
      favoriteIds: [],
      optionIds: [],
      archivedIds: [],
      acceptedEntries: [{ restaurantId: 5, acceptedAt: '2024-01-01T00:00:00Z', excludeFromInsights: false }],
      reviews: [],
      addresses: [],
      favoriteLists: [],
    };
    const parsed = MeDataSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path.join('.'));
      // Catches the regression where /me/data dropped the server row id
      // (which we use to target the PATCH /me/accepted/:id endpoint).
      expect(paths.some((p) => p === 'acceptedEntries.0.id')).toBe(true);
    }
  });
});

describe('SetAcceptedExcludeResponseSchema', () => {
  it('accepts the PATCH /me/accepted/:id success shape', () => {
    const payload = {
      accepted: {
        id: 42, restaurantId: 7, acceptedAt: '2024-01-01T00:00:00Z',
        excludeFromInsights: true,
        restaurant: {
          id: 7, googlePlaceId: null, name: 'Test', cuisineType: null,
          priceLevel: null, hours: null, phone: null, website: null,
          yelpUrl: null, takeout: false, delivery: false, googleRating: null,
          ratingCount: null, address: null, lat: null, lng: null,
          photos: null, regularOpeningHours: null,
        },
      },
    };
    expect(SetAcceptedExcludeResponseSchema.safeParse(payload).success).toBe(true);
  });

  it('rejects when excludeFromInsights is missing (regression for a real shape change)', () => {
    const payload = {
      accepted: {
        id: 42, restaurantId: 7, acceptedAt: '2024-01-01T00:00:00Z',
        // excludeFromInsights deliberately omitted
        restaurant: {
          id: 7, googlePlaceId: null, name: 'Test', cuisineType: null,
          priceLevel: null, hours: null, phone: null, website: null,
          yelpUrl: null, takeout: false, delivery: false, googleRating: null,
          ratingCount: null, address: null, lat: null, lng: null,
          photos: null, regularOpeningHours: null,
        },
      },
    };
    expect(SetAcceptedExcludeResponseSchema.safeParse(payload).success).toBe(false);
  });
});
