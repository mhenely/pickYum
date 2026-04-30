import { useDispatch, useSelector } from "react-redux";
import { useState, useEffect, useRef } from "react";
import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { XMarkIcon } from "@heroicons/react/24/outline";

import {
  addUserAcceptance,
  addUserSelection,
  addCustomRestaurant,
  removeUserSelection,
  updateUserFavorites,
} from "../redux/slices/userInfoSlice";
import { restaurants } from "../tempData/restaurants";
import useCurrentUser from "../hooks/useCurrentUser";
import RouletteWheel from "../components/RouletteWheel";
import getMostRecentDate from "../utils/getMostRecentDate";
import "./HelpMeChoosePage.css";

const PRICE_LABELS = { 1: "$", 2: "$$", 3: "$$$", 4: "$$$$" };

const InfoRow = ({ label, value, href, external }) => (
  <div>
    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">{label}</p>
    {href ? (
      <a href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}
        className="text-sm text-indigo-600 hover:underline break-all">{value}</a>
    ) : (
      <p className="text-sm text-gray-800 font-medium">{value}</p>
    )}
  </div>
);

const AcceptModal = ({ restaurantId, userInfo, onClose, restaurantMap = restaurants }) => {
  const r = restaurantMap[restaurantId];
  if (!r) return null;

  const reviews   = userInfo.reviews[String(restaurantId)] || [];
  const avgRating = reviews.length
    ? reviews.reduce((acc, rv) => acc + rv.rating, 0) / reviews.length
    : null;

  return (
    <Dialog open={true} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-lg rounded-xl bg-white shadow-xl flex flex-col max-h-[85vh] overflow-y-auto">

          {/* ── Banner ─────────────────────────────────────────── */}
          <div className="bg-green-50 border-b border-green-100 px-6 py-4 flex justify-between items-start rounded-t-xl">
            <div>
              <p className="text-xs font-semibold text-green-600 uppercase tracking-wider mb-0.5">Tonight you're going to</p>
              <DialogTitle className="text-2xl font-bold text-gray-900">{r.name}</DialogTitle>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 shrink-0 mt-1">
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>

          <div className="px-6 py-5 flex flex-col gap-5">

            {/* ── Ratings ────────────────────────────────────────── */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-semibold">{r.type}</span>
              <span className="text-sm text-amber-500 font-semibold">
                ★ {r.rating} <span className="text-gray-400 font-normal text-xs">overall</span>
              </span>
              {avgRating !== null && (
                <span className="text-sm text-indigo-500 font-semibold">
                  ★ {avgRating.toFixed(1)} <span className="text-gray-400 font-normal text-xs">your avg</span>
                </span>
              )}
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
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${r.takeout ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400 line-through"}`}>Takeout</span>
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${r.delivery ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400 line-through"}`}>Delivery</span>
            </div>

            {/* ── User reviews ───────────────────────────────────── */}
            {reviews.length > 0 && (
              <div className="border-t border-gray-100 pt-4">
                <p className="text-sm font-semibold text-gray-700 mb-3">
                  Your Reviews
                  <span className="ml-1.5 text-xs font-normal text-gray-400">({reviews.length})</span>
                </p>
                <div className="flex flex-col gap-2 max-h-44 overflow-y-auto pr-1">
                  {reviews.map((rv) => (
                    <div key={rv.content + rv.date} className="rounded-lg bg-gray-50 px-3 py-2.5">
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

            <button
              onClick={onClose}
              className="w-full rounded-lg bg-green-600 py-2.5 text-sm font-semibold text-white hover:bg-green-500 transition-colors"
            >
              Let's go!
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
};

// ── Helpers ───────────────────────────────────────────────────

const avg = (nums) => nums.reduce((a, b) => a + b, 0) / nums.length;


const getUserRating = (reviews, restaurantId) => {
  const list = reviews[String(restaurantId)];
  if (!list || list.length === 0) return null;
  return avg(list.map((r) => r.rating));
};

const sid = (id) => String(id);

// ── Shared mini card ─────────────────────────────────────────

const RestaurantMiniCard = ({ id, avgRating, lastChosen, badge, isDragOver, isWinner, onRemove, onUnfavorite, children, restaurantMap = restaurants }) => {
  const r = restaurantMap[id];
  if (!r) return null;
  return (
    <div
      className={[
        "relative rounded-lg border p-3 bg-white transition-all duration-150 select-none",
        isDragOver ? "drop-target-active border-indigo-400 bg-indigo-50" : "border-gray-200",
        isWinner   ? "border-green-400 ring-2 ring-green-300 bg-green-50" : "",
      ].join(" ")}
    >
      {badge === "heads" && (
        <span className="absolute -top-2.5 -left-2.5 w-6 h-6 rounded-full bg-yellow-400 text-yellow-900 text-xs font-black flex items-center justify-center shadow z-10">
          H
        </span>
      )}
      {badge === "tails" && (
        <span className="absolute -top-2.5 -left-2.5 w-6 h-6 rounded-full bg-indigo-500 text-white text-xs font-black flex items-center justify-center shadow z-10">
          T
        </span>
      )}
      {isWinner && (
        <span className="absolute -top-2.5 right-2 text-[10px] font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded-full z-10">
          Winner!
        </span>
      )}

      {/* Name + inline average rating */}
      <div className="flex justify-between items-start gap-2">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <span className="font-semibold text-sm text-gray-900 leading-tight">{r.name}</span>
          {avgRating !== null && avgRating !== undefined && (
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
            onClick={onUnfavorite}
            className="text-red-500 hover:text-red-300 text-base leading-none shrink-0"
          >
            &#9829;
          </button>
        )}
        {onRemove && !onUnfavorite && (
          <button
            onClick={onRemove}
            className="text-gray-300 hover:text-red-400 text-xs leading-none shrink-0 mt-0.5"
          >
            ✕
          </button>
        )}
      </div>

      <p className="text-xs text-gray-500 mt-0.5">{r.type}</p>
      <p className="text-xs text-gray-400">Opens {r.hours}</p>

      {children}
    </div>
  );
};

// ── Accept / Remove result banner ────────────────────────────

const ResultBanner = ({ label, winnerId, onAccept, onRemove, restaurantMap = restaurants }) => {
  const r = winnerId ? restaurantMap[winnerId] : null;
  return (
    <div className="text-center mt-1">
      <p className="text-xl font-bold text-gray-900">{label}</p>
      {r ? (
        <>
          <p className="text-gray-600 mt-1 text-sm">
            You got <span className="font-semibold text-indigo-600">{r.name}</span>!
          </p>
          <div className="flex gap-3 justify-center mt-3">
            <button
              onClick={onAccept}
              className="px-5 py-2 rounded-lg bg-green-600 text-white font-semibold text-sm hover:bg-green-500 transition-colors"
            >
              Accept
            </button>
            <button
              onClick={onRemove}
              className="px-5 py-2 rounded-lg bg-red-100 text-red-600 font-semibold text-sm hover:bg-red-200 transition-colors"
            >
              Remove
            </button>
          </div>
        </>
      ) : (
        <p className="text-xs text-gray-400 mt-2">
          Drag a Heads or Tails label onto a selection to see which restaurant won.
        </p>
      )}
    </div>
  );
};

// ── Page ─────────────────────────────────────────────────────

const HelpMeChoosePage = () => {
  const dispatch = useDispatch();
  const userInfo = useCurrentUser();
  const { favorites, selections, reviews } = userInfo;

  // ── Mode ──────────────────────────────────────────────────
  const [mode, setMode] = useState("coinflip");

  // ── Coin flip ─────────────────────────────────────────────
  const [coinRotation, setCoinRotation]   = useState(0);
  const [coinTransition, setCoinTransition] = useState("none");
  const [isFlipping, setIsFlipping]       = useState(false);
  const [flipResult, setFlipResult]       = useState(null);
  const [flipComplete, setFlipComplete]   = useState(false);

  // ── Drag-and-drop ─────────────────────────────────────────
  const [headsId, setHeadsId]   = useState(null);
  const [tailsId, setTailsId]   = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  useEffect(() => {
    const ids = selections.map(sid);
    if (headsId && !ids.includes(sid(headsId))) setHeadsId(null);
    if (tailsId && !ids.includes(sid(tailsId))) setTailsId(null);
  }, [selections]);

  // ── Custom restaurants (user-entered names not in the data set) ──
  const customRestaurants = useSelector((state) => state.userInfo.customRestaurants);
  const allRestaurants = { ...restaurants, ...customRestaurants };

  const handleAddCustom = (name) => {
    const id = `custom-${Date.now()}`;
    dispatch(addCustomRestaurant({
      id,
      data: { name: name.trim(), type: 'Custom', price: 1, rating: null, hours: 'N/A', phone: 'N/A', website: 'N/A', yelp: 'N/A', takeout: false, delivery: false },
    }));
    dispatch(addUserSelection(id));
    setSearchQuery('');
  };

  // ── Accept modal ──────────────────────────────────────────
  const [acceptedModalId, setAcceptedModalId] = useState(null);

  // ── Selection search ──────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);

  const trimmedQuery = searchQuery.trim();

  const isAlreadyInSelections = trimmedQuery
    ? selections.some(
        (id) => allRestaurants[id]?.name?.toLowerCase() === trimmedQuery.toLowerCase()
      )
    : false;

  const searchSuggestions = trimmedQuery
    ? Object.entries(allRestaurants)
        .filter(([id, r]) =>
          r.name.toLowerCase().includes(trimmedQuery.toLowerCase()) &&
          !selections.map(String).includes(String(id))
        )
        .slice(0, 7)
    : [];

  // ── Roulette ──────────────────────────────────────────────
  const wheelRef            = useRef(null);
  const [isSpinning, setIsSpinning]         = useState(false);
  const [rouletteWinnerId, setRouletteWinnerId] = useState(null);

  // ── Coin flip logic ───────────────────────────────────────
  const handleCoinFlip = () => {
    if (isFlipping) return;
    setFlipComplete(false);
    setFlipResult(null);

    const seed = (Math.random() * 0.5 + (performance.now() % 1) * 0.3 + (Date.now() % 1000) * 0.0002) % 1;
    const result = seed > 0.5 ? "heads" : "tails";

    // Compute how far to rotate from the current resting angle to the target face.
    // Heads lands at 0° (mod 360), tails lands at 180° (mod 360).
    const currentAngle = ((coinRotation % 360) + 360) % 360;
    const targetAngle  = result === "tails" ? 180 : 0;
    let angleDelta = (targetAngle - currentAngle + 360) % 360;
    if (angleDelta === 0) angleDelta = 360; // ensure at least one full revolution worth of travel
    const delta = (Math.floor(Math.random() * 6) + 9) * 360 + angleDelta;
    const duration = 2200 + Math.floor(Math.random() * 400);

    setCoinTransition(`transform ${duration}ms cubic-bezier(0.15, 0.65, 0.28, 1)`);
    setIsFlipping(true);
    setCoinRotation((prev) => prev + delta);

    setTimeout(() => {
      setIsFlipping(false);
      setFlipResult(result);
      setFlipComplete(true);
      setCoinTransition("none");
    }, duration + 50);
  };

  const coinWinnerId = flipResult === "heads" ? headsId : flipResult === "tails" ? tailsId : null;

  const handleCoinAccept = () => {
    if (!coinWinnerId) return;
    dispatch(addUserAcceptance({ restaurantId: coinWinnerId }));
    dispatch(removeUserSelection(coinWinnerId));
    setFlipResult(null);
    setFlipComplete(false);
    setAcceptedModalId(coinWinnerId);
  };

  const handleCoinRemove = () => {
    if (!coinWinnerId) return;
    dispatch(removeUserSelection(coinWinnerId));
    setFlipResult(null);
    setFlipComplete(false);
  };

  const handleRemoveSelection = (id) => {
    dispatch(removeUserSelection(id));
    if (sid(headsId) === sid(id)) setHeadsId(null);
    if (sid(tailsId) === sid(id)) setTailsId(null);
    if (flipComplete) { setFlipResult(null); setFlipComplete(false); }
    if (sid(rouletteWinnerId) === sid(id)) setRouletteWinnerId(null);
  };

  // ── Roulette logic ────────────────────────────────────────
  const handleRouletteSpin = () => {
    if (isSpinning || selections.length < 2) return;
    setRouletteWinnerId(null);
    setIsSpinning(true);
    wheelRef.current?.spin();
  };

  const handleRouletteComplete = (winnerId) => {
    setIsSpinning(false);
    setRouletteWinnerId(winnerId);
  };

  const handleRouletteAccept = () => {
    if (!rouletteWinnerId) return;
    dispatch(addUserAcceptance({ restaurantId: rouletteWinnerId }));
    dispatch(removeUserSelection(rouletteWinnerId));
    setAcceptedModalId(rouletteWinnerId);
    setRouletteWinnerId(null);
  };

  const handleRouletteRemove = () => {
    if (!rouletteWinnerId) return;
    dispatch(removeUserSelection(rouletteWinnerId));
    setRouletteWinnerId(null);
  };

  // ── Drag-and-drop handlers ────────────────────────────────
  const handleDragOver = (e, id) => { e.preventDefault(); setDragOverId(id); };
  const handleDragLeave = () => setDragOverId(null);
  const handleDrop = (e, id) => {
    e.preventDefault();
    const label = e.dataTransfer.getData("label");
    if (label === "heads") {
      if (sid(tailsId) === sid(id)) setTailsId(null);
      setHeadsId((prev) => (sid(prev) === sid(id) ? null : id));
    } else if (label === "tails") {
      if (sid(headsId) === sid(id)) setHeadsId(null);
      setTailsId((prev) => (sid(prev) === sid(id) ? null : id));
    }
    setDragOverId(null);
    setFlipResult(null);
    setFlipComplete(false);
  };

  // ── Render ────────────────────────────────────────────────
  return (
    <>
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex gap-8 items-start">

        {/* ── LEFT: Favorites + mode toggle ────────────────── */}
        <div className="w-64 shrink-0 flex flex-col gap-5">

          <div>
            <h2 className="text-lg font-bold text-gray-900 mb-3">Favorites</h2>
            {favorites.length === 0 && (
              <p className="text-xs text-gray-400 italic">No favorites yet.</p>
            )}
            <div className="flex flex-col gap-3">
              {favorites.map((id) => {
                const rating = getUserRating(reviews, id);
                return (
                  <RestaurantMiniCard
                    key={id}
                    id={id}
                    avgRating={rating}
                    lastChosen={getMostRecentDate(userInfo.accepted, id)}
                    onUnfavorite={() =>
                      dispatch(updateUserFavorites({ restaurantId: id, userId: userInfo.id }))
                    }
                  >
                    <button
                      onClick={() => dispatch(addUserSelection(id))}
                      className="mt-2 w-full rounded text-xs bg-indigo-600 text-white py-1 hover:bg-indigo-500 transition-colors"
                    >
                      + Add to Selections
                    </button>
                  </RestaurantMiniCard>
                );
              })}
            </div>
          </div>

          {/* Mode toggle */}
          <button
            onClick={() => setMode((m) => (m === "coinflip" ? "roulette" : "coinflip"))}
            className={[
              "w-full rounded-lg border-2 py-2.5 px-4 font-semibold text-sm transition-colors",
              mode === "coinflip"
                ? "border-indigo-600 text-indigo-600 hover:bg-indigo-600 hover:text-white"
                : "border-amber-500 text-amber-600 hover:bg-amber-500 hover:text-white",
            ].join(" ")}
          >
            {mode === "coinflip" ? "🎰 Switch to Roulette" : "🪙 Switch to Coin Flip"}
          </button>
        </div>

        {/* ── RIGHT: Selections + game area ────────────────── */}
        <div className="flex-1 flex flex-col gap-8">

          {/* Selections */}
          <div>
            <h2 className="text-lg font-bold text-gray-900 mb-3">Selections</h2>

            {/* Search to add */}
            <div className="relative mb-3">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
                placeholder="Add a restaurant by name…"
                className={`w-full rounded-md border-0 py-1.5 px-3 text-sm shadow-sm ring-1 ring-inset placeholder:text-gray-400 focus:ring-2 focus:ring-inset ${
                  isAlreadyInSelections
                    ? 'text-gray-400 bg-gray-50 ring-gray-200 focus:ring-gray-300'
                    : 'text-gray-900 ring-gray-300 focus:ring-indigo-600'
                }`}
              />
              {isAlreadyInSelections && trimmedQuery && (
                <p className="mt-1 text-xs text-amber-600">Already in your selections</p>
              )}
              {searchFocused && trimmedQuery && !isAlreadyInSelections && (
                <ul className="absolute z-20 mt-1 w-full bg-white rounded-md shadow-lg ring-1 ring-black/5 max-h-52 overflow-y-auto">
                  {searchSuggestions.map(([id, r]) => (
                    <li key={id}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          dispatch(addUserSelection(id));
                          setSearchQuery('');
                        }}
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-indigo-50 hover:text-indigo-700 flex justify-between items-center"
                      >
                        <span>{r.name}</span>
                        <span className="text-xs text-gray-400 ml-2 shrink-0">{r.type}</span>
                      </button>
                    </li>
                  ))}
                  {!searchSuggestions.some(([, r]) => r.name.toLowerCase() === trimmedQuery.toLowerCase()) && (
                    <li>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => handleAddCustom(searchQuery)}
                        className={`w-full text-left px-4 py-2 text-sm text-indigo-600 hover:bg-indigo-50 flex items-center gap-2 ${searchSuggestions.length > 0 ? 'border-t border-gray-100' : ''}`}
                      >
                        <span className="font-medium">+ Add "{trimmedQuery}"</span>
                        <span className="text-xs text-gray-400">as custom entry</span>
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </div>

            <div className={`flex items-center gap-3 mb-3 ${mode !== "coinflip" || selections.length === 0 ? "invisible" : ""}`}>
              <span className="text-xs text-gray-400">Drag to assign:</span>
              <div
                draggable
                onDragStart={(e) => e.dataTransfer.setData("label", "heads")}
                className="cursor-grab active:cursor-grabbing px-4 py-1.5 bg-yellow-400 rounded-lg font-bold text-yellow-900 text-sm shadow-sm hover:bg-yellow-300 transition-colors select-none"
              >
                Heads
              </div>
              <div
                draggable
                onDragStart={(e) => e.dataTransfer.setData("label", "tails")}
                className="cursor-grab active:cursor-grabbing px-4 py-1.5 bg-indigo-500 rounded-lg font-bold text-white text-sm shadow-sm hover:bg-indigo-400 transition-colors select-none"
              >
                Tails
              </div>
            </div>

            {selections.length === 0 && (
              <p className="text-xs text-gray-400 italic">
                Type a name above or add restaurants from your Favorites or the Search page.
              </p>
            )}

            <div className="flex flex-wrap gap-3">
              {selections.map((id) => {
                const rating = getUserRating(reviews, id);
                const badge  = sid(headsId) === sid(id) ? "heads" : sid(tailsId) === sid(id) ? "tails" : null;
                const isWinner =
                  (flipComplete && sid(coinWinnerId) === sid(id)) ||
                  (rouletteWinnerId != null && sid(rouletteWinnerId) === sid(id));
                return (
                  <div
                    key={id}
                    style={{ minWidth: "140px" }}
                    onDragOver={(e) => handleDragOver(e, id)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, id)}
                  >
                    <RestaurantMiniCard
                      id={id}
                      avgRating={rating}
                      lastChosen={getMostRecentDate(userInfo.accepted, id)}
                      badge={badge}
                      isDragOver={sid(dragOverId) === sid(id)}
                      isWinner={isWinner}
                      onRemove={() => handleRemoveSelection(id)}
                      restaurantMap={allRestaurants}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── COIN FLIP ────────────────────────────────────── */}
          {mode === "coinflip" && (
            <div className="flex flex-col items-center gap-5">
              <div className="coin-perspective mt-[27px] mb-[27px]">
                <div
                  className="coin"
                  style={{ transform: `rotateY(${coinRotation}deg)`, transition: coinTransition }}
                >
                  <div className="coin-face coin-heads">
                    <div className="coin-ring">
                      <span className="coin-text-top">{headsId && allRestaurants[headsId]?.name}</span>
                      <span className="coin-symbol">👤</span>
                      <span className="coin-text-bottom">Heads</span>
                    </div>
                  </div>
                  <div className="coin-face coin-tails">
                    <div className="coin-ring">
                      <span className="coin-text-top">{tailsId && allRestaurants[tailsId]?.name}</span>
                      <span className="coin-symbol">🦅</span>
                      <span className="coin-text-bottom">Tails</span>
                    </div>
                  </div>
                </div>
              </div>

              <button
                onClick={handleCoinFlip}
                disabled={isFlipping || flipComplete}
                className="px-8 py-3 rounded-lg bg-indigo-600 text-white font-semibold text-sm hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow"
              >
                {isFlipping ? "Flipping…" : "Choose My Fate"}
              </button>

              {flipComplete && (
                <ResultBanner
                  label={flipResult === "heads" ? "🪙 Heads!" : "🪙 Tails!"}
                  winnerId={coinWinnerId}
                  onAccept={handleCoinAccept}
                  onRemove={handleCoinRemove}
                  restaurantMap={allRestaurants}
                />
              )}
            </div>
          )}

          {/* ── ROULETTE ─────────────────────────────────────── */}
          {mode === "roulette" && (
            <div className="flex flex-col items-center gap-5">
              <RouletteWheel
                ref={wheelRef}
                selections={selections}
                restaurants={allRestaurants}
                onSpinComplete={handleRouletteComplete}
              />

              <button
                onClick={handleRouletteSpin}
                disabled={isSpinning || !!rouletteWinnerId || selections.length < 2}
                className="px-8 py-3 rounded-lg bg-amber-500 text-white font-semibold text-sm hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow"
              >
                {isSpinning ? "Spinning…" : "Choose My Fate"}
              </button>

              {selections.length < 2 && !isSpinning && (
                <p className="text-xs text-gray-400 italic">Add at least 2 selections to spin.</p>
              )}

              {rouletteWinnerId && !isSpinning && (
                <ResultBanner
                  label="🎰 We have a winner!"
                  winnerId={rouletteWinnerId}
                  onAccept={handleRouletteAccept}
                  onRemove={handleRouletteRemove}
                  restaurantMap={allRestaurants}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>

    {acceptedModalId && (
      <AcceptModal
        restaurantId={acceptedModalId}
        userInfo={userInfo}
        onClose={() => setAcceptedModalId(null)}
        restaurantMap={allRestaurants}
      />
    )}
    </>
  );
};

export default HelpMeChoosePage;
