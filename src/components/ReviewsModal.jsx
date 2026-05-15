import { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { api } from '../lib/api';
import StarRating from './star-rating/star-rating.component';

const SORT_OPTIONS = [
  { label: 'Newest first', value: 'date-desc' },
  { label: 'Oldest first', value: 'date-asc' },
  { label: 'Highest rating', value: 'rating-desc' },
  { label: 'Lowest rating', value: 'rating-asc' },
];

const SOURCE_PILLS = [
  { key: 'personal',  label: 'Yours' },
  { key: 'google',    label: 'Google' },
  { key: 'community', label: 'Community' },
];

const ALL_SOURCES = SOURCE_PILLS.map((s) => s.key);

const isDbRestaurant = (id) => Number.isInteger(Number(id)) && Number(id) > 0;

const ReviewsModal = ({
  restaurantId,
  restaurantName,
  googleRating,
  personalReviews = [],
  onClose,
}) => {
  const currentUserId = useSelector((state) => state.auth.user?.id ?? null);

  const [sources, setSources]           = useState(new Set(ALL_SOURCES));
  const [sortBy, setSortBy]             = useState('date-desc');
  const [communityReviews, setCommunity] = useState([]);
  const [loading, setLoading]           = useState(false);
  const [fetchError, setFetchError]     = useState(false);

  useEffect(() => {
    if (!isDbRestaurant(restaurantId)) return;
    setLoading(true);
    api.restaurants
      .getReviews(Number(restaurantId))
      .then((data) => setCommunity(data.reviews ?? []))
      .catch(() => setFetchError(true))
      .finally(() => setLoading(false));
  }, [restaurantId]);

  const allSelected = sources.size === ALL_SOURCES.length;

  const toggleSource = (key) =>
    setSources((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleAll = () =>
    setSources(allSelected ? new Set() : new Set(ALL_SOURCES));

  // Build normalised review list
  const visibleReviews = [];

  if (sources.has('personal')) {
    for (const [i, r] of personalReviews.entries()) {
      visibleReviews.push({
        key:       r.id != null ? `personal-${r.id}` : `personal-idx-${i}`,
        source:    'personal',
        reviewer:  'You',
        rating:    Number(r.rating),
        content:   r.content ?? '',
        date:      r.date,
        timestamp: new Date(r.date).getTime() || 0,
      });
    }
  }

  if (sources.has('community')) {
    for (const r of communityReviews) {
      // Deduplicate: skip the current user's own community reviews when their
      // personal reviews are also being shown.
      if (sources.has('personal') && currentUserId && r.user?.id === currentUserId) continue;
      visibleReviews.push({
        key:       `community-${r.id}`,
        source:    'community',
        // Null user = the reviewer deleted their account but the review was
        // kept (anonymized) so the community keeps the rating data. Match the
        // copy used in RestaurantDetailModal so the deleted-user signal is
        // consistent across the app.
        reviewer:  r.user?.username ?? '[deleted user]',
        rating:    Number(r.rating),
        content:   r.content ?? '',
        date:      new Date(r.createdAt).toLocaleDateString(undefined, {
                     month: 'short', day: 'numeric', year: 'numeric',
                   }),
        timestamp: new Date(r.createdAt).getTime(),
      });
    }
  }

  const sorted = [...visibleReviews].sort((a, b) => {
    if (sortBy === 'date-desc')   return b.timestamp - a.timestamp;
    if (sortBy === 'date-asc')    return a.timestamp - b.timestamp;
    if (sortBy === 'rating-desc') return b.rating - a.rating;
    if (sortBy === 'rating-asc')  return a.rating - b.rating;
    return 0;
  });

  const showGoogleCard = sources.has('google') && googleRating != null;
  const totalCount     = sorted.length + (showGoogleCard ? 1 : 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" onClick={onClose} />

      <div className="relative w-full max-w-lg rounded-2xl bg-white shadow-2xl flex flex-col max-h-[85vh]">

        {/* Header */}
        <div className="flex justify-between items-start px-6 py-4 border-b border-gray-100 shrink-0">
          <div>
            <h2 className="text-base font-bold text-gray-900 leading-snug">{restaurantName}</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {totalCount} review{totalCount !== 1 ? 's' : ''}
              {loading && ' · loading…'}
              {fetchError && ' · community reviews unavailable'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors text-xl leading-none ml-4 shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Source filter */}
        <div className="px-6 py-3 border-b border-gray-100 flex items-center gap-2 flex-wrap shrink-0">
          <span className="text-xs font-medium text-gray-500">Source:</span>
          <button
            onClick={toggleAll}
            className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
              allSelected
                ? 'bg-orange-500 border-orange-500 text-white'
                : 'bg-white border-gray-300 text-gray-600 hover:border-orange-400 hover:text-orange-600'
            }`}
          >
            All
          </button>
          {SOURCE_PILLS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => toggleSource(key)}
              className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
                sources.has(key)
                  ? 'bg-orange-500 border-orange-500 text-white'
                  : 'bg-white border-gray-300 text-gray-600 hover:border-orange-400 hover:text-orange-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="px-6 py-2.5 border-b border-gray-100 flex items-center gap-2 shrink-0">
          <span className="text-xs font-medium text-gray-500">Sort:</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="text-xs rounded border border-gray-300 pl-2 pr-8 py-1 focus:outline-none focus:ring-1 focus:ring-orange-500"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Review list */}
        <div className="overflow-y-auto flex-1 px-6 py-4 flex flex-col gap-3">

          {/* Google aggregate card */}
          {showGoogleCard && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-200 text-amber-800">
                  Google
                </span>
                <StarRating rating={Number(googleRating)} />
                <span className="text-sm font-bold text-gray-800">
                  {Number(googleRating).toFixed(1)}
                </span>
                <span className="text-xs text-gray-400 ml-auto">Aggregate score</span>
              </div>
              <p className="text-xs text-gray-500 leading-relaxed">
                Individual Google reviews aren't available — this is the aggregate score from Google Maps.
              </p>
            </div>
          )}

          {/* Personal + community review cards */}
          {sorted.length === 0 && !showGoogleCard ? (
            <p className="text-sm text-gray-400 italic text-center py-8">
              {sources.size === 0
                ? 'Select at least one source to see reviews.'
                : 'No reviews yet for the selected sources.'}
            </p>
          ) : (
            sorted.map((review) => (
              <div
                key={review.key}
                className={`rounded-lg border px-4 py-3 ${
                  review.source === 'personal'
                    ? 'border-orange-100 bg-orange-50'
                    : 'border-gray-100 bg-gray-50'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                        review.source === 'personal'
                          ? 'bg-orange-200 text-orange-800'
                          : 'bg-gray-200 text-gray-700'
                      }`}
                    >
                      {review.reviewer}
                    </span>
                    <StarRating rating={review.rating} />
                    <span className="text-xs font-bold text-gray-700">
                      {review.rating.toFixed(1)}
                    </span>
                  </div>
                  <span className="text-xs text-gray-400 shrink-0 ml-2">{review.date}</span>
                </div>
                {review.content && (
                  <p className="text-sm text-gray-700 leading-relaxed">{review.content}</p>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default ReviewsModal;
