import { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchCommunityRating } from '../redux/slices/ratingSlice';
import StarRating from './star-rating/star-rating.component';
import ReviewsModal from './ReviewsModal';

const MODES = [
  { key: 'personal',  label: 'Yours' },
  { key: 'google',    label: 'Google' },
  { key: 'community', label: 'Community' },
];

const MODE_CYCLE = { personal: 'google', google: 'community', community: 'personal' };
const MODE_INITIAL = { personal: 'P', google: 'G', community: 'C' };

// `googleRatingCount` (when shown alongside Google rating mode) tells the
// user how many ratings back the average — disambiguates "4.5 from 3" vs
// "4.5 from 800". The whole label gets a thousands-separator formatter so
// large counts ("3,427") read cleanly.
const formatRatingCount = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return String(n);
  return n.toLocaleString();
};

const RatingDisplay = ({ restaurantId, googleRating, googleRatingCount, personalRating, personalReviews, restaurantName, compact = false }) => {
  const dispatch = useDispatch();
  const [mode, setMode] = useState('personal');
  const [reviewsOpen, setReviewsOpen] = useState(false);

  // Scoped subscriptions: each card subscribes only to its OWN entry, not
  // the whole `communityRatings` record. The whole-record subscription used
  // to re-render every RatingDisplay on the page whenever any one rating
  // arrived from the API; with N=20 cards on Search, that's 20 RatingDisplay
  // + 20 StarRating re-renders for every single fetchCommunityRating
  // fulfillment. Now only the specific card whose rating arrived re-renders.
  const idStr = String(restaurantId);
  const communityRating = useSelector((s) => s.rating.communityRatings[idStr]);
  const hasFetched = useSelector((s) => idStr in s.rating.communityRatings);
  const isPending = useSelector((s) => s.rating.pendingIds.includes(idStr));

  useEffect(() => {
    if (mode === 'community' && !hasFetched && !isPending) {
      dispatch(fetchCommunityRating(restaurantId));
    }
  }, [mode, idStr, hasFetched, isPending, dispatch, restaurantId]);

  const ratingByMode = {
    personal:  personalRating  != null ? Number(personalRating)  : null,
    google:    googleRating    != null ? Number(googleRating)     : null,
    community: hasFetched ? communityRating : undefined,
  };

  const activeRating = ratingByMode[mode];
  const displayValue = activeRating != null ? activeRating : null;

  if (compact) {
    const label = displayValue != null
      ? displayValue.toFixed(1)
      : (mode === 'community' && isPending ? '…' : '—');
    // Compact variant shows ratingCount in parentheses after the
    // star+value when we're on Google mode. Skip on personal/community
    // for the same reasons as the full variant above.
    const compactCount = mode === 'google' && displayValue != null
      ? formatRatingCount(googleRatingCount) : null;
    return (
      <button
        type="button"
        title={`Rating source: ${mode} — click to cycle`}
        onClick={(e) => { e.stopPropagation(); setMode(MODE_CYCLE[mode]); }}
        className="flex items-center gap-0.5 text-xs font-bold text-amber-500 hover:text-orange-500 transition-colors whitespace-nowrap"
      >
        ★ {label}
        {compactCount && (
          <span className="text-[9px] font-normal text-gray-400 tabular-nums ml-0.5">
            ({compactCount})
          </span>
        )}
        <span className="text-[9px] font-normal text-gray-400 uppercase ml-0.5">
          {MODE_INITIAL[mode]}
        </span>
      </button>
    );
  }

  // Show the rating count only when we're on the Google mode AND have one.
  // We don't show counts for personal (always ≤1 per user) or community
  // (already implied by "See reviews"). Compact variant gets a separate
  // path above that handles this inline.
  const showCount = mode === 'google' && displayValue != null;
  const countLabel = showCount ? formatRatingCount(googleRatingCount) : null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <StarRating rating={displayValue ?? 0} />
        {displayValue != null ? (
          <span className="text-xs text-gray-500 font-medium tabular-nums">
            {displayValue.toFixed(1)}
          </span>
        ) : (
          <span className="text-xs text-gray-400 italic">
            {mode === 'community' && isPending ? '…' : 'N/A'}
          </span>
        )}
        {countLabel && (
          <span className="text-[10px] text-gray-400 tabular-nums" aria-label={`${countLabel} Google ratings`}>
            ({countLabel})
          </span>
        )}
      </div>

      <div className="flex gap-1">
        {MODES.map(({ key, label }) => {
          const hasData =
            key === 'personal'  ? personalRating  != null :
            key === 'google'    ? googleRating    != null :
            hasFetched          ? communityRating != null : true;

          const isActive = mode === key;
          return (
            <button
              key={key}
              type="button"
              onClick={(e) => { e.stopPropagation(); setMode(key); }}
              className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${
                isActive
                  ? 'bg-orange-500 border-orange-500 text-white font-semibold'
                  : hasData
                  ? 'bg-white border-gray-300 text-gray-500 hover:border-orange-400 hover:text-orange-600'
                  : 'bg-white border-gray-200 text-gray-300'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
      {personalReviews !== undefined && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setReviewsOpen(true); }}
          className="text-[10px] text-orange-500 hover:text-orange-700 underline underline-offset-2 transition-colors self-start mt-0.5"
        >
          See reviews
        </button>
      )}
      {reviewsOpen && (
        <ReviewsModal
          restaurantId={restaurantId}
          restaurantName={restaurantName ?? 'Reviews'}
          googleRating={googleRating}
          personalReviews={personalReviews ?? []}
          onClose={() => setReviewsOpen(false)}
        />
      )}
    </div>
  );
};

export default RatingDisplay;
