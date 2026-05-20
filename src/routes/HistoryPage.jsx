import { useState, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { archiveRestaurant, unarchiveRestaurant, removeFromHistory } from '../redux/slices/userInfoSlice';
import RestaurantCard from '../components/RestaurantCard';
import HeartWithKebab from '../components/HeartWithKebab';
import HistoryRowKebab from '../components/HistoryRowKebab';
import { useFlag } from '../hooks/useFlag';
import RestaurantDetailModal from '../components/RestaurantDetailModal';
import useCurrentUser from '../hooks/useCurrentUser';
import { buildAcceptedStats, formatLastChosen } from '../utils/acceptedStats';
import { SkeletonList } from '../components/Skeleton';
import SectionEmpty from '../components/SectionEmpty';

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

// Per-user average across all of a user's reviews for one restaurant.
// Pulled to module scope so the page body can reuse it inline without
// recomputing in every render and without the legacy local-card
// component to encapsulate it.
const getUserAvgRating = (reviewsById, id) => {
  const list = reviewsById[id] || [];
  if (list.length === 0) return null;
  return list.reduce((sum, r) => sum + Number(r.rating), 0) / list.length;
};

// ── Page ──────────────────────────────────────────────────────
// History rows now use the shared md-size RestaurantCard (same
// visual as nearby search results) for cross-page consistency.
// What this page used to render as a local card — photos, ratings,
// hours, contact info — is all in the shared card already; what
// USED to live on the card (Archive / Delete buttons + Add Review)
// is now consolidated into the popup detail modal so the card
// stays clean and the destructive actions sit behind an explicit
// open-modal-and-confirm flow.

const UserHistoryPage = () => {
  const currentUser = useCurrentUser();
  const dispatch = useDispatch();
  const customRestaurants = useSelector((state) => state.userInfo.customRestaurants);
  const allRestaurants = customRestaurants;
  // While the initial /me/all fetch is in flight, distinguish "empty
  // history" from "still loading" — without this we'd flash the empty
  // copy ("No restaurants in your history yet…") for a beat before the
  // real data arrives. isDataLoaded flips true once loadUserData's
  // thunk resolves.
  const isDataLoaded = useSelector((state) => state.userInfo.isDataLoaded);
  // Flag-gated kill switch — see server/src/lib/flags.ts. Default true,
  // flipped to false via FLAG_INSIGHTS_OPT_OUT_VISIBLE=false if the
  // toggle ever exposes a bug we need to suppress without a redeploy
  // of the React bundle.
  const showInsightsKebab = useFlag('insightsOptOutVisible');

  // Single modal-open state: `{ id, defaultWriteReview }` (or null).
  // The detail modal serves both flows now — generic detail view (card
  // body click → defaultWriteReview=false) and "Add Review" (button
  // click → defaultWriteReview=true, lands the user directly in the
  // write-review form). Replaces the previous split between
  // RestaurantReviewModal and RestaurantDetailModal.
  const [modalState, setModalState] = useState(null);
  const [sortBy, setSortBy] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [showArchives, setShowArchives] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null); // { type, id }

  const openDetail      = (id) => setModalState({ id, defaultWriteReview: false });
  const openAddReview   = (id) => setModalState({ id, defaultWriteReview: true });

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

  const { displayIds, displayArchivedIds } = useMemo(() => {
    const archivedSet = new Set((currentUser.archived ?? []).map(String));
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
    };
  }, [
    currentUser.accepted, currentUser.archived,
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
      {/* While loadUserData is still in flight, show a skeleton grid
          instead of flashing the "empty history" copy for a beat. Once
          isDataLoaded flips true we render either the empty state or the
          real card grid below. */}
      {!isDataLoaded && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-6">
          <SkeletonList count={6} />
        </div>
      )}
      {isDataLoaded && displayIds.length === 0 && (
        <div className="mb-6">
          <SectionEmpty
            icon={favoritesOnly ? '❤️' : '🍽'}
            title={favoritesOnly
              ? 'No favorited restaurants in your history yet'
              : 'No restaurants in your history yet'}
            subtitle={favoritesOnly
              ? 'Toggle Favorites off to see everything you\'ve picked.'
              : 'Accept one from the coin flip to get started.'}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {displayIds.map((id) => {
          const restaurant = allRestaurants[id];
          if (!restaurant) return null;
          const personalRating = getUserAvgRating(currentUser.reviews, id);
          return (
            <RestaurantCard
              key={id}
              id={id}
              size="md"
              restaurantMap={allRestaurants}
              personalRating={personalRating}
              lastChosen={formatLastChosen(acceptedStats, id)}
              // Whole-card click opens the detail modal (read view).
              // Heart toggle + multi-list kebab via HeartWithKebab —
              // same component the other favoriting surfaces use, so
              // a user can favorite / move-between-lists from history
              // without bouncing through the modal. <HistoryRowKebab>
              // sits beside it for the HistoryPage-only "exclude from
              // insights" toggle; kept as a separate component so the
              // shared HeartWithKebab metaphor (list management only)
              // stays uncluttered across the other surfaces that use it.
              onCardClick={() => openDetail(id)}
              cornerSlot={(
                <div className="inline-flex items-center gap-1 shrink-0">
                  <HeartWithKebab restaurantId={id} size="md" />
                  {showInsightsKebab && <HistoryRowKebab restaurantId={id} size="md" />}
                </div>
              )}
            >
              {/* "Add Review" bottom action — opens the detail modal
                  with the write-review form pre-expanded. Archive /
                  Delete used to also live here; they moved into the
                  modal so the card stays focused on a single
                  primary action. */}
              <button
                onClick={(e) => { e.stopPropagation(); openAddReview(id); }}
                className="mt-2 w-full rounded-lg text-xs bg-gradient-to-br from-orange-500 to-red-500 text-white py-1.5 hover:from-orange-400 hover:to-red-400 transition-all shadow-brand-sm"
              >
                + Add Review
              </button>
            </RestaurantCard>
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
                const personalRating = getUserAvgRating(currentUser.reviews, id);
                return (
                  <RestaurantCard
                    key={id}
                    id={id}
                    size="md"
                    restaurantMap={allRestaurants}
                    personalRating={personalRating}
                    lastChosen={formatLastChosen(acceptedStats, id)}
                    // Archived rows open the modal for Restore /
                    // Remove; no inline action button — those
                    // operations live exclusively in the modal now.
                    onCardClick={() => openDetail(id)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Detail modal ──────────────────────────────────────── */}
      {/*  Single modal serves three flows:
            - generic card click → read view
            - "Add Review" button → defaultShowReviewForm=true
            - archived row → isArchived=true exposes Restore + Remove
              instead of Archive
          handleArchiveAction routes through ConfirmModal so the
          destructive ops still require an explicit confirmation
          step before dispatch lands. */}
      {modalState && (() => {
        const id = modalState.id;
        const archived = (currentUser.archived ?? []).map(String).includes(String(id));
        return (
          <RestaurantDetailModal
            restaurantId={id}
            restaurantMap={allRestaurants}
            onClose={() => setModalState(null)}
            defaultShowReviewForm={modalState.defaultWriteReview}
            isArchived={archived}
            onArchive={archived ? undefined : () => handleArchiveAction('archive', id)}
            onUnarchive={archived ? () => handleArchiveAction('unarchive', id) : undefined}
            onDelete={() => handleArchiveAction('delete', id)}
          />
        );
      })()}

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
