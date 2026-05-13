import RatingDisplay from "./RatingDisplay";
import { PRICE_LABELS } from "../utils/restaurantConstants";

// Compact restaurant card used on the Choose page (options grid + favorites
// rail) and the Compare page (favorites / options lists). Visually mirrors
// the SearchPage result card — same vertical structure (header, meta, rating,
// takeout/delivery badges, action button at the bottom) — just sized down for
// ~140-180px cells and the slightly tighter Favorites rail.
//
// Heights stay consistent across cards because every row renders at a
// predictable height: "Last chosen" gets its own row with a non-breaking-space
// placeholder when absent, the takeout/delivery badge row has min-height, and
// the card body uses `h-full` + `flex flex-col` so the bottom action area
// anchors via `mt-auto`.
//
// Interaction model:
//   - onCardClick: whole-card click (e.g. Compare page "add to comparison").
//     When provided, the name renders as a button bound to onInfo so users
//     still have a distinct "open detail" affordance.
//   - onInfo (without onCardClick): whole-card click opens detail (Choose page).
//   - onUnfavorite / onRemove: mutually-exclusive top-right corner action.
//   - onAssignHeads / onAssignTails: tap-to-assign H/T pair (Choose page coin
//     flip mode on touch devices).
//   - children: optional action button (typically a gradient CTA) rendered in
//     the bottom slot below the takeout/delivery badges.
const RestaurantMiniCard = ({
  id,
  personalRating,
  lastChosen,
  badge,            // 'heads' | 'tails' | null — corner badge (Choose page coin flip)
  isDragOver,       // true while a drag is over this card (Choose page desktop)
  isWinner,         // true if this restaurant was just picked
  isActive,         // true when card is being compared (Compare page)
  isExcluded,       // true when filtered out of the flip pool
  onRemove,
  onUnfavorite,
  onInfo,
  onCardClick,
  onAssignHeads,
  onAssignTails,
  children,
  restaurantMap = {},
}) => {
  const r = restaurantMap[id];
  if (!r) return null;

  // Whole-card click: prefer the explicit onCardClick (Compare page); fall back
  // to onInfo so the Choose page's "click anywhere opens detail" still works.
  // Skip if the click landed inside any button — keeps top-right and H/T
  // buttons from accidentally triggering the card action.
  const cardAction = onCardClick ?? onInfo;
  const handleCardClick = cardAction
    ? (e) => {
        if (e.target.closest('button')) return;
        cardAction();
      }
    : undefined;

  // Name is a separate button when the parent wants the whole card to do
  // something OTHER than open detail (Compare page). Otherwise it's plain
  // text and the card click is the detail-open action.
  const nameAsButton = !!(onCardClick && onInfo);

  const metaLine = [
    r.type,
    r.price ? PRICE_LABELS[r.price] : null,
    r.hours && r.hours !== 'N/A' ? `Opens ${r.hours}` : null,
  ].filter(Boolean).join(' · ');

  const showHTPair = (onAssignHeads || onAssignTails) && !isExcluded;

  return (
    <div
      onClick={handleCardClick}
      className={[
        // Mirror SearchPage card: rounded-lg border, white bg, soft shadow,
        // orange-glow on hover. p-3 (vs Search's p-4) for the smaller scale.
        "relative flex flex-col h-full rounded-lg border bg-white shadow-sm p-3 transition-all duration-150 select-none",
        cardAction ? "cursor-pointer hover:border-orange-300 hover:shadow-md" : "",
        // Drag/active/winner/excluded states layer on top of the base border.
        // Order matters: later classes override earlier ones; isWinner wins.
        isActive    ? "border-orange-500 ring-2 ring-orange-300 bg-orange-50" : "",
        isDragOver  ? "drop-target-active border-orange-400 bg-orange-50" : "",
        isWinner    ? "border-green-400 ring-2 ring-green-300 bg-green-50" : "",
        isExcluded  ? "opacity-45" : "",
        // Default border only when no state-specific override is active
        !isActive && !isDragOver && !isWinner ? "border-gray-200" : "",
      ].join(" ")}
    >
      {/* Corner badges (Choose page) — overhang outside the card */}
      {badge === "heads" && (
        <span className="absolute -top-2.5 -left-2.5 w-6 h-6 rounded-full bg-yellow-400 text-yellow-900 text-xs font-black flex items-center justify-center shadow z-10">
          H
        </span>
      )}
      {badge === "tails" && (
        <span className="absolute -top-2.5 -left-2.5 w-6 h-6 rounded-full bg-orange-500 text-white text-xs font-black flex items-center justify-center shadow z-10">
          T
        </span>
      )}
      {isWinner && (
        <span className="absolute -top-2.5 right-2 text-[10px] font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded-full z-10">
          Winner!
        </span>
      )}

      {/* Header: name + favorite/remove (mirrors SearchPage's top row) */}
      <div className="flex items-start justify-between gap-2">
        {nameAsButton ? (
          <button
            onClick={(e) => { e.stopPropagation(); onInfo(); }}
            className="font-semibold text-sm text-orange-600 hover:underline truncate min-w-0 text-left leading-tight"
          >
            {r.name}
          </button>
        ) : (
          <span className="font-semibold text-sm text-orange-600 truncate min-w-0 leading-tight">
            {r.name}
          </span>
        )}
        <div className="flex items-center shrink-0">
          {onUnfavorite && (
            <button
              onClick={(e) => { e.stopPropagation(); onUnfavorite(); }}
              aria-label="Unfavorite"
              className="text-red-500 hover:text-red-300 text-lg leading-none px-1"
            >
              &#9829;
            </button>
          )}
          {onRemove && !onUnfavorite && (
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              aria-label="Remove from options"
              className="text-gray-300 hover:text-red-400 text-xs leading-none px-1"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Last chosen — own row (matches SearchPage's inline placement is
          impossible at this width without inconsistent wrapping). Always
          rendered with a space placeholder so cards line up. */}
      <p className="text-[10px] text-gray-400 truncate min-h-[14px] leading-snug">
        {lastChosen ? `Last chosen ${lastChosen}` : ' '}
      </p>

      {/* Meta line: type · price · hours (SearchPage uses text-sm; we drop
          to text-xs for the smaller scale). line-clamp-2 in case the cuisine
          type is unusually long. */}
      <p className="text-xs text-gray-500 mt-1 leading-snug line-clamp-2">
        {metaLine || ' '}
      </p>

      {/* Rating row — Google + personal stacked compactly */}
      <div className="mt-1">
        <RatingDisplay
          restaurantId={id}
          googleRating={r.rating ?? null}
          personalRating={personalRating}
          compact
        />
      </div>

      {/* Bottom slot — mirrors SearchPage's "mt-auto pt-3" anchored block.
          Order matches SearchPage: takeout/delivery badges, then action button. */}
      <div className="mt-auto pt-2 flex flex-col gap-2">
        {/* Takeout / Delivery pill badges. min-h reserves height even when
            neither is set so cards stay aligned. */}
        <div className="flex flex-wrap gap-1.5 text-[10px] text-gray-500 min-h-[18px]">
          {r.takeout  && <span className="bg-gray-100 px-1.5 py-0.5 rounded">Takeout</span>}
          {r.delivery && <span className="bg-gray-100 px-1.5 py-0.5 rounded">Delivery</span>}
        </div>

        {/* H/T tap pair (Choose page coin flip on touch devices) */}
        {showHTPair && (
          <div className="flex gap-1.5">
            <button
              onClick={(e) => { e.stopPropagation(); onAssignHeads?.(); }}
              className={`flex-1 rounded py-1 text-xs font-black transition-colors ${
                badge === 'heads'
                  ? 'bg-yellow-400 text-yellow-900'
                  : 'bg-gray-100 text-gray-400 hover:bg-yellow-100 hover:text-yellow-800'
              }`}
            >
              H
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onAssignTails?.(); }}
              className={`flex-1 rounded py-1 text-xs font-black transition-colors ${
                badge === 'tails'
                  ? 'bg-orange-500 text-white'
                  : 'bg-gray-100 text-gray-400 hover:bg-orange-100 hover:text-orange-700'
              }`}
            >
              T
            </button>
          </div>
        )}

        {/* Caller-provided action button (e.g. "+ Add to Options"
            gradient CTA, "Compare" button). Sits below H/T if both present. */}
        {children}
      </div>
    </div>
  );
};

export default RestaurantMiniCard;
