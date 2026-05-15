import { useDispatch, useSelector } from "react-redux";
import { useState, useEffect, useRef, useMemo } from "react";
import { Link, useBlocker } from "react-router-dom";

import {
  addUserAcceptance,
  addUserOption,
  addCustomRestaurant,
  removeUserOption,
  updateUserFavorites,
  incrementFlipCount,
} from "../redux/slices/userInfoSlice";
import { api } from "../lib/api";
import useCurrentUser from "../hooks/useCurrentUser";
import RouletteWheel from "../components/RouletteWheel";
import CreateSessionModal from "../components/CreateSessionModal";
import { buildAcceptedStats, formatLastChosen } from "../utils/acceptedStats";
import { PRICE_LABELS } from "../utils/restaurantConstants";
import RestaurantDetailModal from "../components/RestaurantDetailModal";
import AcceptModal from "../components/AcceptModal";
import RestaurantCard from "../components/RestaurantCard";
import ResultBanner from "../components/ResultBanner";
import "./HelpMeChoosePage.css";

// ── Helpers ───────────────────────────────────────────────────

const avg = (nums) => nums.reduce((a, b) => a + b, 0) / nums.length;

const getUserRating = (reviews, restaurantId) => {
  const list = reviews[String(restaurantId)];
  if (!list || list.length === 0) return null;
  return avg(list.map((r) => r.rating));
};

const sid = (id) => String(id);

const parseOpeningTime = (hoursStr) => {
  if (!hoursStr || hoursStr === 'N/A') return null;
  const match = hoursStr.match(/^(\d+):(\d+)\s*(AM|PM)$/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const isPM = /pm/i.test(match[3]);
  if (isPM && h !== 12) h += 12;
  if (!isPM && h === 12) h = 0;
  return h * 60 + m;
};

const isOpenNow = (hoursStr) => {
  const openMins = parseOpeningTime(hoursStr);
  if (openMins === null) return true;
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() >= openMins;
};

// ── Page ─────────────────────────────────────────────────────

const HelpMeChoosePage = () => {
  const dispatch = useDispatch();
  const userInfo = useCurrentUser();
  const { favorites, options, reviews } = userInfo;

  // O(N) precompute over the user's accepted history; row maps below read
  // last-chosen and counts in O(1) per card. Was N row × M accepted scans
  // per render of the favorites + options grids.
  const acceptedStats = useMemo(
    () => buildAcceptedStats(userInfo.accepted),
    [userInfo.accepted],
  );

  // ── Mode ──────────────────────────────────────────────────
  const [mode, setMode] = useState("coinflip");

  // ── Coin flip ─────────────────────────────────────────────
  const [coinRotation, setCoinRotation]     = useState(0);
  const [coinTransition, setCoinTransition] = useState("none");
  const [coinPhase, setCoinPhase]           = useState('idle'); // idle | anticipate | flipping | settle
  const [flipDuration, setFlipDuration]     = useState(2400);
  const [isFlipping, setIsFlipping]         = useState(false);
  const [flipResult, setFlipResult]         = useState(null);
  const [flipComplete, setFlipComplete]     = useState(false);
  const [sparkles, setSparkles]             = useState([]);

  // ── Touch detection ───────────────────────────────────────
  const [isTouchDevice, setIsTouchDevice] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const handler = (e) => setIsTouchDevice(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // ── Drag-and-drop ─────────────────────────────────────────
  const [headsId, setHeadsId]     = useState(null);
  const [tailsId, setTailsId]     = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  // ── Filters (#1 & #2) ─────────────────────────────────────
  const [priceFilter, setPriceFilter]   = useState(new Set());
  const [cuisineFilter, setCuisineFilter] = useState('');
  const [openNowOnly, setOpenNowOnly]   = useState(false);
  const [avoidDays, setAvoidDays]       = useState(0);
  const [showFilters, setShowFilters]   = useState(false);

  useEffect(() => {
    const ids = options.map(sid);
    if (headsId && !ids.includes(sid(headsId))) setHeadsId(null);
    if (tailsId && !ids.includes(sid(tailsId))) setTailsId(null);
  }, [options, headsId, tailsId]);

  // ── Custom restaurants ────────────────────────────────────
  const customRestaurants = useSelector((state) => state.userInfo.customRestaurants);
  const isAuthenticated   = useSelector((state) => state.auth.status === 'authenticated');
  const allRestaurants    = customRestaurants;

  // ── Computed flip pool ────────────────────────────────────
  // All four derivations below are memoized — they're passed as props to
  // RestaurantCard / RouletteWheel / pill components, so unstable refs
  // cause the entire options grid to re-render on every keystroke or
  // filter toggle. Each dependency list is exactly the inputs the
  // derivation reads.
  const recentIds = useMemo(() => {
    if (avoidDays <= 0) return new Set();
    const cutoff = Date.now() - avoidDays * 86_400_000;
    return new Set(
      userInfo.accepted
        .filter((a) => new Date(a.date).getTime() >= cutoff)
        .map((a) => sid(a.restaurantId))
    );
  }, [avoidDays, userInfo.accepted]);

  const flipPool = useMemo(() => options.filter((id) => {
    const r = allRestaurants[id];
    if (!r) return false;
    if (priceFilter.size > 0 && !priceFilter.has(r.price)) return false;
    if (cuisineFilter && r.type !== cuisineFilter) return false;
    if (openNowOnly && !isOpenNow(r.hours)) return false;
    if (recentIds.has(sid(id))) return false;
    return true;
  }), [options, allRestaurants, priceFilter, cuisineFilter, openNowOnly, recentIds]);

  const flipPoolSet = useMemo(() => new Set(flipPool.map(sid)), [flipPool]);

  const filtersActive =
    priceFilter.size > 0 || cuisineFilter || openNowOnly || avoidDays > 0;

  const optionCuisines = useMemo(
    () => [...new Set(
      options.map((id) => allRestaurants[id]?.type).filter(Boolean)
    )].sort(),
    [options, allRestaurants],
  );

  // ── Custom restaurant add ─────────────────────────────────
  const handleAddCustom = async (name) => {
    const trimmed = name.trim();
    setCustomError('');
    if (!isAuthenticated) {
      const id = `custom-${Date.now()}`;
      dispatch(addCustomRestaurant({
        id,
        data: { name: trimmed, type: 'Custom', price: 1, rating: null, hours: 'N/A', phone: 'N/A', website: 'N/A', yelp: 'N/A', takeout: false, delivery: false },
      }));
      dispatch(addUserOption(id));
      setSearchQuery('');
      return;
    }
    try {
      const { restaurant } = await api.restaurants.create({ name: trimmed });
      const id = String(restaurant.id);
      dispatch(addCustomRestaurant({
        id,
        data: { name: trimmed, type: 'Custom', price: restaurant.priceLevel ?? 1, rating: null, hours: restaurant.hours ?? 'N/A', phone: restaurant.phone ?? 'N/A', website: restaurant.website ?? 'N/A', yelp: restaurant.yelpUrl ?? 'N/A', takeout: restaurant.takeout ?? false, delivery: restaurant.delivery ?? false },
      }));
      dispatch(addUserOption(id));
      setSearchQuery('');
    } catch (err) {
      console.error('Failed to create custom restaurant:', err);
      setCustomError('Could not add that restaurant. Please try again.');
    }
  };

  // ── Accept modal ──────────────────────────────────────────
  const [acceptedModalId, setAcceptedModalId] = useState(null);

  // ── Info modal ────────────────────────────────────────────
  const [detailId, setDetailId] = useState(null);

  // ── Group vote modal ──────────────────────────────────────
  const [showGroupModal, setShowGroupModal] = useState(false);

  // ── Option search ─────────────────────────────────────────
  const [searchQuery, setSearchQuery]   = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [customError, setCustomError]   = useState('');

  const trimmedQuery = searchQuery.trim();

  const isAlreadyInOptions = trimmedQuery
    ? options.some(
        (id) => allRestaurants[id]?.name?.toLowerCase() === trimmedQuery.toLowerCase()
      )
    : false;

  // Memoized so we don't re-walk the full customRestaurants map on every
  // render (e.g. every drag-over event during the H/T assign flow). The
  // lowercase query + Set-based options lookup are also extracted out of
  // the .filter() body so each candidate row is O(1) instead of O(options).
  const searchSuggestions = useMemo(() => {
    if (!trimmedQuery) return [];
    const needle = trimmedQuery.toLowerCase();
    const optionsSet = new Set(options.map(String));
    const matches = [];
    for (const [id, r] of Object.entries(allRestaurants)) {
      if (optionsSet.has(String(id))) continue;
      if (!r.name.toLowerCase().includes(needle)) continue;
      matches.push([id, r]);
      if (matches.length >= 7) break;
    }
    return matches;
  }, [trimmedQuery, options, allRestaurants]);

  // ── Roulette ──────────────────────────────────────────────
  const wheelRef = useRef(null);
  const [isSpinning, setIsSpinning]           = useState(false);
  const [rouletteWinnerId, setRouletteWinnerId] = useState(null);

  // ── Coin flip logic ───────────────────────────────────────
  const generateSparkles = () => Array.from({ length: 12 }).map((_, i) => {
    const angle = (i / 12) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
    const dist  = 70 + Math.random() * 60;
    return {
      id: i,
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist - 8,
      delay: Math.random() * 100,
    };
  });

  const handleCoinFlip = () => {
    if (isFlipping) return;
    setFlipComplete(false);
    setFlipResult(null);
    setSparkles([]);
    dispatch(incrementFlipCount());
    setIsFlipping(true);
    setCoinPhase('anticipate');

    // Phase 1 — anticipation squash, then launch the flip
    setTimeout(() => {
      const seed = (Math.random() * 0.5 + (performance.now() % 1) * 0.3 + (Date.now() % 1000) * 0.0002) % 1;
      const result = seed > 0.5 ? "heads" : "tails";

      const currentAngle = ((coinRotation % 360) + 360) % 360;
      const targetAngle  = result === "tails" ? 180 : 0;
      let angleDelta = (targetAngle - currentAngle + 360) % 360;
      if (angleDelta === 0) angleDelta = 360;
      const delta    = (Math.floor(Math.random() * 6) + 9) * 360 + angleDelta;
      const duration = 2200 + Math.floor(Math.random() * 400);

      setFlipDuration(duration);
      setCoinPhase('flipping');
      setCoinTransition(`transform ${duration}ms cubic-bezier(0.15, 0.65, 0.28, 1)`);
      setCoinRotation((prev) => prev + delta);

      // Phase 2 — flip lands, kick off the settle wobble + reveal flash
      setTimeout(() => {
        setFlipResult(result);
        setFlipComplete(true);
        setCoinTransition("none");
        setCoinPhase('settle');
        setSparkles(generateSparkles());

        // Phase 3 — wobble decays; return to idle
        setTimeout(() => {
          setCoinPhase('idle');
          setIsFlipping(false);
        }, 550);
      }, duration + 50);
    }, 180);
  };

  const coinWinnerId = flipResult === "heads" ? headsId : flipResult === "tails" ? tailsId : null;

  const handleCoinAccept = () => {
    if (!coinWinnerId) return;
    // Snapshot what was "in the running" at this moment — the flip pool,
    // which is the user's options minus filter exclusions. Powers
    // Insights' "competing restaurants" + "often-considered, never-chosen".
    dispatch(addUserAcceptance({
      restaurantId: coinWinnerId,
      optionsSnapshot: flipPool.map(String),
      chooseMethod: 'flip',
    }));
    dispatch(removeUserOption(coinWinnerId));
    setFlipResult(null);
    setFlipComplete(false);
    setSparkles([]);
    setAcceptedModalId(coinWinnerId);
  };

  const handleCoinRemove = () => {
    if (!coinWinnerId) return;
    dispatch(removeUserOption(coinWinnerId));
    setFlipResult(null);
    setFlipComplete(false);
    setSparkles([]);
  };

  const handleRemoveOption = (id) => {
    dispatch(removeUserOption(id));
    if (sid(headsId) === sid(id)) setHeadsId(null);
    if (sid(tailsId) === sid(id)) setTailsId(null);
    if (flipComplete) { setFlipResult(null); setFlipComplete(false); }
    if (sid(rouletteWinnerId) === sid(id)) setRouletteWinnerId(null);
  };

  // ── Roulette logic ────────────────────────────────────────
  const handleRouletteSpin = () => {
    if (isSpinning || flipPool.length < 2) return;
    setRouletteWinnerId(null);
    setIsSpinning(true);
    dispatch(incrementFlipCount());
    wheelRef.current?.spin();
  };

  const handleRouletteComplete = (winnerId) => {
    setIsSpinning(false);
    setRouletteWinnerId(winnerId);
  };

  const handleRouletteAccept = () => {
    if (!rouletteWinnerId) return;
    dispatch(addUserAcceptance({
      restaurantId: rouletteWinnerId,
      optionsSnapshot: flipPool.map(String),
      chooseMethod: 'spin',
    }));
    dispatch(removeUserOption(rouletteWinnerId));
    setAcceptedModalId(rouletteWinnerId);
    setRouletteWinnerId(null);
  };

  const handleRouletteRemove = () => {
    if (!rouletteWinnerId) return;
    dispatch(removeUserOption(rouletteWinnerId));
    setRouletteWinnerId(null);
  };

  // ── Tap-to-assign handlers ────────────────────────────────
  const handleTapAssign = (id, label) => {
    if (!flipPoolSet.has(sid(id))) return;
    if (label === 'heads') {
      if (sid(tailsId) === sid(id)) setTailsId(null);
      setHeadsId((prev) => (sid(prev) === sid(id) ? null : id));
    } else {
      if (sid(headsId) === sid(id)) setHeadsId(null);
      setTailsId((prev) => (sid(prev) === sid(id) ? null : id));
    }
    setFlipResult(null);
    setFlipComplete(false);
  };

  // ── Drag-and-drop handlers ────────────────────────────────
  const handleDragOver  = (e, id) => { e.preventDefault(); setDragOverId(id); };
  const handleDragLeave = () => setDragOverId(null);
  const handleDrop = (e, id) => {
    e.preventDefault();
    // Prevent assigning Heads/Tails to cards excluded from the flip pool
    if (!flipPoolSet.has(sid(id))) { setDragOverId(null); return; }
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

  // ── Navigation block while result is pending ─────────────
  const hasUnresolvedResult =
    (flipComplete && !!coinWinnerId) || (!!rouletteWinnerId && !isSpinning);

  const blocker = useBlocker(hasUnresolvedResult);

  useEffect(() => {
    if (!hasUnresolvedResult) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnresolvedResult]);

  // ── Render ────────────────────────────────────────────────
  return (
    <>
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col lg:flex-row gap-8 items-start">

        {/* ── LEFT: Favorites + mode toggle ────────────────── */}
        <div className="w-full lg:w-64 lg:shrink-0 flex flex-col gap-5">

          <div>
            <h2 className="text-lg font-bold text-gray-900 mb-3">Favorites</h2>
            {favorites.length === 0 && (
              <p className="text-xs text-gray-400 italic">No favorites yet.</p>
            )}
            {/* Cap at roughly 6 cards when the favorites list is long, so it
                doesn't push the entire Choose page taller. These sm cards
                carry an extra "+ Add to Options" button (~36px) so we use a
                larger max-height than the Compare page's identical-purpose
                cap. overscroll-contain prevents wheel/touch scroll from
                escaping to the page once the user reaches the edge. */}
            <div className={`flex flex-col gap-3 ${favorites.length > 6 ? 'max-h-[1040px] overflow-y-auto overscroll-contain pr-1' : ''}`}>
              {favorites.map((id) => {
                const rating = getUserRating(reviews, id);
                return (
                  <RestaurantCard
                    key={id}
                    id={id}
                    size="sm"
                    restaurantMap={allRestaurants}
                    personalRating={rating}
                    lastChosen={formatLastChosen(acceptedStats, id)}
                    onUnfavorite={() =>
                      dispatch(updateUserFavorites({ restaurantId: id, userId: userInfo.id }))
                    }
                    onInfo={() => setDetailId(id)}
                  >
                    <button
                      onClick={() => dispatch(addUserOption(id))}
                      className="mt-2 w-full rounded-lg text-xs bg-gradient-to-br from-orange-500 to-red-500 text-white py-1 hover:from-orange-400 hover:to-red-400 transition-all shadow-brand-sm"
                    >
                      + Add to Options
                    </button>
                  </RestaurantCard>
                );
              })}
            </div>
          </div>

          {/* Mode toggle */}
          <button
            onClick={() => {
              setMode((m) => {
                if (m === "coinflip") {
                  setHeadsId(null);
                  setTailsId(null);
                  setFlipResult(null);
                  setFlipComplete(false);
                  return "roulette";
                }
                setRouletteWinnerId(null);
                return "coinflip";
              });
            }}
            className={[
              "w-full rounded-lg border-2 py-2.5 px-4 font-semibold text-sm transition-colors",
              mode === "coinflip"
                ? "border-orange-500 text-orange-600 hover:bg-orange-500 hover:text-white"
                : "border-amber-500 text-amber-600 hover:bg-amber-500 hover:text-white",
            ].join(" ")}
          >
            {mode === "coinflip" ? "🎰 Switch to Roulette" : "🪙 Switch to Coin Flip"}
          </button>

          {/* Surprise me — picks a random restaurant from the flip pool and
              records it as an acceptance for Insights tracking. */}
          <button
            onClick={() => {
              if (flipPool.length < 1) return;
              const randomId = flipPool[Math.floor(Math.random() * flipPool.length)];
              dispatch(addUserAcceptance({
                restaurantId: randomId,
                optionsSnapshot: flipPool.map(String),
                chooseMethod: 'surprise',
              }));
              dispatch(removeUserOption(randomId));
              setAcceptedModalId(randomId);
            }}
            disabled={flipPool.length < 1}
            className="w-full rounded-lg border-2 border-purple-500 py-2.5 px-4 font-semibold text-sm text-purple-600 hover:bg-purple-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            🎲 Surprise Me
          </button>

          {/* Group vote */}
          <button
            onClick={() => setShowGroupModal(true)}
            disabled={flipPool.length < 2}
            className="w-full rounded-lg border-2 border-emerald-500 py-2.5 px-4 font-semibold text-sm text-emerald-600 hover:bg-emerald-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            👥 Group Vote
          </button>
        </div>

        {/* ── RIGHT: Options + game area ────────────────── */}
        <div className="flex-1 flex flex-col gap-8">

          {/* Options */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold text-gray-900">Options</h2>
              <button
                onClick={() => setShowFilters((f) => !f)}
                className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border transition-colors ${
                  filtersActive
                    ? 'bg-orange-50 border-orange-300 text-orange-600'
                    : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
                }`}
              >
                {filtersActive ? '⚙ Filters active' : '⚙ Filters'}
                {filtersActive && flipPool.length !== options.length && (
                  <span className="ml-0.5 font-semibold">{flipPool.length}/{options.length}</span>
                )}
              </button>
            </div>

            {/* ── Filter panel ─────────────────────────────── */}
            {showFilters && (
              <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 flex flex-col gap-3">

                {/* Price */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium text-gray-500 w-14 shrink-0">Price</span>
                  {[1, 2, 3, 4].map((p) => (
                    <button
                      key={p}
                      onClick={() => setPriceFilter((prev) => {
                        const next = new Set(prev);
                        if (next.has(p)) next.delete(p); else next.add(p);
                        return next;
                      })}
                      className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border transition-colors ${
                        priceFilter.has(p)
                          ? 'bg-orange-500 border-orange-500 text-white'
                          : 'bg-white border-gray-300 text-gray-600 hover:border-orange-400'
                      }`}
                    >
                      {PRICE_LABELS[p]}
                    </button>
                  ))}
                  {priceFilter.size > 0 && (
                    <button onClick={() => setPriceFilter(new Set())} className="text-xs text-gray-400 hover:text-gray-600">
                      Clear
                    </button>
                  )}
                </div>

                {/* Cuisine */}
                {optionCuisines.length > 1 && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-500 w-14 shrink-0">Cuisine</span>
                    <select
                      value={cuisineFilter}
                      onChange={(e) => setCuisineFilter(e.target.value)}
                      className="text-xs rounded border border-gray-300 pl-2 pr-8 py-1 focus:outline-none focus:ring-1 focus:ring-orange-500 bg-white"
                    >
                      <option value="">All</option>
                      {optionCuisines.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Open now + avoid recent */}
                <div className="flex items-center gap-4 flex-wrap">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={openNowOnly}
                      onChange={(e) => setOpenNowOnly(e.target.checked)}
                      className="rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                    />
                    <span className="text-xs font-medium text-gray-600">Open now</span>
                  </label>

                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-gray-600">Avoid visited in last</span>
                    <select
                      value={avoidDays}
                      onChange={(e) => setAvoidDays(Number(e.target.value))}
                      className="text-xs rounded border border-gray-300 pl-2 pr-8 py-1 focus:outline-none focus:ring-1 focus:ring-orange-500 bg-white"
                    >
                      <option value={0}>Off</option>
                      <option value={3}>3 days</option>
                      <option value={7}>7 days</option>
                      <option value={14}>14 days</option>
                    </select>
                  </div>
                </div>

                {/* Pool summary */}
                <p className="text-xs text-gray-400">
                  {flipPool.length === 0
                    ? 'No options match these filters.'
                    : flipPool.length === options.length
                    ? 'All options in flip pool.'
                    : `${flipPool.length} of ${options.length} options in flip pool.`}
                </p>
              </div>
            )}

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
                  isAlreadyInOptions
                    ? 'text-gray-400 bg-gray-50 ring-gray-200 focus:ring-gray-300'
                    : 'text-gray-900 ring-gray-300 focus:ring-orange-500'
                }`}
              />
              {isAlreadyInOptions && trimmedQuery && (
                <p className="mt-1 text-xs text-amber-600">Already in your options</p>
              )}
              {customError && (
                <p className="mt-1 text-xs text-red-600">{customError}</p>
              )}
              {searchFocused && trimmedQuery && !isAlreadyInOptions && (
                <ul className="absolute z-20 mt-1 w-full bg-white rounded-md shadow-lg ring-1 ring-black/5 max-h-52 overflow-y-auto">
                  {searchSuggestions.map(([id, r]) => (
                    <li key={id}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { dispatch(addUserOption(id)); setSearchQuery(''); }}
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-orange-50 hover:text-orange-700 flex justify-between items-center"
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
                        className={`w-full text-left px-4 py-2 text-sm text-orange-600 hover:bg-orange-50 flex items-center gap-2 ${searchSuggestions.length > 0 ? 'border-t border-gray-100' : ''}`}
                      >
                        <span className="font-medium">+ Add "{trimmedQuery}"</span>
                        <span className="text-xs text-gray-400">as custom entry</span>
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </div>

            {mode === "coinflip" && options.length > 0 && (
              isTouchDevice ? (
                <p className="mb-3 text-xs text-gray-400">Tap H / T on a card to assign heads or tails.</p>
              ) : (
                <div className="flex items-center gap-2 mb-3 text-xs text-gray-400">
                  <span>Drag to assign:</span>
                  <div
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("label", "heads")}
                    className="cursor-grab active:cursor-grabbing px-2.5 py-1 bg-yellow-400 rounded font-bold text-yellow-900 text-xs hover:bg-yellow-300 transition-colors select-none"
                  >
                    H
                  </div>
                  <div
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("label", "tails")}
                    className="cursor-grab active:cursor-grabbing px-2.5 py-1 bg-orange-500 rounded font-bold text-white text-xs hover:bg-orange-400 transition-colors select-none"
                  >
                    T
                  </div>
                </div>
              )
            )}

            {options.length === 0 && (
              <p className="text-xs text-gray-400 italic">
                Type a name above or add restaurants from your Favorites or the Search page.
              </p>
            )}

            <div className="flex flex-wrap gap-3">
              {options.map((id) => {
                const rating    = getUserRating(reviews, id);
                const badge     = sid(headsId) === sid(id) ? "heads" : sid(tailsId) === sid(id) ? "tails" : null;
                const isWinner  =
                  (flipComplete && sid(coinWinnerId) === sid(id)) ||
                  (rouletteWinnerId != null && sid(rouletteWinnerId) === sid(id));
                const isExcluded = !flipPoolSet.has(sid(id));
                return (
                  <div
                    key={id}
                    // flex column makes the wrapper a flex item with stretched
                    // height in its row, and h-full on the inner card fills it
                    // — keeps cards in the same row aligned to the tallest.
                    style={{ minWidth: "140px", maxWidth: "180px" }}
                    className="flex flex-col"
                    onDragOver={!isTouchDevice ? (e) => handleDragOver(e, id) : undefined}
                    onDragLeave={!isTouchDevice ? handleDragLeave : undefined}
                    onDrop={!isTouchDevice ? (e) => handleDrop(e, id) : undefined}
                  >
                    <RestaurantCard
                      id={id}
                      size="sm"
                      personalRating={rating}
                      lastChosen={formatLastChosen(acceptedStats, id)}
                      badge={badge}
                      isDragOver={!isTouchDevice && sid(dragOverId) === sid(id)}
                      isWinner={isWinner}
                      isExcluded={isExcluded}
                      onRemove={() => handleRemoveOption(id)}
                      onInfo={() => setDetailId(id)}
                      onAssignHeads={mode === "coinflip" && isTouchDevice ? () => handleTapAssign(id, "heads") : undefined}
                      onAssignTails={mode === "coinflip" && isTouchDevice ? () => handleTapAssign(id, "tails") : undefined}
                      restaurantMap={allRestaurants}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── EMPTY STATE ──────────────────────────────────── */}
          {flipPool.length < 2 && (
            <div className="rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 py-10 px-6 text-center">
              <p className="text-4xl mb-3">🍽️</p>
              <p className="text-lg font-semibold text-gray-800 mb-1">
                {options.length === 0
                  ? "Nothing to flip yet"
                  : options.length === 1
                  ? "Add one more to start flipping"
                  : "Not enough in your flip pool"}
              </p>
              <p className="text-sm text-gray-500 mb-5 max-w-xs mx-auto">
                {options.length === 0
                  ? "Add at least 2 restaurants to your options to use the coin flip or roulette."
                  : options.length === 1
                  ? "You have 1 option — add one more to start flipping."
                  : "Your active filters are excluding too many options. Try adjusting them above."}
              </p>
              {options.length < 2 && (
                <Link
                  to="/"
                  className="inline-block rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-5 py-2.5 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 transition-all shadow-brand-sm"
                >
                  Find restaurants on Search →
                </Link>
              )}
            </div>
          )}

          {/* ── COIN FLIP ────────────────────────────────────── */}
          {flipPool.length >= 2 && mode === "coinflip" && (
            <div className="flex flex-col items-center gap-5">
              <div className="coin-perspective mt-[27px] mb-[27px]">
                {flipComplete && coinWinnerId && (
                  <>
                    <div key={`glow-${flipResult}-${coinWinnerId}`} className="coin-glow" />
                    {sparkles.map((s) => (
                      <div
                        key={s.id}
                        className="coin-sparkle"
                        style={{
                          '--sparkle-dx': `${s.dx}px`,
                          '--sparkle-dy': `${s.dy}px`,
                          '--sparkle-delay': `${s.delay}ms`,
                        }}
                      />
                    ))}
                  </>
                )}
                <div className={`coin-shell ${coinPhase !== 'idle' ? coinPhase : ''}`}>
                  <div
                    className={`coin-toss ${coinPhase === 'flipping' ? 'flipping' : ''}`}
                    style={{ '--flip-duration': `${flipDuration}ms` }}
                  >
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
                </div>
              </div>

              <button
                onClick={handleCoinFlip}
                disabled={isFlipping || flipComplete}
                className="px-8 py-3 rounded-lg bg-gradient-to-br from-orange-500 to-red-500 text-white font-semibold text-sm hover:from-orange-400 hover:to-red-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-brand-sm"
              >
                {isFlipping ? "Flipping…" : "Flip"}
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
          {flipPool.length >= 2 && mode === "roulette" && (
            <div className="flex flex-col items-center gap-5">
              <RouletteWheel
                ref={wheelRef}
                options={flipPool}
                restaurants={allRestaurants}
                onSpinComplete={handleRouletteComplete}
              />

              <button
                onClick={handleRouletteSpin}
                disabled={isSpinning || !!rouletteWinnerId}
                className="px-8 py-3 rounded-lg bg-amber-500 text-white font-semibold text-sm hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow"
              >
                {isSpinning ? "Spinning…" : "Spin"}
              </button>

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

    {showGroupModal && (
      <CreateSessionModal
        flipPool={flipPool}
        restaurantMap={allRestaurants}
        defaultHostName={userInfo.username ?? ''}
        onClose={() => setShowGroupModal(false)}
      />
    )}
    {detailId && (
      <RestaurantDetailModal
        restaurantId={detailId}
        restaurantMap={allRestaurants}
        onClose={() => setDetailId(null)}
      />
    )}

    {blocker.state === 'blocked' && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 flex flex-col gap-4">
          <div>
            <p className="font-semibold text-gray-900">Leave without deciding?</p>
            <p className="text-sm text-gray-500 mt-1">You have an unresolved result. Accept or remove it before leaving.</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => blocker.reset()}
              className="flex-1 rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-4 py-2 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 transition-all shadow-brand-sm"
            >
              Stay
            </button>
            <button
              onClick={() => blocker.proceed()}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Leave anyway
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
};

export default HelpMeChoosePage;
