import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { updateUserFavorites } from '../redux/slices/userInfoSlice';
import useCurrentUser from '../hooks/useCurrentUser';
import getMostRecentDate from '../utils/getMostRecentDate';
import RestaurantReviewModal from './RestaurantReviewModal';
import RatingDisplay from './RatingDisplay';
import { PRICE_LABELS } from '../utils/restaurantConstants';

// Top 4 most-chosen restaurants + indecision stats. Pulled out of
// UserInfoPage so it can render on the Insights tab of /you (where it
// belongs conceptually — derived from history, not a setting). Owns
// its own review-modal state so the host page doesn't need to manage it.

const RANK_STYLES = [
  'bg-yellow-400 text-yellow-900',
  'bg-gray-300 text-gray-700',
  'bg-orange-300 text-orange-900',
  'bg-gray-100 text-gray-500',
];

const RANK_LABELS = ['1st', '2nd', '3rd', '4th'];

const getTop4MostChosen = (accepted) => {
  const data = {};
  accepted.forEach(({ restaurantId, date }) => {
    const key = String(restaurantId);
    if (!data[key]) data[key] = { count: 0, latestDate: new Date(0) };
    data[key].count += 1;
    const d = new Date(date);
    if (d > data[key].latestDate) data[key].latestDate = d;
  });
  return Object.entries(data)
    .sort(([, a], [, b]) =>
      b.count !== a.count ? b.count - a.count : b.latestDate - a.latestDate
    )
    .slice(0, 4)
    .map(([id, { count }], index) => ({ id, count, rank: index + 1 }));
};

const StatCard = ({ label, value, sub }) => (
  <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm text-center">
    <p className="text-3xl font-bold text-orange-600">{value}</p>
    <p className="text-sm font-medium text-gray-700 mt-1">{label}</p>
    {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
  </div>
);

export default function UserStatsPanel() {
  const userInfo = useCurrentUser();
  const dispatch = useDispatch();
  const allRestaurants = useSelector((state) => state.userInfo.customRestaurants);
  const isUnauthenticated = useSelector((state) => state.auth.status === 'unauthenticated');
  const isDataLoaded      = useSelector((state) => state.userInfo.isDataLoaded);
  const isDataPending     = !isUnauthenticated && !isDataLoaded;

  const [selectedRestaurantId, setSelectedRestaurantId] = useState(null);

  const flipCount = userInfo.flipCount ?? 0;
  const acceptanceCount = userInfo.accepted.length;
  const acceptanceRate = flipCount > 0
    ? `${Math.round((acceptanceCount / flipCount) * 100)}%`
    : '—';

  const top4 = getTop4MostChosen(userInfo.accepted);

  return (
    <div className="flex flex-col gap-10">

      {/* Top 4 picks */}
      <div>
        <h2 className="text-2xl font-bold text-gray-900 mb-1">Top Picks</h2>
        <p className="text-sm text-gray-500 mb-4">Your 4 most chosen restaurants</p>

        {isDataPending && top4.length === 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-32 rounded-lg bg-gray-100 animate-pulse" />
            ))}
          </div>
        ) : top4.length === 0 ? (
          <p className="text-gray-500 text-sm italic">
            No history yet. Accept a restaurant from the coin flip to get started.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {top4.map(({ id, count, rank }) => {
              const restaurant = allRestaurants[id];
              if (!restaurant) return null;

              const reviews = userInfo.reviews[id] || [];
              const personalRating =
                reviews.length > 0
                  ? reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length
                  : null;
              const isFavorited = userInfo.favorites.map(String).includes(String(id));

              return (
                <div
                  key={id}
                  className="relative flex flex-col h-full rounded-lg border border-gray-200 p-4 shadow-sm bg-white transition-all duration-150 hover:shadow-md hover:border-orange-300 hover:bg-orange-50"
                >
                  <span className={`absolute -top-2.5 -left-2.5 w-10 h-6 rounded-full text-[11px] font-black flex items-center justify-center shadow-sm ${RANK_STYLES[rank - 1]}`}>
                    {RANK_LABELS[rank - 1]}
                  </span>
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0">
                      <span className="text-orange-600 font-semibold block truncate">{restaurant.name}</span>
                      {getMostRecentDate(userInfo.accepted, id) && (
                        <span className="text-xs text-gray-400">
                          Last chosen {getMostRecentDate(userInfo.accepted, id)}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        dispatch(updateUserFavorites({ restaurantId: id, userId: userInfo.id }))
                      }
                      className={`text-xl leading-none shrink-0 ${isFavorited ? 'text-red-500' : 'text-gray-300 hover:text-red-300'}`}
                    >
                      &#9829;
                    </button>
                  </div>

                  <p className="text-sm text-gray-500 mt-1">
                    {restaurant.type} · {PRICE_LABELS[restaurant.price]} · Opens {restaurant.hours}
                  </p>

                  <div className="mt-1">
                    <RatingDisplay
                      restaurantId={id}
                      googleRating={restaurant.rating ?? null}
                      personalRating={personalRating}
                      personalReviews={reviews}
                      restaurantName={restaurant.name}
                    />
                    {reviews.length > 0 && (
                      <span className="text-xs text-gray-400 ml-1">
                        ({reviews.length} review{reviews.length !== 1 ? 's' : ''})
                      </span>
                    )}
                  </div>

                  <div className="flex items-center justify-between mt-3">
                    <div className="flex gap-2 text-xs text-gray-500">
                      {restaurant.takeout && (
                        <span className="bg-gray-100 px-2 py-0.5 rounded">Takeout</span>
                      )}
                      {restaurant.delivery && (
                        <span className="bg-gray-100 px-2 py-0.5 rounded">Delivery</span>
                      )}
                    </div>
                    <span className="text-xs text-gray-400 italic">
                      Chosen {count}×
                    </span>
                  </div>

                  <div className="mt-auto pt-3">
                    <button
                      type="button"
                      onClick={() => setSelectedRestaurantId(id)}
                      className="w-full rounded-md bg-orange-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-orange-500"
                    >
                      See Reviews
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Indecision stats */}
      <div>
        <h2 className="text-base font-semibold leading-7 text-gray-900 mb-1">Your Stats</h2>
        <p className="text-sm text-gray-500 mb-4">How indecisive are you?</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <StatCard label="Total Flips & Spins" value={flipCount} />
          <StatCard label="Times Accepted" value={acceptanceCount} />
          <StatCard
            label="Acceptance Rate"
            value={acceptanceRate}
            sub={flipCount > 0 ? `${acceptanceCount} of ${flipCount}` : 'No flips yet'}
          />
        </div>
      </div>

      {selectedRestaurantId && (
        <RestaurantReviewModal
          restaurantId={selectedRestaurantId}
          restaurant={allRestaurants[selectedRestaurantId]}
          reviews={userInfo.reviews[selectedRestaurantId] || []}
          onClose={() => setSelectedRestaurantId(null)}
        />
      )}
    </div>
  );
}
