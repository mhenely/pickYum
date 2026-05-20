import { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  const [confirmAction, setConfirmAction] = useState(null); // { type, id }

  // Bulk select-mode state. Toggling "Select" exits the detail-modal-on-click
  // flow and turns card clicks into checkbox toggles. The bulk-action bar
  // (rendered above the grid) reads `selectedIds` to enable archive /
  // unarchive / delete in batch.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkConfirm, setBulkConfirm] = useState(null); // null | 'archive' | 'unarchive' | 'delete'

  const toggleSelectMode = () => {
    setSelectMode((s) => {
      if (s) setSelectedIds(new Set()); // exiting select-mode clears the selection
      return !s;
    });
  };

  const toggleSelection = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else               next.add(key);
      return next;
    });
  };

  // URL-backed UI state — sort/filter/archive-toggle survive reload and
  // are shareable as part of the URL. Only non-default values are written
  // to the query string so the bare `/History/:id` URL stays clean.
  //   ?sort=count          (default 'date' = omitted)
  //   ?dir=asc             (default 'desc' = omitted)
  //   ?fav=1               (default off = omitted)
  //   ?archives=1          (default off = omitted)
  const [searchParams, setSearchParams] = useSearchParams();
  const sortBy        = searchParams.get('sort') === 'count' ? 'count' : 'date';
  const sortDir       = searchParams.get('dir')  === 'asc'   ? 'asc'   : 'desc';
  const favoritesOnly = searchParams.get('fav')      === '1';
  const showArchives  = searchParams.get('archives') === '1';

  // Falsy / empty values delete the param so the URL stays minimal.
  // `replace: true` so toggling sort doesn't fill the back-button history.
  const updateUrl = (changes) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(changes)) {
        if (!v) next.delete(k);
        else    next.set(k, v);
      }
      return next;
    }, { replace: true });
  };

  const openDetail      = (id) => setModalState({ id, defaultWriteReview: false });
  const openAddReview   = (id) => setModalState({ id, defaultWriteReview: true });

  const handleSortClick = (key) => {
    if (sortBy === key) {
      updateUrl({ dir: sortDir === 'desc' ? 'asc' : '' });
    } else {
      updateUrl({ sort: key === 'date' ? '' : key, dir: '' });
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

  // Bulk handlers — applied to every id in selectedIds. Each dispatch is
  // routed through the existing per-item action so all the slice
  // bookkeeping (favorites cleanup, reviews preservation, etc.) is
  // identical to single-row operations. After the action the selection
  // clears and select-mode exits so the user lands in a clean state.
  const runBulk = (type) => {
    const ids = [...selectedIds];
    for (const id of ids) {
      if      (type === 'archive')   dispatch(archiveRestaurant(id));
      else if (type === 'unarchive') dispatch(unarchiveRestaurant(id));
      else if (type === 'delete')    dispatch(removeFromHistory(id));
    }
    setBulkConfirm(null);
    setSelectedIds(new Set());
    setSelectMode(false);
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
          onClick={() => updateUrl({ fav: favoritesOnly ? '' : '1' })}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
            favoritesOnly
              ? 'bg-red-50 border-red-200 text-red-600'
              : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
          }`}
        >
          <span>&#9829;</span> Favorites
        </button>

        <button
          onClick={() => updateUrl({ archives: showArchives ? '' : '1' })}
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

        {/* Select toggle — turns card clicks into checkbox toggles so the
            user can archive / unarchive / delete multiple entries in
            one pass. Hidden in the controls bar by default; the bulk-
            action bar below surfaces when selectMode is active. */}
        <button
          onClick={toggleSelectMode}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
            selectMode
              ? 'bg-orange-50 border-orange-200 text-orange-600'
              : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
          }`}
        >
          {selectMode ? 'Done selecting' : 'Select'}
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

      {/* Bulk-action bar — appears whenever selectMode is on. When nothing
          is selected, it nudges the user with the help copy; once they've
          picked something, the action buttons activate. Active vs archived
          context is computed from each selected id so both modes (archive
          active items / unarchive archived items) work in the same UI. */}
      {selectMode && (() => {
        const archivedSet = new Set((currentUser.archived ?? []).map(String));
        const ids = [...selectedIds];
        const activeCount   = ids.filter((id) => !archivedSet.has(id)).length;
        const archivedCount = ids.filter((id) =>  archivedSet.has(id)).length;
        return (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm flex-wrap">
            <span className="text-orange-700 font-semibold">
              {ids.length === 0 ? 'Select cards to bulk-edit' : `${ids.length} selected`}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {activeCount > 0 && (
                <button
                  onClick={() => runBulk('archive')}
                  className="rounded-md bg-white border border-amber-300 px-3 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-50"
                >
                  Archive ({activeCount})
                </button>
              )}
              {archivedCount > 0 && (
                <button
                  onClick={() => runBulk('unarchive')}
                  className="rounded-md bg-white border border-gray-300 px-3 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                >
                  Unarchive ({archivedCount})
                </button>
              )}
              <button
                disabled={ids.length === 0}
                onClick={() => setBulkConfirm('delete')}
                className="rounded-md bg-white border border-red-300 px-3 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Delete ({ids.length})
              </button>
              <button
                onClick={() => { setSelectedIds(new Set()); setSelectMode(false); }}
                className="text-xs text-gray-500 hover:text-gray-700 ml-1"
              >
                Cancel
              </button>
            </div>
          </div>
        );
      })()}

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
          const reviewCount = currentUser.reviews[String(id)]?.length ?? 0;
          const isSelected = selectedIds.has(String(id));
          // In select-mode the card click toggles selection instead of
          // opening the detail modal. A ring highlight + checkbox dot in
          // the corner signal which cards are currently picked up.
          return (
            <div
              key={id}
              className={selectMode && isSelected
                ? 'ring-2 ring-orange-500 rounded-2xl transition-shadow'
                : selectMode
                  ? 'ring-1 ring-transparent rounded-2xl transition-shadow'
                  : ''}
            >
              <RestaurantCard
                id={id}
                size="md"
                restaurantMap={allRestaurants}
                personalRating={personalRating}
                lastChosen={formatLastChosen(acceptedStats, id)}
                onCardClick={selectMode ? () => toggleSelection(id) : () => openDetail(id)}
                cornerSlot={(
                  <div className="inline-flex items-center gap-1 shrink-0">
                    {selectMode && (
                      <span
                        className={`inline-flex items-center justify-center h-5 w-5 rounded-full border text-xs font-bold ${
                          isSelected
                            ? 'bg-orange-500 border-orange-500 text-white'
                            : 'bg-white border-gray-300 text-transparent'
                        }`}
                        aria-hidden="true"
                      >
                        ✓
                      </span>
                    )}
                    <HeartWithKebab restaurantId={id} size="md" />
                    {showInsightsKebab && <HistoryRowKebab restaurantId={id} size="md" />}
                  </div>
                )}
              >
                {/* Hide the Add Review CTA while in select-mode so click
                    target collisions don't accidentally open the modal. */}
                {!selectMode && (
                  <button
                    onClick={(e) => { e.stopPropagation(); openAddReview(id); }}
                    className="mt-2 w-full rounded-lg text-xs bg-gradient-to-br from-orange-500 to-red-500 text-white py-1.5 hover:from-orange-400 hover:to-red-400 transition-all shadow-brand-sm"
                  >
                    {reviewCount > 0
                      ? `+ Add Review · ${reviewCount} written`
                      : '+ Add Review'}
                  </button>
                )}
              </RestaurantCard>
            </div>
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
                const isSelected = selectedIds.has(String(id));
                return (
                  <div
                    key={id}
                    className={selectMode && isSelected
                      ? 'ring-2 ring-orange-500 rounded-2xl transition-shadow'
                      : selectMode
                        ? 'ring-1 ring-transparent rounded-2xl transition-shadow'
                        : ''}
                  >
                    <RestaurantCard
                      id={id}
                      size="md"
                      restaurantMap={allRestaurants}
                      personalRating={personalRating}
                      lastChosen={formatLastChosen(acceptedStats, id)}
                      // In select-mode click toggles selection; otherwise
                      // archived rows open the modal for Restore / Remove.
                      onCardClick={selectMode ? () => toggleSelection(id) : () => openDetail(id)}
                      cornerSlot={selectMode ? (
                        <span
                          className={`inline-flex items-center justify-center h-5 w-5 rounded-full border text-xs font-bold ${
                            isSelected
                              ? 'bg-orange-500 border-orange-500 text-white'
                              : 'bg-white border-gray-300 text-transparent'
                          }`}
                          aria-hidden="true"
                        >
                          ✓
                        </span>
                      ) : undefined}
                    />
                  </div>
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

      {/* Bulk-delete confirmation — irreversible, so an explicit step is
          required. Bulk archive/unarchive skip this since they're
          undo-able from the same page. */}
      {bulkConfirm === 'delete' && (
        <Dialog open onClose={() => setBulkConfirm(null)} className="relative z-50">
          <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
          <div className="fixed inset-0 flex items-center justify-center p-4">
            <DialogPanel className="w-full max-w-sm rounded-xl bg-white shadow-xl p-6">
              <DialogTitle className="text-base font-semibold text-gray-900 mb-2">
                Remove {selectedIds.size} from history?
              </DialogTitle>
              <p className="text-sm text-gray-500 mb-2">
                All accepted entries and reviews for these restaurants will be deleted.
              </p>
              <p className="text-xs text-red-500 font-medium mb-4">This cannot be undone.</p>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setBulkConfirm(null)}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => runBulk('delete')}
                  className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-red-600 hover:bg-red-500 transition-colors"
                >
                  Remove {selectedIds.size}
                </button>
              </div>
            </DialogPanel>
          </div>
        </Dialog>
      )}
    </div>
  );
};

export default UserHistoryPage;
