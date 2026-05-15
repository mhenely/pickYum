import { useState, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { persistAddReview, removeUserReview, updateUserFavorites, archiveRestaurant, unarchiveRestaurant, removeFromHistory, addUserOption } from '../redux/slices/userInfoSlice';
import RatingDisplay from '../components/RatingDisplay';
import RestaurantReviewModal from '../components/RestaurantReviewModal';
import RestaurantDetailModal from '../components/RestaurantDetailModal';
import useCurrentUser from '../hooks/useCurrentUser';
import { buildAcceptedStats, formatLastChosen, getChosenCount } from '../utils/acceptedStats';
import { PRICE_LABELS } from '../utils/restaurantConstants';

// ── Confirmation modal ────────────────────────────────────────

const ConfirmModal = ({ action, restaurantName, onConfirm, onCancel }) => (
  <Dialog open onClose={onCancel} className="relative z-50">
    <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
    <div className="fixed inset-0 flex items-center justify-center p-4">
      <DialogPanel className="w-full max-w-sm rounded-xl bg-white shadow-xl p-6">
        <DialogTitle className="text-base font-semibold text-gray-900 mb-2">
          {action === 'archive' ? 'Archive restaurant?' : action === 'delete' ? 'Remove from history?' : 'Restore restaurant?'}
        </DialogTitle>
        <p className="text-sm text-gray-500 mb-2">
          {action === 'archive'
            ? <><strong className="text-gray-700">{restaurantName}</strong> will be hidden from your history. You can restore it any time from the archive list.</>
            : action === 'delete'
            ? <><strong className="text-gray-700">{restaurantName}</strong> will be permanently removed — all accepted entries and reviews will be deleted.</>
            : <><strong className="text-gray-700">{restaurantName}</strong> will be moved back to your history.</>}
        </p>
        {action === 'delete' && (
          <p className="text-xs text-red-500 font-medium mb-4">This cannot be undone.</p>
        )}
        {action !== 'delete' && <div className="mb-4" />}
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors ${
              action === 'delete'
                ? 'bg-red-600 hover:bg-red-500'
                : action === 'archive'
                ? 'bg-gray-500 hover:bg-gray-600'
                : 'bg-orange-500 hover:bg-orange-500'
            }`}
          >
            {action === 'delete' ? 'Delete permanently' : action === 'archive' ? 'Archive' : 'Restore'}
          </button>
        </div>
      </DialogPanel>
    </div>
  </Dialog>
);

// ── Restaurant card ───────────────────────────────────────────

const RestaurantCard = ({ id, restaurant, currentUser, favoriteSet, acceptedStats, isArchived, isInOptions, note, onCardClick, onNameClick, onArchiveAction, dispatch }) => {
  const reviews = currentUser.reviews[id] || [];
  const personalRating =
    reviews.length > 0
      ? reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length
      : null;
  const isFavorited = favoriteSet.has(String(id));
  // O(1) lookup off the precomputed acceptedStats map instead of scanning
  // `currentUser.accepted` twice per row (legacy `getMostRecentDate` +
  // `getChosenCount`). Page-scope memo guarantees a stable map across renders.
  const lastChosen = formatLastChosen(acceptedStats, id);
  const chosenCount = getChosenCount(acceptedStats, id);

  return (
    <div
      onClick={() => !isArchived && onNameClick(id)}
      className={`flex flex-col rounded-lg border p-4 shadow-sm bg-white transition-all duration-150 ${
        isArchived
          ? 'border-gray-200 opacity-75'
          : 'border-gray-200 cursor-pointer hover:shadow-md hover:border-orange-300 hover:bg-orange-50'
      }`}
    >
      {/* Header */}
      <div className="flex justify-between items-start">
        <div className="min-w-0">
          <button
            onClick={(e) => { e.stopPropagation(); onNameClick(id); }}
            className={`font-semibold hover:underline text-left ${isArchived ? 'text-gray-500' : 'text-orange-600'}`}
          >
            {restaurant.name}
          </button>
          {lastChosen && (
            <span className="ml-2 text-xs text-gray-400 whitespace-nowrap">
              Last chosen {lastChosen}
            </span>
          )}
        </div>
        {!isArchived && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              dispatch(updateUserFavorites({ restaurantId: id, userId: currentUser.id }));
            }}
            className={`text-xl leading-none ${isFavorited ? 'text-red-500' : 'text-gray-300 hover:text-red-300'}`}
          >
            &#9829;
          </button>
        )}
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
          <span className="text-xs text-gray-400">
            ({reviews.length} review{reviews.length !== 1 ? 's' : ''})
          </span>
        )}
      </div>

      {note && (
        <p className="mt-2 text-xs text-amber-700 bg-amber-50 rounded px-2 py-1 line-clamp-2 italic">
          📝 {note}
        </p>
      )}

      {/* Bottom section */}
      <div className="mt-auto pt-3">
        <div className="flex items-center justify-between text-xs text-gray-500 min-h-[1.25rem]">
          <div className="flex gap-2">
            {restaurant.takeout && <span className="bg-gray-100 px-2 py-0.5 rounded">Takeout</span>}
            {restaurant.delivery && <span className="bg-gray-100 px-2 py-0.5 rounded">Delivery</span>}
          </div>
          <span className="text-gray-400 italic">Chosen {chosenCount}×</span>
        </div>

        <div className="flex gap-2 mt-3">
          {isArchived ? (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onArchiveAction('unarchive', id); }}
                className="flex-1 rounded-md bg-orange-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-orange-500"
              >
                Restore
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onArchiveAction('delete', id); }}
                className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-50 hover:border-red-300 transition-colors"
              >
                Delete
              </button>
            </>
          ) : (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onArchiveAction('archive', id); }}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-500 hover:bg-gray-50 hover:border-gray-400 transition-colors"
              >
                Archive
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onCardClick(id); }}
                className="flex-1 rounded-md bg-orange-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-orange-500"
              >
                Add Review
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onArchiveAction('delete', id); }}
                className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-50 hover:border-red-300 transition-colors"
              >
                Delete
              </button>
            </>
          )}
          {!isArchived && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!isInOptions) dispatch(addUserOption(id));
              }}
              disabled={isInOptions}
              className="rounded-md border border-orange-200 px-2 py-1 text-xs font-medium text-orange-500 hover:bg-orange-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isInOptions ? '✓ In options' : '+ Add to options'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Page ──────────────────────────────────────────────────────

const UserHistoryPage = () => {
  const currentUser = useCurrentUser();
  const dispatch = useDispatch();
  const customRestaurants = useSelector((state) => state.userInfo.customRestaurants);
  const allRestaurants = customRestaurants;

  const [selectedRestaurantId, setSelectedRestaurantId] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [sortBy, setSortBy] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [showArchives, setShowArchives] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null); // { type, id }

  const handleCardClick = (id) => setSelectedRestaurantId(id);

  const handleSortClick = (key) => {
    if (sortBy === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(key);
      setSortDir('desc');
    }
  };

  const handleArchiveAction = (type, id) => setConfirmAction({ type, id });

  const handleConfirm = () => {
    if (!confirmAction) return;
    const { type, id } = confirmAction;
    if (type === 'archive') dispatch(archiveRestaurant(id));
    else if (type === 'unarchive') dispatch(unarchiveRestaurant(id));
    else if (type === 'delete') dispatch(removeFromHistory(id));
    setConfirmAction(null);
  };

  // Heavy derivation block wrapped in a single useMemo. Every keystroke
  // into the search box, every modal toggle, every confirm-action change
  // used to rebuild every Set + array AND sort with a comparator that
  // scanned `currentUser.accepted` per comparison — O(N log N × M) per
  // render. Pulling derivation behind useMemo + an O(1) acceptedStats
  // lookup turns the same work into O(N) once per actual input change.
  const acceptedStats = useMemo(
    () => buildAcceptedStats(currentUser.accepted),
    [currentUser.accepted],
  );

  const { displayIds, displayArchivedIds, favoriteSet, optionSet } = useMemo(() => {
    const archivedSet = new Set((currentUser.archived ?? []).map(String));
    const optionSet   = new Set(currentUser.options.map(String));
    const favoriteSet = new Set(currentUser.favorites.map(String));

    // Unique restaurant IDs that appear in history (accepted + reviewed).
    const allHistoryIds = [
      ...new Set([
        ...currentUser.accepted.map((a) => String(a.restaurantId)),
        ...Object.keys(currentUser.reviews).filter((id) => currentUser.reviews[id].length > 0),
      ]),
    ];

    const activeIds   = allHistoryIds.filter((id) => !archivedSet.has(id));
    const archivedIds = allHistoryIds.filter((id) =>  archivedSet.has(id));

    const filteredIds = favoritesOnly
      ? activeIds.filter((id) => favoriteSet.has(id))
      : activeIds;

    // O(1) lookups instead of per-comparison full scans of `accepted`.
    const sortFn = (a, b) => {
      const entryA = acceptedStats.get(a);
      const entryB = acceptedStats.get(b);
      const valA = sortBy === 'date' ? (entryA?.lastTs ?? 0) : (entryA?.count ?? 0);
      const valB = sortBy === 'date' ? (entryB?.lastTs ?? 0) : (entryB?.count ?? 0);
      return sortDir === 'desc' ? valB - valA : valA - valB;
    };

    return {
      displayIds:         [...filteredIds].sort(sortFn),
      displayArchivedIds: [...archivedIds].sort(sortFn),
      favoriteSet,
      optionSet,
    };
  }, [
    currentUser.accepted, currentUser.archived, currentUser.options,
    currentUser.favorites, currentUser.reviews,
    favoritesOnly, sortBy, sortDir, acceptedStats,
  ]);

  const confirmRestaurantName = confirmAction
    ? (allRestaurants[confirmAction.id]?.name ?? 'this restaurant')
    : '';

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

        <button
          onClick={() => setShowArchives((s) => !s)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
            showArchives
              ? 'bg-amber-50 border-amber-300 text-amber-700'
              : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
          }`}
        >
          {showArchives ? 'Hide Archives' : 'Show Archives'}
          {displayArchivedIds.length > 0 && (
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-400 text-white text-[10px] font-bold leading-none">
              {displayArchivedIds.length}
            </span>
          )}
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
                  ? 'bg-orange-50 border-orange-200 text-orange-600'
                  : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
              }`}
            >
              {label}
              {sortBy === key && <span className="text-xs">{sortDir === 'desc' ? '↓' : '↑'}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ── Active history ────────────────────────────────────── */}
      {displayIds.length === 0 && (
        <p className="text-gray-500 text-sm mb-6">
          {favoritesOnly
            ? 'No favorited restaurants in your history yet.'
            : 'No restaurants in your history yet. Accept one from the coin flip to get started.'}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {displayIds.map((id) => {
          const restaurant = allRestaurants[id];
          if (!restaurant) return null;
          return (
            <RestaurantCard
              key={id}
              id={id}
              restaurant={restaurant}
              currentUser={currentUser}
              favoriteSet={favoriteSet}
              acceptedStats={acceptedStats}
              isArchived={false}
              isInOptions={optionSet.has(String(id))}
              note={currentUser.notes?.[String(id)] ?? null}
              onCardClick={handleCardClick}
              onNameClick={setDetailId}
              onArchiveAction={handleArchiveAction}
              dispatch={dispatch}
            />
          );
        })}
      </div>

      {/* ── Archive list ──────────────────────────────────────── */}
      {showArchives && (
        <div className="mt-10">
          <div className="flex items-center gap-3 mb-4">
            <h3 className="text-lg font-semibold text-gray-700">Archived</h3>
            <span className="text-sm text-gray-400">
              {displayArchivedIds.length} restaurant{displayArchivedIds.length !== 1 ? 's' : ''}
            </span>
          </div>

          {displayArchivedIds.length === 0 ? (
            <p className="text-sm text-gray-400 italic">No archived restaurants.</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {displayArchivedIds.map((id) => {
                const restaurant = allRestaurants[id];
                if (!restaurant) return null;
                return (
                  <RestaurantCard
                    key={id}
                    id={id}
                    restaurant={restaurant}
                    currentUser={currentUser}
                    favoriteSet={favoriteSet}
              acceptedStats={acceptedStats}
                    isArchived={true}
                    isInOptions={false}
                    note={currentUser.notes?.[String(id)] ?? null}
                    onCardClick={handleCardClick}
                    onArchiveAction={handleArchiveAction}
                    dispatch={dispatch}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Review modal ──────────────────────────────────────── */}
      {selectedRestaurantId && (
        <RestaurantReviewModal
          restaurant={allRestaurants[selectedRestaurantId]}
          reviews={currentUser.reviews[selectedRestaurantId] || []}
          onClose={() => setSelectedRestaurantId(null)}
          onAddReview={({ content, rating, date }) =>
            dispatch(persistAddReview({
              restaurantId: selectedRestaurantId,
              userId: currentUser.id,
              content,
              rating,
              date,
            }))
          }
          onRemoveReview={(id) =>
            dispatch(removeUserReview({
              restaurantId: selectedRestaurantId,
              id,
              userId: currentUser.id,
            }))
          }
        />
      )}

      {/* ── Detail modal ──────────────────────────────────────── */}
      {detailId && (
        <RestaurantDetailModal
          restaurantId={detailId}
          restaurantMap={allRestaurants}
          onClose={() => setDetailId(null)}
        />
      )}

      {/* ── Confirmation modal ────────────────────────────────── */}
      {confirmAction && (
        <ConfirmModal
          action={confirmAction.type}
          restaurantName={confirmRestaurantName}
          onConfirm={handleConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
};

export default UserHistoryPage;
