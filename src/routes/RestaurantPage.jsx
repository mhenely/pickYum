import { useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useParams } from "react-router-dom";
import {
  addUserSelection,
  removeUserSelection,
  updateUserFavorites,
} from "../redux/slices/userInfoSlice";
import { restaurants } from "../tempData/restaurants";
import useCurrentUser from "../hooks/useCurrentUser";
import getMostRecentDate from "../utils/getMostRecentDate";

// ── Constants & helpers ───────────────────────────────────────

const PRICE_LABELS = { 1: "$", 2: "$$", 3: "$$$", 4: "$$$$" };
const sid  = (id) => String(id);
const mean = (nums) => nums.reduce((a, b) => a + b, 0) / nums.length;

const getUserRating = (reviews, id) => {
  const list = reviews[sid(id)];
  return list?.length ? mean(list.map((r) => r.rating)) : null;
};

// ── Info row used inside the detail panel ─────────────────────

const InfoRow = ({ label, value, href, external }) => (
  <div>
    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">
      {label}
    </p>
    {href ? (
      <a
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
        className="text-sm text-indigo-600 hover:underline break-all"
      >
        {value}
      </a>
    ) : (
      <p className="text-sm text-gray-800 font-medium">{value}</p>
    )}
  </div>
);

// ── Mini card — mirrors ChoosePage style ──────────────────────

const MiniCard = ({ id, isActive, avgRating, lastChosen, onClick, onRemove, onUnfavorite, restaurantMap = restaurants }) => {
  const r = restaurantMap[id];
  if (!r) return null;
  return (
    <div
      onClick={onClick}
      className={[
        "relative rounded-lg border p-3 bg-white cursor-pointer",
        "transition-all duration-150 select-none",
        "hover:shadow-md hover:border-indigo-300",
        isActive
          ? "border-indigo-500 ring-2 ring-indigo-300 bg-indigo-50"
          : "border-gray-200",
      ].join(" ")}
    >
      <div className="flex justify-between items-start gap-2">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <span className="font-semibold text-sm text-gray-900 leading-tight">
            {r.name}
          </span>
          {avgRating !== null && (
            <span className="text-xs font-bold text-amber-500 whitespace-nowrap">
              ★ {avgRating.toFixed(1)}
            </span>
          )}
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

const DetailPanel = ({ id, userInfo, dispatch, restaurantMap = restaurants }) => {
  const r = restaurantMap[id];
  if (!r) return null;

  const reviews    = userInfo.reviews[sid(id)] || [];
  const avgRating  = reviews.length ? mean(reviews.map((rv) => rv.rating)) : null;
  const isFavorite = userInfo.favorites.map(sid).includes(sid(id));
  const isSelected = userInfo.selections.map(sid).includes(sid(id));

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6 flex flex-col gap-5">

      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex justify-between items-start gap-4">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold text-gray-900 leading-tight">{r.name}</h2>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <span className="px-2.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-semibold">
              {r.type}
            </span>
            <span className="text-sm text-amber-500 font-semibold">
              ★ {r.rating} <span className="text-gray-400 font-normal text-xs">overall</span>
            </span>
            {avgRating !== null && (
              <span className="text-sm text-indigo-500 font-semibold">
                ★ {avgRating.toFixed(1)} <span className="text-gray-400 font-normal text-xs">your avg</span>
              </span>
            )}
          </div>
        </div>

        {/* Heart toggle */}
        <button
          onClick={() =>
            dispatch(updateUserFavorites({ restaurantId: id, userId: userInfo.id }))
          }
          className={`text-2xl leading-none shrink-0 transition-colors ${
            isFavorite ? "text-red-500" : "text-gray-300 hover:text-red-300"
          }`}
        >
          ♥
        </button>
      </div>

      <hr className="border-gray-100" />

      {/* ── Info grid ──────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-x-8 gap-y-4">
        <InfoRow label="Price"   value={PRICE_LABELS[r.price]} />
        <InfoRow label="Opens"   value={r.hours} />
        <InfoRow label="Phone"   value={r.phone}   href={`tel:${r.phone}`} />
        <InfoRow label="Website" value={r.website} href={`https://${r.website}`} external />
        <InfoRow label="Yelp"    value={r.yelp}    href={`https://${r.yelp}`}    external />
      </div>

      {/* ── Service availability ───────────────────────────── */}
      <div className="flex gap-2">
        <span
          className={`px-3 py-1 rounded-full text-xs font-semibold ${
            r.takeout
              ? "bg-green-100 text-green-700"
              : "bg-gray-100 text-gray-400 line-through"
          }`}
        >
          Takeout
        </span>
        <span
          className={`px-3 py-1 rounded-full text-xs font-semibold ${
            r.delivery
              ? "bg-green-100 text-green-700"
              : "bg-gray-100 text-gray-400 line-through"
          }`}
        >
          Delivery
        </span>
      </div>

      {/* ── Action buttons ─────────────────────────────────── */}
      <div className="flex gap-3">
        <button
          onClick={() =>
            isSelected
              ? dispatch(removeUserSelection(id))
              : dispatch(addUserSelection(id))
          }
          className={[
            "flex-1 rounded-lg py-2 text-sm font-semibold transition-colors",
            isSelected
              ? "bg-red-50 text-red-600 hover:bg-red-100 border border-red-200"
              : "bg-indigo-600 text-white hover:bg-indigo-500",
          ].join(" ")}
        >
          {isSelected ? "Remove from Selections" : "Add to Selections"}
        </button>

        <button
          onClick={() =>
            dispatch(updateUserFavorites({ restaurantId: id, userId: userInfo.id }))
          }
          className={[
            "flex-1 rounded-lg py-2 text-sm font-semibold transition-colors border",
            isFavorite
              ? "bg-red-50 text-red-600 hover:bg-red-100 border-red-200"
              : "bg-white text-gray-600 hover:bg-gray-50 border-gray-200",
          ].join(" ")}
        >
          {isFavorite ? "♥ Unfavorite" : "♡ Favorite"}
        </button>
      </div>

      {/* ── User reviews ───────────────────────────────────── */}
      {reviews.length > 0 && (
        <div className="border-t border-gray-100 pt-4">
          <p className="text-sm font-semibold text-gray-700 mb-3">
            Your Reviews
            <span className="ml-1.5 text-xs font-normal text-gray-400">
              ({reviews.length})
            </span>
          </p>
          <div className="flex flex-col gap-2 max-h-52 overflow-y-auto pr-1">
            {reviews.map((rv) => (
              <div
                key={rv.content + rv.date}
                className="rounded-lg bg-gray-50 px-3 py-2.5"
              >
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

// ── Page ─────────────────────────────────────────────────────

const RestaurantPage = () => {
  const { restaurantId } = useParams();
  const dispatch = useDispatch();
  const userInfo = useCurrentUser();
  const customRestaurants = useSelector((state) => state.userInfo.customRestaurants);
  const allRestaurants = { ...restaurants, ...customRestaurants };
  const { favorites, selections, reviews } = userInfo;

  const [activeId, setActiveId] = useState(restaurantId ?? null);

  const handleCardClick = (id) =>
    setActiveId((prev) => (sid(prev) === sid(id) ? null : id));

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex gap-6 items-start">

        {/* ── LEFT: Favorites ──────────────────────────────── */}
        <div className="w-56 shrink-0">
          <h2 className="text-lg font-bold text-gray-900 mb-3">Favorites</h2>
          {favorites.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No favorites yet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {favorites.map((id) => (
                <MiniCard
                  key={id}
                  id={id}
                  isActive={sid(activeId) === sid(id)}
                  avgRating={getUserRating(reviews, id)}
                  lastChosen={getMostRecentDate(userInfo.accepted, id)}
                  onClick={() => handleCardClick(id)}
                  onUnfavorite={() =>
                    dispatch(updateUserFavorites({ restaurantId: id, userId: userInfo.id }))
                  }
                  restaurantMap={allRestaurants}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── CENTER: Detail panel ─────────────────────────── */}
        <div className="flex-1 min-w-0">
          {activeId ? (
            <DetailPanel id={activeId} userInfo={userInfo} dispatch={dispatch} restaurantMap={allRestaurants} />
          ) : (
            <div className="flex flex-col items-center justify-center h-72 rounded-xl border-2 border-dashed border-gray-200">
              <span className="text-4xl mb-3">🍽️</span>
              <p className="text-sm font-medium text-gray-400">
                Select a restaurant to see its details
              </p>
            </div>
          )}
        </div>

        {/* ── RIGHT: Selections ────────────────────────────── */}
        <div className="w-56 shrink-0">
          <h2 className="text-lg font-bold text-gray-900 mb-3">Selections</h2>
          {selections.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No selections yet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {selections.map((id) => (
                <MiniCard
                  key={id}
                  id={id}
                  isActive={sid(activeId) === sid(id)}
                  avgRating={getUserRating(reviews, id)}
                  lastChosen={getMostRecentDate(userInfo.accepted, id)}
                  onClick={() => handleCardClick(id)}
                  onRemove={() => dispatch(removeUserSelection(id))}
                  restaurantMap={allRestaurants}
                />
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
};

export default RestaurantPage;
