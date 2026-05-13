import { useState, useRef, useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useParams } from "react-router-dom";
import {
  addUserAcceptance,
  removeUserSelection,
  updateUserFavorites,
} from "../redux/slices/userInfoSlice";
import RatingDisplay from "../components/RatingDisplay";
import useCurrentUser from "../hooks/useCurrentUser";
import getMostRecentDate from "../utils/getMostRecentDate";

import InfoRow from "../components/InfoRow";
import { PRICE_LABELS } from "../utils/restaurantConstants";
import RestaurantDetailModal from "../components/RestaurantDetailModal";

// ── Helpers ───────────────────────────────────────────────────

const sid  = (id) => String(id);
const mean = (nums) => nums.reduce((a, b) => a + b, 0) / nums.length;

const getUserRating = (reviews, id) => {
  const list = reviews[sid(id)];
  return list?.length ? mean(list.map((r) => r.rating)) : null;
};

// ── Mini card — mirrors ChoosePage style ──────────────────────

const MiniCard = ({ id, isActive, personalRating, lastChosen, onClick, onRemove, onUnfavorite, onInfo, restaurantMap = {} }) => {
  const r = restaurantMap[id];
  if (!r) return null;
  return (
    <div
      onClick={onClick}
      className={[
        "relative rounded-lg border p-3 bg-white cursor-pointer shadow-sm",
        "transition-all duration-150 select-none",
        "hover:shadow-md hover:border-orange-300",
        isActive
          ? "border-orange-500 ring-2 ring-orange-300 bg-orange-50"
          : "border-gray-200",
      ].join(" ")}
    >
      <div className="flex justify-between items-start gap-2">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <button
            onClick={(e) => { e.stopPropagation(); onInfo?.(); }}
            className="font-semibold text-sm text-orange-600 hover:underline leading-tight text-left"
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
        {onUnfavorite && (
          <button
            onClick={(e) => { e.stopPropagation(); onUnfavorite(); }}
            className="text-red-500 hover:text-red-300 text-base shrink-0 leading-none"
          >
            &#9829;
          </button>
        )}
        {onRemove && !onUnfavorite && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="text-gray-300 hover:text-red-400 text-xs shrink-0 mt-0.5 leading-none"
          >
            ✕
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500 mt-0.5">{r.type}</p>
      <p className="text-xs text-gray-400">Opens {r.hours}</p>
    </div>
  );
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
        <InfoRow label="Website" value={website ?? '—'} href={website ? `https://${website}` : undefined} external />
        <InfoRow label="Yelp"    value={yelp ?? '—'}    href={yelp ? `https://${yelp}` : undefined} external />
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

const gridClass = (count) => (count <= 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2');

// ── Page ─────────────────────────────────────────────────────

const RestaurantPage = () => {
  const { restaurantId } = useParams();
  const dispatch = useDispatch();
  const userInfo = useCurrentUser();
  const customRestaurants = useSelector((state) => state.userInfo.customRestaurants);
  const allRestaurants = customRestaurants;
  const { favorites, selections, reviews } = userInfo;

  const [activeIds, setActiveIds] = useState(
    restaurantId ? [restaurantId] : []
  );
  const [chosenId, setChosenId] = useState(null);
  const [detailId, setDetailId] = useState(null);

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

  const handleChooseNow = (id) => {
    dispatch(addUserAcceptance({ restaurantId: id }));
    dispatch(removeUserSelection(id));
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
                      <MiniCard
                        key={id}
                        id={id}
                        isActive={activeSet.has(sid(id))}
                        personalRating={getUserRating(reviews, id)}
                        lastChosen={getMostRecentDate(userInfo.accepted, id)}
                        onClick={() => handleCardClick(id)}
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

              {selections.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                    Selections
                  </p>
                  <div className="flex flex-col gap-2">
                    {selections.map((id) => (
                      <MiniCard
                        key={id}
                        id={id}
                        isActive={activeSet.has(sid(id))}
                        personalRating={getUserRating(reviews, id)}
                        lastChosen={getMostRecentDate(userInfo.accepted, id)}
                        onClick={() => handleCardClick(id)}
                        onRemove={() => dispatch(removeUserSelection(id))}
                        onInfo={() => setDetailId(id)}
                        restaurantMap={allRestaurants}
                      />
                    ))}
                  </div>
                </div>
              )}

              {favorites.length === 0 && selections.length === 0 && (
                <p className="text-sm text-gray-400 italic text-center">
                  No restaurants in your favorites or selections yet.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── DESKTOP LAYOUT (≥ md) ──────────────────────────── */}
      <div className="hidden md:flex flex-col lg:flex-row gap-6 items-start">

        {/* Left: Favorites */}
        <div className="w-full lg:w-52 lg:shrink-0">
          <h2 className="text-lg font-bold text-gray-900 mb-3">Favorites</h2>
          {favorites.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No favorites yet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {favorites.map((id) => (
                <MiniCard
                  key={id}
                  id={id}
                  isActive={activeSet.has(sid(id))}
                  personalRating={getUserRating(reviews, id)}
                  lastChosen={getMostRecentDate(userInfo.accepted, id)}
                  onClick={() => handleCardClick(id)}
                  onUnfavorite={() =>
                    dispatch(updateUserFavorites({ restaurantId: id, userId: userInfo.id }))
                  }
                  onInfo={() => setDetailId(id)}
                  restaurantMap={allRestaurants}
                />
              ))}
            </div>
          )}
        </div>

        {/* Center: Detail panels */}
        <div className="flex-1 min-w-0">
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

          {activeIds.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-72 rounded-xl border-2 border-dashed border-gray-200">
              <span className="text-4xl mb-3">🍽️</span>
              <p className="text-sm font-medium text-gray-400">
                Select a restaurant from either sidebar to compare
              </p>
            </div>
          ) : (
            <div className={`grid gap-4 ${gridClass(activeIds.length)}`}>
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
            </div>
          )}
        </div>

        {/* Right: Selections */}
        <div className="w-full lg:w-52 lg:shrink-0">
          <h2 className="text-lg font-bold text-gray-900 mb-3">Selections</h2>
          {selections.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No selections yet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {selections.map((id) => (
                <MiniCard
                  key={id}
                  id={id}
                  isActive={activeSet.has(sid(id))}
                  personalRating={getUserRating(reviews, id)}
                  lastChosen={getMostRecentDate(userInfo.accepted, id)}
                  onClick={() => handleCardClick(id)}
                  onRemove={() => dispatch(removeUserSelection(id))}
                  onInfo={() => setDetailId(id)}
                  restaurantMap={allRestaurants}
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
