import RatingDisplay from "./RatingDisplay";

const RestaurantMiniCard = ({
  id, personalRating, lastChosen, badge, isDragOver, isWinner,
  isExcluded,
  onRemove, onUnfavorite, onInfo, onAssignHeads, onAssignTails,
  children, restaurantMap = {},
}) => {
  const r = restaurantMap[id];
  if (!r) return null;
  return (
    <div
      className={[
        "relative rounded-lg border p-3 bg-white shadow-sm transition-all duration-150 select-none",
        isDragOver ? "drop-target-active border-orange-400 bg-orange-50" : "border-gray-200",
        isWinner   ? "border-green-400 ring-2 ring-green-300 bg-green-50" : "",
        isExcluded ? "opacity-45" : "",
      ].join(" ")}
    >
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

      {/* Name + inline average rating */}
      <div className="flex justify-between items-start gap-2">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <button
            onClick={(e) => { e.stopPropagation(); onInfo?.(); }}
            className="font-semibold text-sm text-orange-600 hover:underline leading-tight text-left truncate max-w-full"
          >
            {r.name}
          </button>
          <RatingDisplay
            restaurantId={id}
            googleRating={r.rating ?? null}
            personalRating={personalRating}
            compact
          />
          {lastChosen && (
            <span className="text-[10px] text-gray-400 whitespace-nowrap">
              Last Chosen {lastChosen}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {onUnfavorite && (
            <button
              onClick={onUnfavorite}
              className="text-red-500 hover:text-red-300 text-base leading-none"
            >
              &#9829;
            </button>
          )}
          {onRemove && !onUnfavorite && (
            <button
              onClick={onRemove}
              className="text-gray-300 hover:text-red-400 text-xs leading-none mt-0.5"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <p className="text-xs text-gray-500 mt-0.5">{r.type}</p>
      <p className="text-xs text-gray-400">Opens {r.hours}</p>

      {(onAssignHeads || onAssignTails) && !isExcluded && (
        <div className="flex gap-1.5 mt-2.5">
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

      {children}
    </div>
  );
};

export default RestaurantMiniCard;
