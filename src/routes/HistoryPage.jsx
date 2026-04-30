import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { addUserReview, removeUserReview, updateUserFavorites } from '../redux/slices/userInfoSlice';
import { restaurants } from '../tempData/restaurants';
import StarRating from '../components/star-rating/star-rating.component';
import RestaurantReviewModal from '../components/RestaurantReviewModal';
import useCurrentUser from '../hooks/useCurrentUser';
import getMostRecentDate from '../utils/getMostRecentDate';

const PRICE_LABELS = { 1: '$', 2: '$$', 3: '$$$', 4: '$$$$' };

const getLastChosenTimestamp = (accepted, id) => {
  const entries = accepted.filter((a) => String(a.restaurantId) === String(id));
  if (!entries.length) return 0;
  return Math.max(...entries.map((a) => new Date(a.date).getTime()));
};

const getChosenCount = (accepted, id) =>
  accepted.filter((a) => String(a.restaurantId) === String(id)).length;

const UserHistoryPage = () => {
  const currentUser = useCurrentUser();
  const dispatch = useDispatch();
  const customRestaurants = useSelector((state) => state.userInfo.customRestaurants);
  const allRestaurants = { ...restaurants, ...customRestaurants };

  const [selectedRestaurantId, setSelectedRestaurantId] = useState(null);
  const [sortBy, setSortBy] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  const handleCardClick = (id) => setSelectedRestaurantId(id);

  const handleSortClick = (key) => {
    if (sortBy === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(key);
      setSortDir('desc');
    }
  };

  // Collect unique restaurant IDs from accepted history and restaurants with reviews
  const chosenIds = [
    ...new Set([
      ...currentUser.accepted.map((a) => String(a.restaurantId)),
      ...Object.keys(currentUser.reviews).filter(
        (id) => currentUser.reviews[id].length > 0
      ),
    ]),
  ];

  // Filter then sort
  const favoriteSet = new Set(currentUser.favorites.map(String));
  const filteredIds = favoritesOnly
    ? chosenIds.filter((id) => favoriteSet.has(String(id)))
    : chosenIds;

  const displayIds = [...filteredIds].sort((a, b) => {
    const valA =
      sortBy === 'date'
        ? getLastChosenTimestamp(currentUser.accepted, a)
        : getChosenCount(currentUser.accepted, a);
    const valB =
      sortBy === 'date'
        ? getLastChosenTimestamp(currentUser.accepted, b)
        : getChosenCount(currentUser.accepted, b);
    return sortDir === 'desc' ? valB - valA : valA - valB;
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <h2 className="text-2xl font-bold text-gray-900 mb-4">Your History</h2>

      {/* ── Controls bar ──────────────────────────────────────── */}
      <div className="flex items-center gap-2 mb-6 flex-wrap">
        <button
          onClick={() => setFavoritesOnly((f) => !f)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
            favoritesOnly
              ? 'bg-red-50 border-red-200 text-red-600'
              : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
          }`}
        >
          <span>&#9829;</span> Favorites
        </button>

        <div className="flex items-center gap-1 ml-auto">
          <span className="text-xs text-gray-400 mr-1">Sort by</span>
          {[
            { key: 'date', label: 'Date' },
            { key: 'count', label: 'Times Chosen' },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => handleSortClick(key)}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                sortBy === key
                  ? 'bg-indigo-50 border-indigo-200 text-indigo-600'
                  : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
              }`}
            >
              {label}
              {sortBy === key && (
                <span className="text-xs">{sortDir === 'desc' ? '↓' : '↑'}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {displayIds.length === 0 && (
        <p className="text-gray-500 text-sm">
          {favoritesOnly
            ? 'No favorited restaurants in your history yet.'
            : 'No restaurants in your history yet. Accept one from the coin flip to get started.'}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {displayIds.map((id) => {
          const restaurant = allRestaurants[id];
          if (!restaurant) return null;

          const isFavorited = favoriteSet.has(String(id));
          const reviews = currentUser.reviews[id] || [];
          const avgRating =
            reviews.length > 0
              ? reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length
              : restaurant.rating ?? 0;

          return (
            <div
              key={id}
              onClick={() => handleCardClick(id)}
              className="flex flex-col rounded-lg border border-gray-200 p-4 shadow-sm bg-white cursor-pointer transition-all duration-150 hover:shadow-md hover:border-indigo-300 hover:bg-indigo-50"
            >
              {/* Header */}
              <div className="flex justify-between items-start">
                <div className="min-w-0">
                  <span className="text-indigo-600 font-semibold">{restaurant.name}</span>
                  {getMostRecentDate(currentUser.accepted, id) && (
                    <span className="ml-2 text-xs text-gray-400 whitespace-nowrap">
                      Last chosen {getMostRecentDate(currentUser.accepted, id)}
                    </span>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    dispatch(updateUserFavorites({ restaurantId: id, userId: currentUser.id }));
                  }}
                  className={`text-xl leading-none ${isFavorited ? 'text-red-500' : 'text-gray-300 hover:text-red-300'}`}
                >
                  &#9829;
                </button>
              </div>

              <p className="text-sm text-gray-500 mt-1">
                {restaurant.type} · {PRICE_LABELS[restaurant.price]} · Opens {restaurant.hours}
              </p>

              <div className="flex items-center gap-1 mt-1">
                <StarRating rating={avgRating} />
                {reviews.length > 0 && (
                  <span className="text-xs text-gray-400 ml-1">
                    ({reviews.length} review{reviews.length !== 1 ? 's' : ''})
                  </span>
                )}
              </div>

              {/* Bottom section always anchored to card base */}
              <div className="mt-auto pt-3">
                <div className="flex items-center justify-between text-xs text-gray-500 min-h-[1.25rem]">
                  <div className="flex gap-2">
                    {restaurant.takeout && (
                      <span className="bg-gray-100 px-2 py-0.5 rounded">Takeout</span>
                    )}
                    {restaurant.delivery && (
                      <span className="bg-gray-100 px-2 py-0.5 rounded">Delivery</span>
                    )}
                  </div>
                  <span className="text-gray-400 italic">
                    Chosen {getChosenCount(currentUser.accepted, id)}×
                  </span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCardClick(id);
                  }}
                  className="mt-3 w-full rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500"
                >
                  Add Review
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {selectedRestaurantId && (
        <RestaurantReviewModal
          restaurant={allRestaurants[selectedRestaurantId]}
          reviews={currentUser.reviews[selectedRestaurantId] || []}
          onClose={() => setSelectedRestaurantId(null)}
          onAddReview={({ content, rating, date }) =>
            dispatch(
              addUserReview({
                restaurantId: selectedRestaurantId,
                userId: currentUser.id,
                content,
                rating,
                date,
              })
            )
          }
          onRemoveReview={(content) =>
            dispatch(
              removeUserReview({
                restaurantId: selectedRestaurantId,
                content,
                userId: currentUser.id,
              })
            )
          }
        />
      )}
    </div>
  );
};

export default UserHistoryPage;
