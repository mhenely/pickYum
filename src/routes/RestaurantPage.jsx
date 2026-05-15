import { useState, useRef, useEffect, useMemo, lazy, Suspense } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useParams } from "react-router-dom";
import {
  addUserAcceptance,
  removeUserOption,
  updateUserFavorites,
} from "../redux/slices/userInfoSlice";
import RatingDisplay from "../components/RatingDisplay";
import RestaurantCard from "../components/RestaurantCard";
import useCurrentUser from "../hooks/useCurrentUser";
import { buildAcceptedStats, formatLastChosen } from "../utils/acceptedStats";

import InfoRow from "../components/InfoRow";
import { PRICE_LABELS } from "../utils/restaurantConstants";
import { normalizeUrl } from "../utils/normalizeUrl";
import RestaurantDetailModal from "../components/RestaurantDetailModal";
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

// ── Detail panel ─────────────────────────────────────────────

const cleanVal = (raw) => (raw && raw !== 'N/A') ? raw : null;

const DetailPanel = ({ id, userInfo, dispatch, onChooseNow, restaurantMap = {} }) => {
  const r = restaurantMap[id];
  if (!r) return null;

  const reviews    = userInfo.reviews[sid(id)] || [];
  const avgRating  = reviews.length ? mean(reviews.map((rv) => rv.rating)) : null;
  const isFavorite = userInfo.favorites.map(sid).includes(sid(id));

  const phone   = cleanVal(r.phone);
  const website = cleanVal(r.website);
  const yelp    = cleanVal(r.yelp);

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-5 flex flex-col h-full">

      <div className="flex justify-between items-start gap-3 min-h-[4.5rem]">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-gray-900 leading-snug line-clamp-2">{r.name}</h2>
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            <span className="px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 text-xs font-semibold truncate max-w-[8rem]">
              {r.type ?? '—'}
            </span>
            <RatingDisplay
              restaurantId={id}
              googleRating={r.rating ?? null}
              personalRating={avgRating}
              personalReviews={reviews}
              restaurantName={r.name}
            />
          </div>
        </div>
        <button
          onClick={() => dispatch(updateUserFavorites({ restaurantId: id, userId: userInfo.id }))}
          className={`text-xl leading-none shrink-0 mt-0.5 transition-colors ${
            isFavorite ? "text-red-500" : "text-gray-300 hover:text-red-300"
          }`}
        >
          ♥
        </button>
      </div>

      <hr className="border-gray-100 my-3" />

      <div className="grid grid-cols-2 gap-x-5 gap-y-3">
        <InfoRow label="Price"   value={PRICE_LABELS[r.price] ?? '—'} />
        <InfoRow label="Hours"   value={cleanVal(r.hours) ?? '—'} />
        <InfoRow label="Phone"   value={phone ?? '—'}   href={phone ? `tel:${phone}` : undefined} />
        <InfoRow label="Website" value={website ?? '—'} href={normalizeUrl(website)} external />
        <InfoRow label="Yelp"    value={yelp ?? '—'}    href={normalizeUrl(yelp)}    external />
      </div>

      <div className="flex gap-2 mt-3">
        <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
          r.takeout ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400 line-through"
        }`}>
          Takeout
        </span>
        <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
          r.delivery ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400 line-through"
        }`}>
          Delivery
        </span>
      </div>

      <div className="flex-1" />

      <div className="flex gap-2 mt-4">
        <button
          onClick={onChooseNow}
          className="flex-1 rounded-lg py-2 text-xs font-semibold transition-colors bg-green-600 text-white hover:bg-green-500"
        >
          Choose Now
        </button>
        <button
          onClick={() => dispatch(updateUserFavorites({ restaurantId: id, userId: userInfo.id }))}
          className={[
            "flex-1 rounded-lg py-2 text-xs font-semibold transition-colors border",
            isFavorite
              ? "bg-red-50 text-red-600 hover:bg-red-100 border-red-200"
              : "bg-white text-gray-600 hover:bg-gray-50 border-gray-200",
          ].join(" ")}
        >
          {isFavorite ? "♥ Unfavorite" : "♡ Favorite"}
        </button>
      </div>

      {reviews.length > 0 && (
        <div className="border-t border-gray-100 mt-3 pt-3">
          <p className="text-xs font-semibold text-gray-600 mb-2">
            Your Reviews <span className="font-normal text-gray-400">({reviews.length})</span>
          </p>
          <div className="flex flex-col gap-1.5 max-h-32 overflow-y-auto pr-1">
            {reviews.map((rv) => (
              <div key={rv.content + rv.date} className="rounded-lg bg-gray-50 px-2.5 py-2">
                <div className="flex justify-between items-center mb-0.5">
                  <span className="text-xs font-bold text-amber-500">★ {rv.rating}</span>
                  <span className="text-xs text-gray-400">{rv.date}</span>
                </div>
                <p className="text-xs text-gray-600 leading-relaxed">{rv.content}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ── Acceptance confirmation modal ─────────────────────────────

const ChosenModal = ({ id, restaurantMap, onClose }) => {
  const r = restaurantMap[id];
  if (!r) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-2xl bg-white shadow-2xl overflow-hidden">
        <div className="bg-green-50 border-b border-green-100 px-6 py-5 flex justify-between items-start">
          <div>
            <p className="text-xs font-semibold text-green-600 uppercase tracking-wider mb-1">
              Tonight you're going to
            </p>
            <h2 className="text-2xl font-bold text-gray-900">{r.name}</h2>
            <p className="text-sm text-gray-500 mt-0.5">{r.type}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 shrink-0 mt-1 text-lg leading-none">
            ✕
          </button>
        </div>
        <div className="px-6 py-5 flex flex-col gap-3">
          <div className="flex gap-4 text-sm text-gray-700">
            <div><p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">Price</p>{PRICE_LABELS[r.price] ?? '—'}</div>
            <div><p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">Hours</p>{r.hours ?? '—'}</div>
          </div>
          <div className="flex gap-2">
            <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${r.takeout ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400 line-through'}`}>Takeout</span>
            <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${r.delivery ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400 line-through'}`}>Delivery</span>
          </div>
          <button
            onClick={onClose}
            className="mt-1 w-full rounded-lg bg-green-600 py-2.5 text-sm font-semibold text-white hover:bg-green-500 transition-colors"
          >
            Let's go!
          </button>
        </div>
      </div>
    </div>
  );
};

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
  const { favorites, options, reviews } = userInfo;

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
  const [chosenId, setChosenId] = useState(null);
  const [detailId, setDetailId] = useState(null);

  // Two-way card↔marker hover sync. Same pattern as SearchPage — one
  // piece of state drives "which pin glows" AND "which card is ringed".
  // Local because it's purely visual ephemera.
  const [hoveredCompareId, setHoveredCompareId] = useState(null);

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
    setChosenId(id);
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
                  <DetailPanel
                    id={mobileCurrentId}
                    userInfo={userInfo}
                    dispatch={dispatch}
                    onChooseNow={() => handleChooseNow(mobileCurrentId)}
                    restaurantMap={allRestaurants}
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
              {favorites.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                    Favorites
                  </p>
                  <div className="flex flex-col gap-2">
                    {favorites.map((id) => (
                      <RestaurantCard
                        size="sm"
                        key={id}
                        id={id}
                        isActive={activeSet.has(sid(id))}
                        personalRating={getUserRating(reviews, id)}
                        lastChosen={formatLastChosen(acceptedStats, id)}
                        onCardClick={() => handleCardClick(id)}
                        onUnfavorite={() =>
                          dispatch(updateUserFavorites({ restaurantId: id, userId: userInfo.id }))
                        }
                        onInfo={() => setDetailId(id)}
                        restaurantMap={allRestaurants}
                      />
                    ))}
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
                        size="sm"
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
          <h2 className="text-lg font-bold text-gray-900 mb-3">Favorites</h2>
          {favorites.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No favorites yet.</p>
          ) : (
            // Cap at roughly 6 sm-cards-tall when the list is longer, so a
            // big favorites collection doesn't stretch the page indefinitely.
            // overscroll-contain stops the wheel/touch scroll from bubbling
            // up to the page once you hit the top/bottom of the list.
            // pr-1 gives the scrollbar a tiny gutter so it doesn't crowd cards.
            <div className={`flex flex-col gap-3 ${favorites.length > 6 ? 'max-h-[820px] overflow-y-auto overscroll-contain pr-1' : ''}`}>
              {favorites.map((id) => (
                <RestaurantCard
                  size="sm"
                  key={id}
                  id={id}
                  isActive={activeSet.has(sid(id))}
                  personalRating={getUserRating(reviews, id)}
                  lastChosen={formatLastChosen(acceptedStats, id)}
                  onCardClick={() => handleCardClick(id)}
                  onUnfavorite={() =>
                    dispatch(updateUserFavorites({ restaurantId: id, userId: userInfo.id }))
                  }
                  onInfo={() => setDetailId(id)}
                  restaurantMap={allRestaurants}
                  // Map↔card sync: hovering this card glows the matching
                  // pin; hovering the pin rings this card via
                  // isHighlighted (driven by hoveredCompareId).
                  onMouseEnter={() => setHoveredCompareId(String(id))}
                  onMouseLeave={() => setHoveredCompareId(null)}
                  isHighlighted={String(hoveredCompareId) === String(id)}
                />
              ))}
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
                      <DetailPanel
                        id={id}
                        userInfo={userInfo}
                        dispatch={dispatch}
                        onChooseNow={() => handleChooseNow(id)}
                        restaurantMap={allRestaurants}
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
          <h2 className="text-lg font-bold text-gray-900 mb-3">Options</h2>
          {options.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No options yet.</p>
          ) : (
            // Mirror of the Favorites sidebar above — same 6-card cap so
            // both columns cap at roughly equal heights and the page
            // doesn't stretch when either list grows long.
            <div className={`flex flex-col gap-3 ${options.length > 6 ? 'max-h-[820px] overflow-y-auto overscroll-contain pr-1' : ''}`}>
              {options.map((id) => (
                <RestaurantCard
                  size="sm"
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

    {chosenId && (
      <ChosenModal
        id={chosenId}
        restaurantMap={allRestaurants}
        onClose={() => setChosenId(null)}
      />
    )}
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
