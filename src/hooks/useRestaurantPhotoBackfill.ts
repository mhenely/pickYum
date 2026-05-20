import { useEffect, useCallback } from 'react';
import { useDispatch } from 'react-redux';
import { api } from '../lib/api';
import { updateCustomRestaurant } from '../redux/slices/userInfoSlice';

// Just-in-time photo backfill for cards.
//
// Two trigger paths feed into the same per-session-deduped refresh:
//
//   1. Mount-time: card renders with `photos === []` or `null`. Covers
//      legacy rows (pre-photos-column), rows from when bulk refresh
//      was rate-limited, and custom rows that just got linked to a
//      Google Place. The hook's `useEffect` fires once per restaurant
//      per session in this case.
//
//   2. Image-load failure: card has photo refs but Google's /media
//      endpoint returns INVALID_ARGUMENT. Google's docs claim refs
//      are persistent — empirically they aren't (photos get rotated
//      or removed on Google's side over time). PhotoHero's <img>
//      onError handler calls `onPhotoFailed` to trigger the same
//      refresh, which fetches fresh refs from Place Details and
//      updates the slice. Card re-renders with the new src.
//
// Dedup: a module-level `attempted` Set tracks restaurants we've
// already tried this session. Without it, the post-refresh slice
// update would re-fire useEffect AND a second image-load failure
// (if the new ref also fails) would loop indefinitely. Reset on full
// page reload — the server's staleness check makes retries cheap, so
// per-session memoization is enough.
//
// Why this hook exists vs. just calling api.users.refreshRestaurant
// directly: encapsulating the dedup + the projection-to-slice keeps
// the cards thin and prevents the "every card refreshes on mount"
// runaway-API-spend failure mode.

const attempted = new Set<string>();

interface RestaurantLike {
  photos?: unknown[] | null;
  googlePlaceId?: string | null;
}

export function useRestaurantPhotoBackfill(
  id: string | number | null | undefined,
  restaurant: RestaurantLike | null | undefined,
): { onPhotoFailed: () => void } {
  const dispatch = useDispatch();

  // Shared refresh routine. The mount-time effect and the image-error
  // callback both gate on the same `attempted` Set so they collectively
  // fire at most once per restaurant per session — regardless of which
  // trigger path comes first.
  const fireRefresh = useCallback((numericId: number) => {
    const key = String(numericId);
    if (attempted.has(key)) return;
    attempted.add(key);

    // Fire-and-forget. Server returns `{ refreshed: false }` if the
    // row turned out fresh after all (staleness check) — we just
    // skip the dispatch in that case. Any failure (network, 5xx,
    // 429 from externalApiLimiter) is silent: the card stays as it
    // was, bulk refresh will eventually catch it, and a re-mount in
    // a future session retries.
    api.users.refreshRestaurant(numericId).then((res) => {
      if (!res.refreshed || !res.restaurant) return;
      const r = res.restaurant;
      // Mirror the same projection the slice's refresh thunk uses —
      // keeps the in-memory row consistent with what /me/data
      // would have sent on a fresh page load. Don't write a partial
      // patch (e.g. just `photos`) because the rest of the
      // refreshed fields are also fresher than what's in Redux.
      dispatch(updateCustomRestaurant({
        id: String(r.id),
        data: {
          name: r.name,
          type: r.cuisineType ?? 'Custom',
          price: r.priceLevel ?? 1,
          rating: r.googleRating != null ? Number(r.googleRating) : null,
          ratingCount: r.ratingCount ?? null,
          address: r.address ?? null,
          hours:   r.hours   ?? null,
          phone:   r.phone   ?? null,
          website: r.website ?? null,
          regularOpeningHours: r.regularOpeningHours ?? null,
          photos: Array.isArray(r.photos) ? r.photos : [],
          takeout: r.takeout ?? false,
          delivery: r.delivery ?? false,
          googlePlaceId: r.googlePlaceId ?? null,
          lat: r.lat ?? null,
          lng: r.lng ?? null,
          googleDataUpdatedAt: r.googleDataUpdatedAt ?? null,
          excludeFromPlaceMatching: r.excludeFromPlaceMatching ?? false,
        },
      }));
    }).catch(() => {
      // Silently absorb — the row stays as it was, and the next
      // session reload (or a bulk refresh) will retry. We do NOT
      // unset `attempted` on failure: a 429 means the rate limit is
      // already saying "stop trying for now," so re-firing on
      // every re-render would burn through any remaining budget.
    });
  }, [dispatch]);

  // Numeric id derivation shared between the effect and the callback.
  // Returns null if the id isn't a refreshable DB id (custom-prefixed
  // rows, missing ids, non-integer values).
  const numericId = (() => {
    if (id == null) return null;
    const n = Number(id);
    return Number.isInteger(n) && n > 0 ? n : null;
  })();

  // Mount-time trigger: empty/null photos on a Google-Place-backed row.
  useEffect(() => {
    if (!restaurant) return;
    // Custom rows have no googlePlaceId — there's no upstream to
    // refresh from, photos will stay null forever, and that's fine.
    if (!restaurant.googlePlaceId) return;
    // If photos already exist, the mount-time path doesn't fire. The
    // image-error path (onPhotoFailed) handles the "have refs but they
    // don't work" case separately.
    const photos = restaurant.photos;
    if (Array.isArray(photos) && photos.length > 0) return;
    if (numericId == null) return;
    fireRefresh(numericId);
  }, [restaurant, numericId, fireRefresh]);

  // Image-error trigger: card has refs in Redux but the <img> failed
  // to load (Google's /media endpoint returned INVALID_ARGUMENT for the
  // stored ref). Same refresh routine, gated by the same attempted Set.
  // Stable identity so PhotoHero can use it as an `onError` prop without
  // re-attaching listeners on every render.
  const onPhotoFailed = useCallback(() => {
    if (!restaurant?.googlePlaceId) return;
    if (numericId == null) return;
    fireRefresh(numericId);
  }, [restaurant, numericId, fireRefresh]);

  return { onPhotoFailed };
}
