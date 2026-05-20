// Shared constants + helpers used across the /me/* domain files.
//
// Why this exists: when users.ts was a single 2,700-line file, these
// helpers lived inline near their first user. Splitting into per-domain
// files (profile, addresses, favorites, etc.) leaves these still shared
// across multiple files — so they get one home here instead of N
// duplicates that drift over time.

import prisma from '../../lib/prisma';

export const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

// String-input caps. Picked generously enough for real usernames / addresses
// / review text, tight enough that a hostile client can't store megabytes per
// row. Username/email match what the registration UI already constrains.
export const MAX_USERNAME_LEN   = 32;
export const MAX_EMAIL_LEN      = 254; // RFC 5321 maximum
export const MAX_REVIEW_CONTENT = 4000;
// Avatar payload cap. The frontend downscales to ~256×256 before sending,
// which lands well under 100KB even at high JPEG quality. The DB column
// stores the data URL directly — fine at this scale; if avatar storage
// ever pressures the DB we'll move to S3/Supabase Storage and the column
// becomes a URL. The Express body limit (32kb in app.ts) is overridden for
// this single route via the `bigJson` helper below.
export const MAX_AVATAR_BYTES   = 100 * 1024;

// Magic-byte signatures for the image types we accept. Validating these
// (vs. trusting the data-URL MIME header) prevents a hostile client from
// labelling an arbitrary payload as image/png and stashing it in a column
// the UI will render. We only check the prefix — full image parsing would
// be overkill and most attacks fail this gate.
export function isRecognizedImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // GIF: 47 49 46 38 (GIF8)
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // WebP: starts with "RIFF" then 4 bytes of size then "WEBP"
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return true;
  return false;
}

export async function recomputeCommunityRating(restaurantId: number): Promise<void> {
  // Serialize concurrent recomputes for the same restaurant via a Postgres
  // advisory lock keyed by `restaurantId`. Without this, two parallel review
  // creates can interleave their `groupBy → update` pairs and the slower
  // recompute clobbers the faster one with a stale aggregate. The lock is
  // transaction-scoped (auto-released on commit/rollback) and only contends
  // with other recomputes for the *same* restaurant — high-volume rows queue
  // briefly, low-volume rows pay nothing.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${restaurantId})`;

    // The user-avg groupBy and the orphan findMany are independent — both
    // filter the same `restaurantId` but along disjoint `userId` predicates.
    // Parallelize to save one RTT per recompute. Backed by index
    // reviews(restaurant_id) so each is O(log N).
    //
    // Per-user averages collapse multiple reviews from the same person into
    // one data point so no single account can dominate by spamming reviews.
    // Orphans (from deleted accounts) can no longer be grouped by user;
    // each is counted as its own data point so historical contributions
    // survive an account deletion without letting one deleted user
    // double-count. `?? []` is defensive for jest automocks that resolve
    // to undefined.
    const [userAvgs, orphans] = await Promise.all([
      tx.review.groupBy({
        by: ['userId'],
        where: { restaurantId, userId: { not: null } },
        _avg: { rating: true },
      }),
      tx.review.findMany({
        where: { restaurantId, userId: null },
        select: { rating: true },
      }).then((r) => r ?? []),
    ]);

    const samples = [
      ...userAvgs.map((u) => Number(u._avg.rating ?? 0)),
      ...orphans.map((o) => Number(o.rating)),
    ];
    const communityRating =
      samples.length > 0
        ? samples.reduce((sum, n) => sum + n, 0) / samples.length
        : null;
    await tx.restaurant.update({ where: { id: restaurantId }, data: { communityRating } });
  });
}

// ── Restaurant card projection ──────────────────────────────────────
//
// THIS PROJECTION IS THE SESSION-RESTORE BOTTLENECK. Anything you want
// to survive a logout/login cycle on cards/modals MUST be listed here
// — otherwise the field comes back from /me/all as undefined and the
// frontend can only repopulate it via a fresh nearby search. Found and
// fixed an instance where photos / ratingCount / regularOpeningHours /
// address were missing here even though they were persisted in the DB
// (added via materialize + refresh-places); the cards rendered them
// after a search but lost them on the next session.
//
// yelpUrl was previously selected here too, but no UI surface reads
// it anymore — dropped to keep the projection lean.
export const RESTAURANT_CARD_SELECT = {
  id: true,
  name: true,
  cuisineType: true,
  priceLevel: true,
  googleRating: true,
  // Number of Google ratings backing the average. UI uses it to show
  // "4.5 (827 ratings)" — without it the count silently disappears
  // after a session refresh.
  ratingCount: true,
  // Free-form opening-hours string (typically null — only set on
  // user-typed custom rows that supplied an Opens line).
  hours: true,
  phone: true,
  website: true,
  // Postal address rendered in the modal's Contact info grid.
  address: true,
  takeout: true,
  delivery: true,
  googlePlaceId: true,
  // Needed for the Compare-page map. ~16 bytes per row — negligible
  // payload addition. Frontend skips rows where these are null.
  lat: true,
  lng: true,
  // Cached Google Places photo metadata array. Drives the photo
  // carousel on cards + the photo hero/strip in the detail modal.
  // JSON column — typical row carries 200-500 bytes.
  photos: true,
  // Structured weekly hours used by the open-now / closing-soon
  // indicator + the collapsible weekday table. JSON column —
  // typical row carries 300-800 bytes.
  regularOpeningHours: true,
  // Custom-row opt-out for the post-search match-suggestion scan.
  // Read by the frontend to skip a custom row when scanning
  // search results; toggled by the user via the match-confirm
  // modal's "Stop asking" button or the detail-modal toggle.
  excludeFromPlaceMatching: true,
  // Surfaces a "Google data updated 2 months ago" indicator on the
  // detail modal so users know to expect possible staleness when
  // STALE_DAYS is set to 90. Null for custom rows + legacy
  // pre-rollout rows; rendered only when older than ~7 days so
  // freshly-refreshed rows don't show noise like "updated today".
  googleDataUpdatedAt: true,
} as const;

// Bump this whenever /me/all's response shape changes in a breaking
// way (added fields are non-breaking; removed/renamed fields are).
// Future mobile clients use it to detect "please update" scenarios
// instead of failing on missing keys. Mirrored by ApiMeAllResponse
// in src/lib/api.ts — update both together.
//
//   v1 → original Option-B normalized shape (deduped restaurants[]
//        + per-collection ID arrays).
//   v2 → adds favoriteLists[] (multi-list favorites). `favoriteIds`
//        stays during the transition as a derived view of the
//        default list's entries; drop in a future minor bump after
//        all client surfaces read from favoriteLists.
export const ME_ALL_API_VERSION = 2;
