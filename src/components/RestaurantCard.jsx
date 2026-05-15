import { memo, useRef, useState } from "react";
import RatingDisplay from "./RatingDisplay";
import { PRICE_LABELS } from "../utils/restaurantConstants";
import { placePhotoUrl } from "../lib/api";
import { normalizeUrl } from "../utils/normalizeUrl";

// Treat a field as "present" only when it's a non-empty string that
// isn't our legacy "N/A" sentinel. The data path was cleaned up to
// store `null` for missing values, but old localStorage snapshots and
// any straggling backend rows may still carry the literal string. This
// keeps the card from rendering "Phone: N/A" lines either way.
const displayable = (v) =>
  (typeof v === 'string' && v.trim() && v.trim() !== 'N/A') ? v.trim() : null;

// Strip everything but digits and a leading + for a clean `tel:` href —
// "+1 (555) 123-4567" dials better than the formatted version on iOS.
const telHref = (phone) => `tel:${phone.replace(/[^\d+]/g, '')}`;

// Show "example.com/menu" instead of "https://www.example.com/menu/" so
// the link fits the card's narrow column. The full URL is still the
// href target — this is display-only trimming.
const prettyUrl = (url) => {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    return `${u.hostname.replace(/^www\./, '')}${path}`;
  } catch {
    return url;
  }
};

// ── Photo carousel ───────────────────────────────────────────────────────
// Google Places returns up to ~5 photos per restaurant. The previous
// card showed only photos[0]; this swaps in a horizontal scroll-snap
// carousel so users can swipe through all of them. Pagination dots are
// clickable and reflect the currently-snapped slide.
//
// COST NOTE: each rendered <img> triggers a /api/places/photo call
// which costs us one Google API hit. To keep cost proportional to
// engagement, we only render the active slide and its immediate
// neighbors initially — other slides exist as empty placeholders until
// the user interacts (scrolls or taps a dot). Native loading="lazy"
// doesn't help here because off-screen carousel slides have bounding
// rects inside the document viewport (overflow clipping doesn't
// participate in the lazy-load decision).
function PhotoCarousel({ photos, maxWidthPx, photoBoxClass, restaurantName }) {
  const valid = photos.filter((p) => p?.name);
  const [active, setActive] = useState(0);
  // Track which slide indices have been "activated" — the active slide
  // plus its neighbors. A Set so add() is idempotent. Initialized with
  // just slide 0 (and 1 when present) so first paint is one photo per
  // card, matching the old single-photo cost profile.
  const [loaded, setLoaded] = useState(() => {
    const init = new Set([0]);
    if (valid.length > 1) init.add(1);
    return init;
  });
  const trackRef = useRef(null);

  if (valid.length === 0) return null;

  // Expand `loaded` to include `i` and its neighbors so a swipe doesn't
  // hit a blank slide while the next photo is mid-fetch. Returns the
  // updated Set to satisfy React's immutable-state contract.
  const markLoaded = (i) => {
    setLoaded((prev) => {
      const next = new Set(prev);
      next.add(i);
      if (i > 0) next.add(i - 1);
      if (i < valid.length - 1) next.add(i + 1);
      return next;
    });
  };

  // Snap-aware scroll handler — turns the user's swipe gesture into the
  // matching active index. `clientWidth` is the slide width (each slide
  // is w-full of the track).
  const handleScroll = () => {
    const t = trackRef.current;
    if (!t) return;
    const idx = Math.round(t.scrollLeft / t.clientWidth);
    if (idx !== active) {
      setActive(idx);
      markLoaded(idx);
    }
  };

  const jumpTo = (i) => {
    const t = trackRef.current;
    if (t) t.scrollTo({ left: t.clientWidth * i, behavior: 'smooth' });
    setActive(i);
    markLoaded(i);
  };

  return (
    <div className={photoBoxClass}>
      <div
        ref={trackRef}
        onScroll={handleScroll}
        className="absolute inset-0 flex overflow-x-auto snap-x snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {valid.map((p, i) => (
          <div
            key={`${p.name}-${i}`}
            className="relative h-full w-full shrink-0 snap-start bg-gray-100"
          >
            {loaded.has(i) && (
              <img
                src={placePhotoUrl(p, maxWidthPx)}
                // alt only on the first image — duplicating it across
                // every slide makes screen readers re-announce the same
                // restaurant name on each swipe, which is noisy.
                alt={i === 0 ? restaurantName : ''}
                className="absolute inset-0 h-full w-full object-cover"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            )}
          </div>
        ))}
      </div>
      {valid.length > 1 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-1 flex items-center justify-center gap-1 px-2">
          {valid.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={(e) => { e.stopPropagation(); jumpTo(i); }}
              aria-label={`Show photo ${i + 1} of ${valid.length}`}
              className={`pointer-events-auto h-1.5 rounded-full shadow transition-all ${
                i === active ? 'w-4 bg-white' : 'w-1.5 bg-white/70 hover:bg-white'
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Single restaurant card used on every page that lists restaurants:
//   - Search (saved results)        — size='md', favorite toggle in corner
//   - Search (nearby Places)        — size='md', open-now pill in corner,
//                                     address + distance rows, Google rating only
//   - Compare (favorites + options) — size='sm', isActive ring for compared
//                                     cards, heart/✕ corner action
//   - Choose (options grid)         — size='sm', H/T badges, drag/winner
//                                     states, optional H/T tap pair
//
// The card is a flex column with `h-full` so the bottom action area (children
// slot) anchors via `mt-auto` and cards in the same grid row line up across
// variable above-the-fold content. Meta + badge rows include placeholders so
// heights stay consistent whether a particular field is present or not.
//
// Data input is either:
//   - `id` + `restaurantMap`   — Compare/Choose/Search-saved (already in
//                                customRestaurants Redux); the component
//                                looks it up. Returns null on miss.
//   - `data` directly          — Search-nearby (Places API response, not yet
//                                materialized in the local store).
//
// Corner action precedence (only one slot, so they're mutually exclusive):
//   1. openNow pill            — read-only state, takes priority for nearby
//   2. onFavoriteToggle / isFavorited — Search saved variant (toggle)
//   3. onUnfavorite            — Compare/Choose favorites (red heart, click
//                                un-favorites; no isFavorited needed)
//   4. onRemove                — Compare/Choose options (gray ✕)

// Per-size visual scale. Structural parity: both variants render the SAME
// blocks (photo, name, meta, address, distance, ratings, badges, action).
// Differences are font/padding/photo-aspect only so a Compare/Choose card
// looks like a "shrunk" Search card, not a stripped-down variant.
//
// `photoBoxClass` is the wrapper around the photo thumb. `photoMaxWidthPx`
// is what we ask the photo proxy for — picking smaller widths for sm cards
// saves bandwidth + Google billing. Photo `name` references survive the
// SearchPage → Redux → card path so saved-restaurant cards (Compare/Choose)
// show photos too, not just nearby search results.
const SIZE = {
  md: {
    card: 'p-4',
    photoBoxClass: 'relative -mx-4 -mt-4 mb-3 h-32 overflow-hidden rounded-t-lg',
    photoMaxWidthPx: 600,
    name: 'font-semibold text-base text-orange-600 leading-tight',
    meta: 'text-sm text-gray-500 mt-1 leading-snug',
    lastChosen: 'text-xs text-gray-400 leading-snug',
    address: 'text-xs text-gray-400 mt-0.5 truncate',
    distance: 'text-xs text-orange-400 mt-0.5',
    badgeRow: 'text-xs text-gray-500 min-h-[1.25rem]',
    badgePill: 'bg-gray-100 px-2 py-0.5 rounded',
    cornerAction: 'text-xl',
    htPairText: 'text-sm font-black py-1.5',
    openNowPill: 'text-xs font-medium px-2 py-0.5 rounded-full',
    bottomGap: 'mt-auto pt-3',
    bottomStack: 'flex flex-col gap-2',
  },
  sm: {
    card: 'p-3',
    photoBoxClass: 'relative -mx-3 -mt-3 mb-2 h-20 overflow-hidden rounded-t-lg',
    photoMaxWidthPx: 400,
    name: 'font-semibold text-sm text-orange-600 leading-tight',
    meta: 'text-xs text-gray-500 mt-1 leading-snug line-clamp-2',
    lastChosen: 'text-[10px] text-gray-400 leading-snug',
    address: 'text-[10px] text-gray-400 mt-0.5 truncate',
    distance: 'text-[10px] text-orange-400 mt-0.5',
    badgeRow: 'text-[10px] text-gray-500 min-h-[18px]',
    badgePill: 'bg-gray-100 px-1.5 py-0.5 rounded',
    cornerAction: 'text-lg',
    htPairText: 'text-xs font-black py-1',
    openNowPill: 'text-[10px] font-medium px-1.5 py-0.5 rounded-full',
    bottomGap: 'mt-auto pt-2',
    bottomStack: 'flex flex-col gap-2',
  },
};

const RestaurantCard = ({
  // Data — pick one path
  id,
  restaurantMap,
  data,

  // Per-user context (looked up at the caller; the card just displays)
  personalRating,
  lastChosen,

  // Layout
  size = 'md',

  // Whole-card interaction.
  // Two flavors of every handler are accepted: a legacy zero-arg variant
  // (`onCardClick`) and a `*WithId` variant that receives the card's `id`.
  // Callers in lists should prefer the *WithId form with a `useCallback`
  // hoisted out of the row map — that's the only way to keep `memo` from
  // re-rendering every row whenever the parent re-renders. The card
  // composes the id-bound handler internally with a per-render arrow, but
  // since memo doesn't look inside its own render, that arrow's identity
  // doesn't matter — only the PROP identity from the caller does.
  onCardClick,
  onCardClickWithId,
  onInfo,
  onInfoWithId,

  // Corner action — mutually exclusive; precedence in the comment above
  onFavoriteToggle,
  onFavoriteToggleWithId,
  isFavorited,
  onUnfavorite,
  onUnfavoriteWithId,
  onRemove,
  onRemoveWithId,

  // Choose-page extras
  badge,        // 'heads' | 'tails' | null
  isActive,
  isDragOver,
  isWinner,
  isExcluded,
  onAssignHeads,
  onAssignTails,

  // Bottom action area
  children,

  // Hover passthrough — used by SearchPage's card↔map sync. The
  // component itself just forwards these to the outer <div>; the parent
  // decides what to do. `isHighlighted` adds a ring so the card stands
  // out when its map marker is hovered. `*WithId` variants give callers a
  // way to keep handler identity stable across renders (single useCallback
  // up the tree instead of one inline arrow per row).
  onMouseEnter,
  onMouseEnterWithId,
  onMouseLeave,
  onMouseLeaveWithId,
  isHighlighted,
}) => {
  // Bind id-variants once per render. The bound arrows have fresh identity
  // each render, but they live INSIDE this memoized component — only the
  // caller's prop identity affects memo's bail-out decision, and *WithId
  // props are stable from useCallback at the caller. Each line composes
  // the bound form if present, falls back to the legacy zero-arg form.
  const resolvedCardClick     = onCardClickWithId     ? () => onCardClickWithId(id)     : onCardClick;
  const resolvedInfo          = onInfoWithId          ? () => onInfoWithId(id)          : onInfo;
  const resolvedFavToggle     = onFavoriteToggleWithId ? () => onFavoriteToggleWithId(id) : onFavoriteToggle;
  const resolvedUnfavorite    = onUnfavoriteWithId    ? () => onUnfavoriteWithId(id)    : onUnfavorite;
  const resolvedRemove        = onRemoveWithId        ? () => onRemoveWithId(id)        : onRemove;
  const resolvedMouseEnter    = onMouseEnterWithId    ? () => onMouseEnterWithId(id)    : onMouseEnter;
  const resolvedMouseLeave    = onMouseLeaveWithId    ? () => onMouseLeaveWithId(id)    : onMouseLeave;
  // Resolve data source:
  //   - id given + found in restaurantMap → render that row
  //   - id given + missing from map       → render nothing (stale id)
  //   - no id at all                      → render `data` (nearby Places path)
  //
  // NB: the obvious-looking `(id != null && restaurantMap?.[id]) ?? data`
  // is wrong — when `id` is null, the left side is `false` (not nullish),
  // and `??` doesn't fall through, so `r` becomes `false` and every nearby
  // card returns null. Use a real ternary so the no-id branch reaches `data`.
  //
  // The `restaurantMap` guard lets callers pass `id` purely to power the
  // `*WithId` callback variants while still rendering from `data`. Without
  // it, "id present + restaurantMap missing" returned `undefined` for `r`
  // and rendered nothing — breaking the Search-nearby cards if they tried
  // to hand placeId through `id` for stable hover handlers.
  const r = (id != null && restaurantMap) ? restaurantMap[id] : data;
  if (!r) return null;

  const s = SIZE[size] ?? SIZE.md;

  // Whole-card click: prefer the explicit onCardClick (Compare page's
  // "add to comparison"); fall back to onInfo so the Choose page's
  // "click anywhere opens detail" still works. Skip if the click landed
  // inside a button so the corner action and H/T pair never accidentally
  // trigger the card action.
  const cardAction = resolvedCardClick ?? resolvedInfo;
  const handleCardClick = cardAction
    ? (e) => {
        if (e.target.closest('button')) return;
        cardAction();
      }
    : undefined;

  // Name is a separate button only when the parent wants the whole card to do
  // something OTHER than open detail (Compare's add-to-comparison flow).
  // Otherwise the card click IS the detail-open and the name stays plain text.
  const nameAsButton = !!(resolvedCardClick && resolvedInfo);

  // Type · Price. Hours used to ride along here with an "Opens" prefix,
  // but it now gets its own line below alongside phone/website — that
  // makes the strong fields (name + cuisine + price) easier to scan and
  // gives the contact info room to breathe when present.
  const metaLine = [
    r.type ?? r.cuisineType,
    r.price != null ? PRICE_LABELS[r.price] : (r.priceLevel != null ? PRICE_LABELS[r.priceLevel] : null),
  ].filter(Boolean).join(' · ');

  const showHTPair = (onAssignHeads || onAssignTails) && !isExcluded;
  const openNow    = r.openNow;
  const address    = displayable(r.address);
  const distanceKm = r.distanceKm;
  const hours      = displayable(r.hours);
  const phone      = displayable(r.phone);
  const website    = displayable(r.website);
  const websiteHref = website ? normalizeUrl(website) : null;

  // Pick which corner element wins. openNow takes priority when present
  // (Search nearby — and those rows have no favorite/remove available).
  const cornerEl = (() => {
    if (openNow != null) {
      return (
        <span
          className={`${s.openNowPill} ${openNow ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}
        >
          {openNow ? 'Open' : 'Closed'}
        </span>
      );
    }
    if (resolvedFavToggle) {
      return (
        <button
          onClick={(e) => { e.stopPropagation(); resolvedFavToggle(); }}
          aria-label={isFavorited ? 'Unfavorite' : 'Favorite'}
          className={`${s.cornerAction} leading-none shrink-0 ${isFavorited ? 'text-red-500' : 'text-gray-300 hover:text-red-300'}`}
        >
          &#9829;
        </button>
      );
    }
    if (resolvedUnfavorite) {
      return (
        <button
          onClick={(e) => { e.stopPropagation(); resolvedUnfavorite(); }}
          aria-label="Unfavorite"
          className={`${s.cornerAction} leading-none shrink-0 text-red-500 hover:text-red-300`}
        >
          &#9829;
        </button>
      );
    }
    if (resolvedRemove) {
      return (
        <button
          onClick={(e) => { e.stopPropagation(); resolvedRemove(); }}
          aria-label="Remove from options"
          className="text-xs leading-none shrink-0 text-gray-300 hover:text-red-400 px-1"
        >
          ✕
        </button>
      );
    }
    return null;
  })();

  return (
    <div
      onClick={handleCardClick}
      onMouseEnter={resolvedMouseEnter}
      onMouseLeave={resolvedMouseLeave}
      className={[
        // Mirror across all variants: rounded border, white bg, soft shadow,
        // orange glow on hover when interactive.
        'relative flex flex-col h-full rounded-lg border bg-white shadow-sm transition-all duration-150',
        s.card,
        cardAction ? 'cursor-pointer hover:border-orange-300 hover:shadow-md' : '',
        // isHighlighted is driven by external hover (Search-page map pin
        // hover). Distinct from cardAction's :hover so it stays sticky
        // until the marker hover ends.
        isHighlighted ? 'border-orange-400 ring-2 ring-orange-200' : '',
        // Drag/active/winner/excluded states (Choose page); order matters so
        // isWinner wins. None of these are mutually exclusive with cardAction.
        isActive    ? 'border-orange-500 ring-2 ring-orange-300 bg-orange-50' : '',
        isDragOver  ? 'drop-target-active border-orange-400 bg-orange-50' : '',
        isWinner    ? 'border-green-400 ring-2 ring-green-300 bg-green-50' : '',
        isExcluded  ? 'opacity-45' : '',
        // Default border applied only when no state-specific override is active
        !isActive && !isDragOver && !isWinner && !isHighlighted ? 'border-gray-200' : '',
      ].join(' ')}
    >
      {/* Photo carousel — top of card, edge-to-edge via negative margins
          baked into photoBoxClass. Renders only when Google Places
          returned at least one photo; custom user-typed and pre-rollout
          rows skip the photo region entirely. Multiple photos snap-
          scroll horizontally; only the active slide + neighbors actually
          fetch (see PhotoCarousel comments for cost rationale). */}
      {Array.isArray(r.photos) && r.photos.length > 0 && (
        <PhotoCarousel
          photos={r.photos}
          maxWidthPx={s.photoMaxWidthPx}
          photoBoxClass={s.photoBoxClass}
          restaurantName={r.name}
        />
      )}

      {/* Corner badges (Choose page) — overhang outside the card */}
      {badge === 'heads' && (
        <span className="absolute -top-2.5 -left-2.5 w-6 h-6 rounded-full bg-yellow-400 text-yellow-900 text-xs font-black flex items-center justify-center shadow z-10">
          H
        </span>
      )}
      {badge === 'tails' && (
        <span className="absolute -top-2.5 -left-2.5 w-6 h-6 rounded-full bg-orange-500 text-white text-xs font-black flex items-center justify-center shadow z-10">
          T
        </span>
      )}
      {isWinner && (
        <span className="absolute -top-2.5 right-2 text-[10px] font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded-full z-10">
          Winner!
        </span>
      )}

      {/* Header: name + corner action */}
      <div className="flex items-start justify-between gap-2">
        {nameAsButton ? (
          <button
            onClick={(e) => { e.stopPropagation(); resolvedInfo(); }}
            className={`${s.name} hover:underline truncate min-w-0 text-left`}
          >
            {r.name}
          </button>
        ) : (
          <span className={`${s.name} truncate min-w-0`}>
            {r.name}
          </span>
        )}
        {cornerEl}
      </div>

      {/* Last chosen — own row, always rendered (with non-breaking space
          placeholder when absent) so cards line up across a grid row.
          Skipped entirely in size=md when there's nothing to show, since md
          cards have more vertical breathing room and don't need rigid
          alignment between cells. */}
      {(lastChosen || size === 'sm') && (
        <p className={`${s.lastChosen} truncate ${size === 'sm' ? 'min-h-[14px]' : ''}`}>
          {lastChosen ? `Last chosen ${lastChosen}` : ' '}
        </p>
      )}

      {/* Meta line: type · price · hours */}
      {metaLine && <p className={s.meta}>{metaLine}</p>}

      {/* Address + distance — nearby Places results always carry these;
          saved rows (Compare/Choose) get address from the loader so the
          line shows up there too. */}
      {address && <p className={s.address}>{address}</p>}
      {distanceKm != null && (
        <p className={s.distance}>
          {(distanceKm * 0.621371).toFixed(1)} mi away
        </p>
      )}

      {/* Hours / phone / website — refreshed onto the row by
          refresh-places (phone, website) or filled by users on custom
          entries (hours). Each row skips silently when the field is
          missing/null/legacy "N/A" so cards stay short for thin data
          and expand naturally for rich rows. Phone/website links
          stopPropagation so tapping them doesn't bubble to the card
          click (which would open the modal). */}
      {hours && <p className={s.address}>{hours}</p>}
      {phone && (
        <p className={s.address}>
          <a
            href={telHref(phone)}
            onClick={(e) => e.stopPropagation()}
            className="text-orange-600 hover:underline"
          >
            {phone}
          </a>
        </p>
      )}
      {websiteHref && (
        <p className={`${s.address} truncate`}>
          <a
            href={websiteHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-orange-600 hover:underline"
          >
            {prettyUrl(website)}
          </a>
        </p>
      )}

      {/* Ratings row — RatingDisplay shows Google + personal stacked.
          When no personalRating is provided (Search nearby), it still
          renders Google alone. `compact` on sm to match the smaller scale. */}
      {(r.rating != null || r.googleRating != null || personalRating != null) && (
        <div className="mt-1">
          <RatingDisplay
            restaurantId={id}
            googleRating={r.rating ?? r.googleRating ?? null}
            // Count of Google ratings, shown as "(800)" next to the star
            // value when in Google mode. Pulled from r.ratingCount which
            // is populated for both Places-API nearby results and saved
            // restaurants (via the materialize/refresh write path).
            googleRatingCount={r.ratingCount ?? null}
            personalRating={personalRating ?? null}
            compact={size === 'sm'}
          />
        </div>
      )}

      {/* Bottom slot — takeout/delivery badges, H/T pair, children action */}
      <div className={`${s.bottomGap} ${s.bottomStack}`}>
        <div className={`flex flex-wrap gap-1.5 ${s.badgeRow}`}>
          {r.takeout  && <span className={s.badgePill}>Takeout</span>}
          {r.delivery && <span className={s.badgePill}>Delivery</span>}
        </div>

        {/* Choose-page H/T tap pair (touch devices, coin flip mode) */}
        {showHTPair && (
          <div className="flex gap-1.5">
            <button
              onClick={(e) => { e.stopPropagation(); onAssignHeads?.(); }}
              className={`flex-1 rounded ${s.htPairText} transition-colors ${
                badge === 'heads'
                  ? 'bg-yellow-400 text-yellow-900'
                  : 'bg-gray-100 text-gray-400 hover:bg-yellow-100 hover:text-yellow-800'
              }`}
            >
              H
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onAssignTails?.(); }}
              className={`flex-1 rounded ${s.htPairText} transition-colors ${
                badge === 'tails'
                  ? 'bg-orange-500 text-white'
                  : 'bg-gray-100 text-gray-400 hover:bg-orange-100 hover:text-orange-700'
              }`}
            >
              T
            </button>
          </div>
        )}

        {/* Caller-provided action button (Add to Options, Compare, etc.) */}
        {children}
      </div>
    </div>
  );
};

// Memoized so parents that re-render frequently (Choose during a flip
// countdown, Search during a filter toggle) don't repaint every card in
// their grid. The card has no internal state — its output is a pure
// function of props — so the default shallow-equality check is safe.
//
// IMPORTANT for callers: pass stable references for callback props. An
// inline `onCardClick={() => …}` defeats this entirely because each
// parent render mints a fresh function. Use `useCallback` at the call
// site (or in the case of list items, hoist a single handler that takes
// the id as an argument).
export default memo(RestaurantCard);
