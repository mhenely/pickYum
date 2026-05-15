import { useState, useRef, useEffect, useMemo, useCallback, lazy, Suspense } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useParams } from "react-router-dom";
import {
  addUserAcceptance,
  addUserOption,
  removeUserOption,
  updateUserFavorites,
} from "../redux/slices/userInfoSlice";
import { showChosenCelebration } from "../redux/slices/celebrationSlice";
import RestaurantCard from "../components/RestaurantCard";
import HeartWithKebab from "../components/HeartWithKebab";
import ListSelector from "../components/ListSelector";
import useCurrentUser from "../hooks/useCurrentUser";
import { useScrollListIndex } from "../hooks/useScrollListIndex";
import { buildAcceptedStats, formatLastChosen } from "../utils/acceptedStats";
import {
  allLists as selectAllLists,
  defaultList as selectDefaultList,
  readActiveListIds,
  writeActiveListIds,
} from "../utils/favoriteLists";
// PRICE_LABELS was previously consumed by the inline ChosenModal
// in this file; that modal has been replaced by the global
// <ChosenCelebration/> component (it pulls PRICE_LABELS itself),
// so this page no longer needs the import.
import RestaurantDetailModal, { RestaurantDetailPanel } from "../components/RestaurantDetailModal";
// Lazy: the maps chunk (~13 KB gzip via vendor-maps) loads only when the
// CompareMap is actually rendered — on most visits to this page the user
// is comparing without the map open, so the chunk stays out of the cold-
// load critical path.
const CompareMap = lazy(() => import("../components/CompareMap"));

// ── Helpers ───────────────────────────────────────────────────

const sid  = (id) => String(id);
const mean = (nums) => nums.reduce((a, b) => a + b, 0) / nums.length;

const getUserRating = (reviews, id) => {
  const list = reviews[sid(id)];
  return list?.length ? mean(list.map((r) => r.rating)) : null;
};

// Action row for the inline RestaurantDetailPanel — replaces what
// used to be the bottom buttons of the legacy DetailPanel. The
// readOnly modal body hides its built-in Add/Favorite buttons, so we
// pass this through `actions` to keep Compare-page-specific controls
// available: a green "Choose Now" CTA and a Favorite heart toggle.
const ComparePanelActions = ({ isFavorite, onChooseNow, onToggleFavorite }) => (
  <>
    <button
      onClick={onChooseNow}
      className="flex-1 rounded-lg py-2 text-sm font-semibold bg-green-600 text-white hover:bg-green-500 transition-colors"
    >
      Choose Now
    </button>
    <button
      onClick={onToggleFavorite}
      className={[
        'flex-1 rounded-lg py-2 text-sm font-semibold border transition-colors',
        isFavorite
          ? 'bg-red-50 text-red-600 hover:bg-red-100 border-red-200'
          : 'bg-white text-gray-600 hover:bg-gray-50 border-gray-200',
      ].join(' ')}
    >
      {isFavorite ? '♥ Unfavorite' : '♡ Favorite'}
    </button>
  </>
);

// The local DetailPanel that used to live here was replaced by
// RestaurantDetailPanel (the inline mode of RestaurantDetailModal).
// Same visual content as the popup detail modal but rendered as a
// grid cell on the Compare page instead of a centered Dialog.

// The page-local ChosenModal that used to live here was replaced by
// the global <ChosenCelebration/> mounted in App.tsx. handleChooseNow
// now dispatches showChosenCelebration() and that single shared
// modal handles the "Tonight you're going to…" feedback for every
// Choose-Now surface in the app.

const MAX_COMPARE = 4;

// Compare-grid is ALWAYS 2 panels per row at sm+ — so every panel has the
// same visual size regardless of how many are active. Odd counts (1 or 3)
// produce one empty cell which the caller fills with a "+ add another"
// placeholder (see the JSX below). This keeps cards stable as the user
// adds/removes — no resizing as the count changes.
const COMPARE_GRID_CLASS = 'grid-cols-1 sm:grid-cols-2';

// ── Page ─────────────────────────────────────────────────────

const RestaurantPage = () => {
  const { restaurantId } = useParams();
  const dispatch = useDispatch();
  const userInfo = useCurrentUser();
  const customRestaurants = useSelector((state) => state.userInfo.customRestaurants);
  const allRestaurants = customRestaurants;
  const { options, reviews } = userInfo;

  // ── Active favorite lists (Compare-page-scoped) ───────────────
  // Multi-select: the favorites sidebar renders the UNION of every
  // checked list's entries. First-load default is [defaultId]
  // (mirrors the pre-multi-select behavior). Selection persists in
  // sessionStorage per page so each surface (Search / Compare /
  // Choose) remembers its own checkboxes independently.
  const allFavoriteLists    = useSelector(selectAllLists);
  const defaultFavoriteList = useSelector(selectDefaultList);
  const [activeListIds, setActiveListIdsState] = useState(() => readActiveListIds('compare'));
  useEffect(() => {
    if (activeListIds == null && defaultFavoriteList?.id) {
      const next = [defaultFavoriteList.id];
      setActiveListIdsState(next);
      writeActiveListIds('compare', next);
    }
  }, [activeListIds, defaultFavoriteList?.id]);
  const setActiveListIds = useCallback((next) => {
    setActiveListIdsState(next);
    writeActiveListIds('compare', next);
  }, []);

  // Sticky pin for the in-progress kebab interaction. While a card's
  // HeartWithKebab picker is open we keep that card visible in the
  // sidebar regardless of whether it still belongs to the active
  // list — otherwise unchecking the card's last list inside the
  // picker would immediately remove the card from view, preventing
  // the user from then checking a different list to move it. The
  // pin clears on picker close, after which the sidebar re-filters
  // and the card disappears if it's no longer in the active list.
  const [stickyFavId, setStickyFavId] = useState(null);
  const handlePickerOpen  = useCallback((id) => setStickyFavId(String(id)), []);
  const handlePickerClose = useCallback((id) => {
    setStickyFavId((prev) => (prev === String(id) ? null : prev));
  }, []);

  // Resolve the favorites list shown in the sidebar as the deduped
  // UNION of every selected list's entries. `activeListIds` is null
  // before the first-hydrate seeding lands — in that window we fall
  // back to the legacy users[0].favorites array so the sidebar is
  // never empty during a page load.
  const favorites = useMemo(() => {
    let base;
    if (activeListIds == null) {
      base = (userInfo.favorites ?? []).map(String);
    } else if (activeListIds.length === 0) {
      base = [];
    } else {
      const selected = new Set(activeListIds);
      const seen = new Set();
      for (const list of allFavoriteLists) {
        if (!selected.has(list.id)) continue;
        for (const entry of list.entries) seen.add(String(entry.restaurantId));
      }
      base = [...seen];
    }
    // Pin the in-progress card so unchecking its last list mid-edit
    // doesn't yank it out of view before the user can move it.
    if (stickyFavId && !base.includes(stickyFavId)) base = [...base, stickyFavId];
    return base;
  }, [activeListIds, allFavoriteLists, userInfo.favorites, stickyFavId]);

  // O(1) lookup for "is this favorite already in the options list?" —
  // drives the "+ Add to Options" vs "✓ In Options" state on each
  // favorite card without re-scanning the options array per row.
  const optionsSet = useMemo(() => new Set(options.map(sid)), [options]);

  // Precompute the user's accepted-history stats once per `accepted` change.
  // Four card sites below used to call `getMostRecentDate` per render, each
  // scanning the full accepted array; with stats memoized, lookups are O(1).
  const acceptedStats = useMemo(
    () => buildAcceptedStats(userInfo.accepted),
    [userInfo.accepted],
  );

  const [activeIds, setActiveIds] = useState(
    restaurantId ? [restaurantId] : []
  );
  // chosenId state previously gated the inline ChosenModal; that
  // modal is now the global <ChosenCelebration/> driven by Redux,
  // so the local state is gone.
  const [detailId, setDetailId] = useState(null);

  // Two-way card↔marker hover sync. Same pattern as SearchPage — one
  // piece of state drives "which pin glows" AND "which card is ringed".
  // Local because it's purely visual ephemera.
  const [hoveredCompareId, setHoveredCompareId] = useState(null);

  // Refs + scroll-position trackers for the desktop favorites and
  // options sidebars so we can render a "3 / 7"-style position
  // indicator next to each label. Favorites uses the rtl/ltr wrapper
  // (scrollbar on left), so its cards live one level deeper than the
  // scroll container; options is single-level so its cards are
  // direct children. The hook's getItems argument bridges the two
  // layouts.
  const favScrollRef = useRef(null);
  const optScrollRef = useRef(null);
  const favActiveIdx = useScrollListIndex(
    favScrollRef,
    favorites.length,
    (c) => c.firstElementChild?.children,
  );
  // Default getItems (= direct children) covers the options layout —
  // cards are immediate children of optScrollRef. Hook ref-pins
  // getItems internally so stable identity is no longer a footgun.
  const optActiveIdx = useScrollListIndex(
    optScrollRef,
    options.length,
  );

  // Keep `activeIds` in lock-step with the options list. `handleRemoveOption`
  // below only catches the in-page X button on the sidebar card; options
  // can ALSO be removed via the navbar Options chip strip and the detail
  // modal's "Remove from options" action — neither of which know about
  // this page's local state. This effect detects items disappearing from
  // options (by diffing against the previous render) and prunes them from
  // the active comparison.
  //
  // Critically, it only fires on REMOVALS — not on initial mount and not
  // on additions. That preserves the URL-load case (e.g. /restaurant/123
  // where 123 is in `accepted` history but not in `options`): the
  // restaurant stays in the comparison until the user explicitly
  // dismisses it.
  const prevOptionsRef = useRef(options);
  useEffect(() => {
    const prev = prevOptionsRef.current;
    const next = options;
    prevOptionsRef.current = next;

    const nextSet = new Set(next.map(String));
    const removed = prev.filter((id) => !nextSet.has(String(id)));
    if (removed.length === 0) return;

    const removedSet = new Set(removed.map(String));
    setActiveIds((curr) => {
      const filtered = curr.filter((id) => !removedSet.has(String(id)));
      return filtered.length === curr.length ? curr : filtered;
    });
  }, [options]);

  // Map-ready item list. The displayed set narrows by comparison state:
  //   - No restaurants in the comparison → show ALL options (default view).
  //     Favorites are intentionally omitted — they're a "to consider" list,
  //     not the primary comparison set; including them clutters the map
  //     before the user has even started comparing.
  //   - One or more restaurants in the comparison → show ONLY those
  //     restaurants. This narrows the map to the spatial question the
  //     user is currently asking: "where do these specific places sit?"
  //
  // Items without lat/lng are silently dropped from the map; their cards
  // in the sidebars still appear, just without a pin.
  const compareMapItems = useMemo(() => {
    const sourceIds = activeIds.length > 0 ? activeIds : options;
    const items = [];
    for (const id of sourceIds) {
      const sid_ = String(id);
      const r = customRestaurants[sid_];
      if (!r || r.lat == null || r.lng == null) continue;
      // When viewing the active comparison set we still tag the item as
      // 'option' since that's its sidebar origin; the kind tag drives
      // pin color, and orange-on-comparison reads cleaner than mixing
      // palettes.
      items.push({ id: sid_, name: r.name, lat: r.lat, lng: r.lng, kind: 'option' });
    }
    return items;
  }, [activeIds, options, customRestaurants]);

  // ── Mobile swipe state ────────────────────────────────────
  const [mobileIndex, setMobileIndex] = useState(0);
  const [mobileAddOpen, setMobileAddOpen] = useState(false);
  const touchStartX = useRef(null);
  const touchStartY = useRef(null);

  // Clamp mobileIndex whenever activeIds shrinks
  useEffect(() => {
    if (activeIds.length === 0) {
      setMobileIndex(0);
    } else {
      setMobileIndex((prev) => Math.min(prev, activeIds.length - 1));
    }
  }, [activeIds.length]);

  const handleTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e) => {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 48) {
      if (dx < 0) setMobileIndex((i) => Math.min(i + 1, activeIds.length - 1));
      else        setMobileIndex((i) => Math.max(i - 1, 0));
    }
    touchStartX.current = null;
    touchStartY.current = null;
  };

  // ── Shared handlers ───────────────────────────────────────
  const handleCardClick = (id) => {
    setActiveIds((prev) => {
      const key = sid(id);
      if (prev.map(sid).includes(key)) {
        const next = prev.filter((x) => sid(x) !== key);
        setMobileIndex((mi) => Math.min(mi, Math.max(0, next.length - 1)));
        return next;
      }
      if (prev.length >= MAX_COMPARE) return prev;
      const next = [...prev, id];
      setMobileIndex(next.length - 1);
      return next;
    });
  };

  const handleDismiss = (id) =>
    setActiveIds((prev) => prev.filter((x) => sid(x) !== sid(id)));

  // Combine "remove from options" with "drop from active comparison". The
  // raw `removeUserOption` dispatch only updates the user's options list
  // — without this wrapper, a restaurant that's currently being compared
  // stayed in the comparison body after its X was clicked. Now removing
  // from the options sidebar (mobile or desktop) syncs both at once.
  const handleRemoveOption = (id) => {
    dispatch(removeUserOption(id));
    setActiveIds((prev) => prev.filter((x) => sid(x) !== sid(id)));
  };

  const handleChooseNow = (id) => {
    // Direct accept from the restaurant page — the active list at this moment
    // was the user's consideration set (everything currently in `activeIds`).
    dispatch(addUserAcceptance({
      restaurantId: id,
      optionsSnapshot: activeIds.map(String),
      chooseMethod: 'direct',
    }));
    dispatch(removeUserOption(id));
    // Pop the shared global celebration instead of the page-local
    // ChosenModal — keeps post-Choose-Now UX consistent with every
    // other surface that fires Choose Now (detail modal, future
    // coin-flip / roulette winners).
    dispatch(showChosenCelebration(id));
  };

  const activeSet = new Set(activeIds.map(sid));
  const mobileCurrentId = activeIds[mobileIndex] ?? null;

  return (
    <>
    <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">

      {/* ── MOBILE LAYOUT (< md) ───────────────────────────── */}
      <div className="md:hidden">

        {/* Active panel area */}
        {activeIds.length > 0 ? (
          <>
            {/* Chip strip — tap to jump to a panel */}
            <div className="flex items-center gap-2 mb-3 overflow-x-auto pb-1 no-scrollbar">
              {activeIds.map((id, i) => (
                <button
                  key={id}
                  onClick={() => setMobileIndex(i)}
                  className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold border transition-colors ${
                    i === mobileIndex
                      ? 'bg-orange-500 text-white border-orange-500'
                      : 'bg-white text-gray-600 border-gray-200 hover:border-orange-300'
                  }`}
                >
                  {allRestaurants[id]?.name ?? id}
                </button>
              ))}
              <button
                onClick={() => setActiveIds([])}
                className="shrink-0 text-xs text-gray-400 hover:text-red-400 transition-colors ml-1 whitespace-nowrap"
              >
                Clear all
              </button>
            </div>

            {/* Swipeable panel */}
            <div
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
              className="relative touch-pan-y"
            >
              {mobileCurrentId && (
                <div className="relative">
                  <button
                    onClick={() => handleDismiss(mobileCurrentId)}
                    className="absolute -top-2 -right-2 z-10 w-6 h-6 flex items-center justify-center rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500 text-xs font-bold shadow-sm transition-colors"
                    aria-label="Dismiss"
                  >
                    ✕
                  </button>
                  {/* RestaurantDetailPanel = the modal body rendered
                      inline (no Dialog wrapper). readOnly hides the
                      modal's built-in write actions; we pass a
                      Compare-specific Choose-Now + Favorite pair
                      through `actions`. Dismiss lives outside the
                      panel as the X-overhang button above. */}
                  <RestaurantDetailPanel
                    restaurantId={mobileCurrentId}
                    restaurantMap={allRestaurants}
                    readOnly
                    actions={(
                      <ComparePanelActions
                        isFavorite={userInfo.favorites.map(sid).includes(sid(mobileCurrentId))}
                        onChooseNow={() => handleChooseNow(mobileCurrentId)}
                        onToggleFavorite={() =>
                          dispatch(updateUserFavorites({ restaurantId: mobileCurrentId, userId: userInfo.id }))
                        }
                      />
                    )}
                  />
                </div>
              )}

              {/* Prev / counter / next */}
              {activeIds.length > 1 && (
                <div className="flex justify-between items-center mt-3 px-1">
                  <button
                    onClick={() => setMobileIndex((i) => Math.max(i - 1, 0))}
                    disabled={mobileIndex === 0}
                    className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-30 transition-colors"
                  >
                    ← Prev
                  </button>
                  <span className="text-xs text-gray-400 font-medium">
                    {mobileIndex + 1} / {activeIds.length}
                  </span>
                  <button
                    onClick={() => setMobileIndex((i) => Math.min(i + 1, activeIds.length - 1))}
                    disabled={mobileIndex === activeIds.length - 1}
                    className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-30 transition-colors"
                  >
                    Next →
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center py-10 rounded-xl border-2 border-dashed border-gray-200 mb-4">
            <span className="text-4xl mb-3">🍽️</span>
            <p className="text-sm font-medium text-gray-500 text-center">
              Tap a restaurant below to compare
            </p>
          </div>
        )}

        {/* Collapsible lists to add restaurants */}
        <div className="mt-4">
          <button
            onClick={() => setMobileAddOpen((o) => !o)}
            className="w-full flex items-center justify-between rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <span>
              {activeIds.length > 0
                ? `+ Add more (${activeIds.length} / ${MAX_COMPARE})`
                : 'Add restaurants to compare'}
            </span>
            <span className="text-gray-400 text-xs">{mobileAddOpen ? '▲' : '▼'}</span>
          </button>

          {mobileAddOpen && (
            <div className="mt-2 border border-gray-200 rounded-lg bg-white p-4 flex flex-col gap-4">
              {(favorites.length > 0 || allFavoriteLists.length > 0) && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                      Favorites
                    </p>
                    {allFavoriteLists.length > 0 && (
                      <ListSelector
                        value={activeListIds ?? []}
                        onChange={setActiveListIds}
                        defaultId={defaultFavoriteList?.id}
                        align="right"
                      />
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    {favorites.map((id) => {
                      const inOptions = optionsSet.has(sid(id));
                      return (
                        <RestaurantCard
                          size="md"
                          key={id}
                          id={id}
                          isActive={activeSet.has(sid(id))}
                          personalRating={getUserRating(reviews, id)}
                          lastChosen={formatLastChosen(acceptedStats, id)}
                          onCardClick={() => handleCardClick(id)}
                          cornerSlot={<HeartWithKebab restaurantId={id} size="md" onPickerOpen={handlePickerOpen} onPickerClose={handlePickerClose} />}
                          onInfo={() => setDetailId(id)}
                          restaurantMap={allRestaurants}
                        >
                          {/* + Add to Options bottom action so a
                              favorited restaurant can graduate
                              into the user's coin-flip pool
                              directly from this sidebar. Once in
                              options, the button flips to a
                              disabled "In options" state — keeps
                              the row's footprint stable and gives
                              the user feedback that the action
                              landed. stopPropagation prevents the
                              click from bubbling to the card's
                              "toggle comparison" handler. */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!inOptions) dispatch(addUserOption(id));
                            }}
                            disabled={inOptions}
                            className={[
                              'mt-2 w-full rounded-lg text-xs py-1 transition-all shadow-brand-sm',
                              inOptions
                                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                : 'bg-gradient-to-br from-orange-500 to-red-500 text-white hover:from-orange-400 hover:to-red-400',
                            ].join(' ')}
                          >
                            {inOptions ? '✓ In Options' : '+ Add to Options'}
                          </button>
                        </RestaurantCard>
                      );
                    })}
                  </div>
                </div>
              )}

              {options.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                    Options
                  </p>
                  <div className="flex flex-col gap-2">
                    {options.map((id) => (
                      <RestaurantCard
                        size="md"
                        key={id}
                        id={id}
                        isActive={activeSet.has(sid(id))}
                        personalRating={getUserRating(reviews, id)}
                        lastChosen={formatLastChosen(acceptedStats, id)}
                        onCardClick={() => handleCardClick(id)}
                        onRemove={() => handleRemoveOption(id)}
                        onInfo={() => setDetailId(id)}
                        restaurantMap={allRestaurants}
                      />
                    ))}
                  </div>
                </div>
              )}

              {favorites.length === 0 && options.length === 0 && (
                <p className="text-sm text-gray-400 italic text-center">
                  No restaurants in your favorites or options yet.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── DESKTOP LAYOUT (≥ md) ──────────────────────────── */}
      {/* Switched from flex-row to CSS grid at lg+ for guaranteed-stable
          column widths. With flex-row, the center column was `flex-1
          min-w-0` and its rendered width could subtly shift based on
          its children's intrinsic widths AND on viewport scrollbar
          state. With grid-cols-[13rem_1fr_13rem], the column tracks
          are absolute: sidebars always exactly 208 px, center always
          exactly what's left. No reflow when activeIds changes count
          or when comparison-state-driven height changes scroll state.
          On md (768-1024 px), keep the simple stacked flex-col since
          the page is too narrow for side-by-side anyway. */}
      <div className="hidden md:block lg:grid lg:grid-cols-[13rem_minmax(0,1fr)_13rem] gap-6 items-start">

        {/* Left: Favorites */}
        <div className="w-full lg:w-52 lg:shrink-0">
          {/* Position-in-list indicator next to the label. Updates
              live as the user scrolls the sidebar — the hook tracks
              which card is closest to the container's vertical
              center. Hidden when the list is empty so we don't
              render "0 / 0". */}
          <h2 className="text-lg font-bold text-gray-900 mb-2 flex items-baseline gap-2">
            <span>Favorites</span>
            {favorites.length > 0 && (
              <span className="text-xs font-medium text-gray-400 tabular-nums">
                {favActiveIdx + 1} / {favorites.length}
              </span>
            )}
          </h2>
          {/* ListSelector lets the user switch which list drives this
              sidebar without leaving the Compare page. Hidden when
              there are no lists yet (pre-hydrate / brand-new
              account) — the sidebar then falls back to the legacy
              favorites array via the `favorites` useMemo above. */}
          {allFavoriteLists.length > 0 && (
            <div className="mb-3">
              <ListSelector
                value={activeListIds ?? []}
                onChange={setActiveListIds}
                defaultId={defaultFavoriteList?.id}
                align="left"
              />
            </div>
          )}
          {favorites.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No favorites yet.</p>
          ) : (
            // Cap at roughly 6 sm-cards-tall when the list is longer, so a
            // big favorites collection doesn't stretch the page indefinitely.
            // overscroll-contain stops the wheel/touch scroll from bubbling
            // up to the page once you hit the top/bottom of the list.
            // pr-1 gives the scrollbar a tiny gutter so it doesn't crowd cards.
            // md-size cards are ~2× taller than the legacy sm cards
            // they replaced, so we always scroll (not just past 6
            // entries) with a viewport-relative cap. 80vh leaves
            // room for the page header + breadcrumb above and the
            // viewport bottom edge below. overscroll-contain stops
            // wheel/touch scroll from bubbling to the page when
            // the user hits the top/bottom of the list.
            //
            // Scrollbar on the LEFT: outer container is direction:rtl
            // so the browser paints the overflow scrollbar on the
            // inline-start edge (visually left in our LTR locale);
            // inner column resets direction:ltr so flex/text still
            // flow normally. pl-2 puts an 8px gutter between the
            // scrollbar and the card edges so they don't visually
            // touch.
            <div ref={favScrollRef} className="max-h-[80vh] overflow-y-auto overscroll-contain [direction:rtl]">
              <div className="flex flex-col gap-3 pl-2 [direction:ltr]">
              {favorites.map((id) => {
                const inOptions = optionsSet.has(sid(id));
                return (
                  <RestaurantCard
                    size="md"
                    key={id}
                    id={id}
                    isActive={activeSet.has(sid(id))}
                    personalRating={getUserRating(reviews, id)}
                    lastChosen={formatLastChosen(acceptedStats, id)}
                    onCardClick={() => handleCardClick(id)}
                    cornerSlot={<HeartWithKebab restaurantId={id} size="md" onPickerOpen={handlePickerOpen} onPickerClose={handlePickerClose} />}
                    onInfo={() => setDetailId(id)}
                    restaurantMap={allRestaurants}
                    // Map↔card sync: hovering this card glows the matching
                    // pin; hovering the pin rings this card via
                    // isHighlighted (driven by hoveredCompareId).
                    onMouseEnter={() => setHoveredCompareId(String(id))}
                    onMouseLeave={() => setHoveredCompareId(null)}
                    isHighlighted={String(hoveredCompareId) === String(id)}
                  >
                    {/* See mobile favorites above for the rationale —
                        same Add-to-Options bottom action so the user
                        can promote a favorite into the coin-flip
                        pool without leaving the Compare page. */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!inOptions) dispatch(addUserOption(id));
                      }}
                      disabled={inOptions}
                      className={[
                        'mt-2 w-full rounded-lg text-xs py-1 transition-all shadow-brand-sm',
                        inOptions
                          ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                          : 'bg-gradient-to-br from-orange-500 to-red-500 text-white hover:from-orange-400 hover:to-red-400',
                      ].join(' ')}
                    >
                      {inOptions ? '✓ In Options' : '+ Add to Options'}
                    </button>
                  </RestaurantCard>
                );
              })}
              </div>
            </div>
          )}
        </div>

        {/* Center: Detail panels */}
        {/* w-full + min-w-0: vestigial flex hints were removed when the
            parent went from flex to grid. w-full keeps the center child
            stretching to fill its grid cell (default `auto` already does
            this for block elements, but the explicit class is a guard
            against any future grid-item alignment surprises). min-w-0
            allows children to shrink past their intrinsic min width if
            ever needed (e.g. long restaurant name in a narrow panel). */}
        <div className="w-full min-w-0">
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-gray-500">
              {activeIds.length === 0
                ? 'Select up to 4 restaurants to compare'
                : `${activeIds.length} / ${MAX_COMPARE} selected`}
            </p>
            {activeIds.length > 0 && (
              <button
                onClick={() => setActiveIds([])}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                Clear all
              </button>
            )}
          </div>

          {/* Unified layout for every comparison state. Always renders:
              - A 2-per-row grid of panels and placeholder cards (fills up
                to MAX_COMPARE = 4 cells; minimum 2 cells even with no
                active comparison so the page reads as "two ready slots"
                rather than a single full-width prompt).
              - A compact map below, sourced from compareMapItems (all
                options when nothing is being compared, the active set
                otherwise — see the memo above).
              By keeping the structure identical regardless of activeIds
              count, the favorites/options sidebars never move and the
              center never resizes. */}
          {(() => {
            // Number of placeholder cards needed to round the grid out
            // to a clean 2-up (when 0 or 2 active) or 2x2 (when 3 active).
            //   0 active → 2 placeholders (empty state)
            //   1 active → 1 placeholder
            //   2 active → 0 placeholders (full first row)
            //   3 active → 1 placeholder (rounds row 2 out)
            //   4 active → 0 placeholders (full 2x2)
            const len = activeIds.length;
            const placeholderCount =
              len === 0 ? 2 : (len % 2 === 1 && len < MAX_COMPARE ? 1 : 0);
            return (
              <>
                <div className={`w-full grid gap-4 ${COMPARE_GRID_CLASS}`}>
                  {activeIds.map((id) => (
                    <div key={id} className="relative min-w-0 h-full">
                      <button
                        onClick={() => handleDismiss(id)}
                        className="absolute -top-2 -right-2 z-10 w-6 h-6 flex items-center justify-center rounded-full bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-500 text-xs font-bold shadow-sm transition-colors"
                        aria-label="Dismiss"
                      >
                        ✕
                      </button>
                      {/* See mobile DetailPanel above for the
                          inline-mode rationale. Same setup: readOnly
                          modal body + custom Compare actions. */}
                      <RestaurantDetailPanel
                        restaurantId={id}
                        restaurantMap={allRestaurants}
                        readOnly
                        actions={(
                          <ComparePanelActions
                            isFavorite={userInfo.favorites.map(sid).includes(sid(id))}
                            onChooseNow={() => handleChooseNow(id)}
                            onToggleFavorite={() =>
                              dispatch(updateUserFavorites({ restaurantId: id, userId: userInfo.id }))
                            }
                          />
                        )}
                      />
                    </div>
                  ))}
                  {/* Dashed placeholder cards. Keyed by index so React
                      doesn't try to reuse them across renders when the
                      count changes. */}
                  {Array.from({ length: placeholderCount }).map((_, i) => (
                    <div key={`placeholder-${i}`} className="relative min-w-0 h-full">
                      <div className="rounded-xl border-2 border-dashed border-gray-200 bg-gray-50/50 p-5 h-full min-h-[14rem] flex flex-col items-center justify-center text-center">
                        <span className="text-3xl mb-2 select-none" aria-hidden="true">＋</span>
                        <p className="text-sm font-medium text-gray-400">
                          Add a restaurant to compare
                        </p>
                        <p className="text-xs text-gray-400 mt-1">
                          Click any card in the Favorites or Options list
                        </p>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Compact map below. Hidden when no items have coords or
                    the env key isn't set — in that case the page is just
                    the placeholder/detail grid, which is fine. */}
                {compareMapItems.length > 0 && import.meta.env.VITE_GOOGLE_MAPS_API_KEY && (
                  <div className="w-full mt-4 h-56 rounded-xl overflow-hidden border border-gray-200 shadow-sm bg-gray-50">
                    <Suspense fallback={<div className="h-full w-full bg-gray-100 animate-pulse" />}>
                      <CompareMap
                        items={compareMapItems}
                        hoveredId={hoveredCompareId}
                        onMarkerHover={setHoveredCompareId}
                        onMarkerClick={handleCardClick}
                      />
                    </Suspense>
                  </div>
                )}
              </>
            );
          })()}
        </div>

        {/* Right: Options */}
        <div className="w-full lg:w-52 lg:shrink-0">
          {/* Mirrors the Favorites label above — same position-
              indicator pattern, just driven by the options scroll
              container instead. */}
          <h2 className="text-lg font-bold text-gray-900 mb-3 flex items-baseline gap-2">
            <span>Options</span>
            {options.length > 0 && (
              <span className="text-xs font-medium text-gray-400 tabular-nums">
                {optActiveIdx + 1} / {options.length}
              </span>
            )}
          </h2>
          {options.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No options yet.</p>
          ) : (
            // Mirror of the Favorites sidebar above — same 6-card cap so
            // both columns cap at roughly equal heights and the page
            // doesn't stretch when either list grows long.
            // Always-scroll sidebar at 80vh — see Favorites column
            // above for the rationale (md cards are taller than the
            // legacy sm cards, so the previous "scroll only past 6
            // entries" pattern made the column too tall on most
            // screens). Scrollbar stays on the right (the favorites
            // column moved it to the left so the two columns
            // mirror each other across the comparison-grid in the
            // middle); pr-2 gives an 8px gutter between the cards
            // and the scrollbar so they don't visually touch.
            <div ref={optScrollRef} className="flex flex-col gap-3 max-h-[80vh] overflow-y-auto overscroll-contain pr-2">
              {options.map((id) => (
                <RestaurantCard
                  size="md"
                  key={id}
                  id={id}
                  isActive={activeSet.has(sid(id))}
                  personalRating={getUserRating(reviews, id)}
                  lastChosen={formatLastChosen(acceptedStats, id)}
                  onCardClick={() => handleCardClick(id)}
                  onRemove={() => handleRemoveOption(id)}
                  onInfo={() => setDetailId(id)}
                  restaurantMap={allRestaurants}
                  // Map↔card sync — see Favorites sidebar above for the
                  // full rationale; same pattern.
                  onMouseEnter={() => setHoveredCompareId(String(id))}
                  onMouseLeave={() => setHoveredCompareId(null)}
                  isHighlighted={String(hoveredCompareId) === String(id)}
                />
              ))}
            </div>
          )}
        </div>

      </div>
    </div>

    {/* Post-Choose-Now celebration moved to the global
        <ChosenCelebration/> mounted in App.tsx — same UX, fired
        via dispatch(showChosenCelebration(id)) instead of local
        state. */}
    {detailId && (
      <RestaurantDetailModal
        restaurantId={detailId}
        restaurantMap={allRestaurants}
        onClose={() => setDetailId(null)}
      />
    )}
    </>
  );
};

export default RestaurantPage;
