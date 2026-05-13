import { useState, useMemo } from "react";
import { useDispatch, useSelector } from "react-redux";
import RestaurantDetailModal from "../components/RestaurantDetailModal";
import { addUserSelection, updateUserFavorites, addCustomRestaurant } from "../redux/slices/userInfoSlice";
import {
  setNearbyResults, setLocationInput, setRadiusMeters, clearNearby,
  togglePriceFilter, clearPriceFilters, toggleOpenNow, setOpenAtTime,
  toggleDeliveryFilter, toggleTakeoutFilter, setSortBy, setQuery, setCuisineFilter,
} from "../redux/slices/searchSlice";
import useCurrentUser from "../hooks/useCurrentUser";
import RatingDisplay from "../components/RatingDisplay";
import getMostRecentDate from "../utils/getMostRecentDate";
import { api } from "../lib/api";
import { PRICE_LABELS } from "../utils/restaurantConstants";

const RADIUS_OPTIONS = [
  { label: '0.5 mi', meters: 805 },
  { label: '1 mi',   meters: 1609 },
  { label: '3 mi',   meters: 4828 },
  { label: '5 mi',   meters: 8047 },
  { label: '10 mi',  meters: 16093 },
  { label: '25 mi',  meters: 40234 },
];

// ── Hours utils (local restaurants only) ──────────────────────────────────

function parseOpeningMinutes(hours) {
  if (!hours) return null;
  const match = hours.match(/^(\d+):(\d+)\s*(AM|PM)$/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const period = match[3].toUpperCase();
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  return h * 60 + m;
}

function isLocalOpenNow(hours) {
  const opening = parseOpeningMinutes(hours);
  if (opening === null) return true;
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() >= opening;
}

function isLocalOpenAt(hours, timeStr) {
  const opening = parseOpeningMinutes(hours);
  if (opening === null) return true;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m >= opening;
}

// ── Sort key helpers ───────────────────────────────────────────────────────

function localSortKey(id, r, sortBy, currentUser, communityRatings) {
  switch (sortBy) {
    case 'google-desc': return -(r.rating ?? -Infinity);
    case 'personal-desc': {
      const reviews = currentUser.reviews[String(id)];
      if (!reviews?.length) return Infinity;
      return -(reviews.reduce((s, rv) => s + Number(rv.rating), 0) / reviews.length);
    }
    case 'community-desc': {
      const cr = communityRatings[String(id)];
      return cr == null ? Infinity : -cr;
    }
    default: return 0;
  }
}

function nearbySortKey(place, sortBy, currentUser, communityRatings, customRestaurants) {
  const existingEntry = Object.entries(customRestaurants)
    .find(([, r]) => r.googlePlaceId === place.googlePlaceId || r.name === place.name);
  const existingId = existingEntry?.[0];

  switch (sortBy) {
    case 'google-desc': return -(place.googleRating ?? -Infinity);
    case 'personal-desc': {
      if (!existingId) return Infinity;
      const reviews = currentUser.reviews[existingId];
      if (!reviews?.length) return Infinity;
      return -(reviews.reduce((s, rv) => s + Number(rv.rating), 0) / reviews.length);
    }
    case 'community-desc': {
      if (!existingId) return Infinity;
      const cr = communityRatings[existingId];
      return cr == null ? Infinity : -cr;
    }
    case 'distance-asc': return place.distanceKm ?? Infinity;
    case 'distance-desc': return place.distanceKm == null ? Infinity : -place.distanceKm;
    default: return 0;
  }
}

const pillClass = (active) =>
  `px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
    active
      ? 'bg-orange-500 border-orange-500 text-white'
      : 'bg-white border-gray-300 text-gray-600 hover:border-orange-400 hover:text-orange-600'
  }`;

export default function SearchPage() {
  const dispatch = useDispatch();
  const currentUser = useCurrentUser();
  const customRestaurants = useSelector((s) => s.userInfo.customRestaurants);
  const communityRatings  = useSelector((s) => s.rating.communityRatings);

  // ── Persisted search state (Redux) ────────────────────────────
  const {
    nearbyResults, locationInput, radiusMeters, resolvedAddress,
    priceFilters: priceFiltersArray,
    openNowFilter, openAtTime, deliveryFilter, takeoutFilter,
    sortBy, query, cuisineFilter,
  } = useSelector((s) => s.search);

  // Convert array → Set for O(1) membership checks in filter logic
  const priceFilters = new Set(priceFiltersArray);

  // ── Transient UI state (local only) ───────────────────────────
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyError,   setNearbyError]   = useState("");
  const [addingId,      setAddingId]      = useState(null);
  const [detailId,      setDetailId]      = useState(null);

  const canSearch    = locationInput.trim().length > 0 && radiusMeters !== null;
  const isNearbyMode = nearbyResults !== null;

  // ── Handlers ──────────────────────────────────────────────────

  const handleNearbySearch = async () => {
    if (!canSearch) return;
    setNearbyLoading(true);
    setNearbyError("");
    try {
      const { restaurants: places, resolvedAddress: addr } =
        await api.places.nearby(locationInput.trim(), radiusMeters);
      dispatch(setNearbyResults({ results: places, resolvedAddress: addr ?? locationInput.trim() }));
    } catch (err) {
      setNearbyError(err.message ?? "Search failed. Please try again.");
      dispatch(clearNearby());
    } finally {
      setNearbyLoading(false);
    }
  };

  const handleClearNearby = () => {
    dispatch(clearNearby());
    setNearbyError("");
  };

  const handleAddPlacesRestaurant = async (place) => {
    setAddingId(place.googlePlaceId);
    try {
      const { restaurant } = await api.restaurants.create({
        name: place.name,
        googlePlaceId: place.googlePlaceId,
        cuisineType: place.cuisineType ?? undefined,
        priceLevel: place.priceLevel ?? undefined,
        googleRating: place.googleRating ?? undefined,
        takeout: place.takeout,
        delivery: place.delivery,
      });
      const id = String(restaurant.id);
      dispatch(addCustomRestaurant({
        id,
        data: {
          name: place.name,
          type: place.cuisineType ?? 'Restaurant',
          price: place.priceLevel ?? 1,
          rating: place.googleRating ?? null,
          hours: 'N/A',
          phone: 'N/A',
          website: 'N/A',
          yelp: 'N/A',
          takeout: place.takeout,
          delivery: place.delivery,
          googlePlaceId: place.googlePlaceId,
        },
      }));
      dispatch(addUserSelection(id));
    } catch (err) {
      console.error("Failed to add Places restaurant:", err);
    } finally {
      setAddingId(null);
    }
  };

  // ── Build results ──────────────────────────────────────────────
  const cuisineTypes = useMemo(
    () => [...new Set(Object.values(customRestaurants).map((r) => r.type).filter(Boolean))].sort(),
    [customRestaurants],
  );

  const localResults = useMemo(
    () => {
      const filters = new Set(priceFiltersArray);
      return Object.entries(customRestaurants).filter(([, r]) => {
        if (query && !r.name.toLowerCase().startsWith(query.toLowerCase())) return false;
        if (cuisineFilter !== "All" && r.type !== cuisineFilter) return false;
        if (filters.size > 0 && !filters.has(r.price)) return false;
        if (openAtTime) {
          if (!isLocalOpenAt(r.hours, openAtTime)) return false;
        } else if (openNowFilter) {
          if (!isLocalOpenNow(r.hours)) return false;
        }
        if (deliveryFilter && !r.delivery) return false;
        if (takeoutFilter && !r.takeout)   return false;
        return true;
      });
    },
    [customRestaurants, query, cuisineFilter, priceFiltersArray, openAtTime, openNowFilter, deliveryFilter, takeoutFilter],
  );

  const filteredNearby = useMemo(
    () => {
      if (!nearbyResults) return [];
      const filters = new Set(priceFiltersArray);
      return nearbyResults.filter((p) => {
        if (query && !p.name.toLowerCase().startsWith(query.toLowerCase())) return false;
        if (filters.size > 0 && !filters.has(p.priceLevel)) return false;
        if (!openAtTime && openNowFilter && p.openNow === false) return false;
        if (deliveryFilter && !p.delivery) return false;
        if (takeoutFilter && !p.takeout)   return false;
        return true;
      });
    },
    [nearbyResults, query, priceFiltersArray, openAtTime, openNowFilter, deliveryFilter, takeoutFilter],
  );

  const sortedLocal = useMemo(
    () => sortBy === 'none'
      ? localResults
      : [...localResults].sort((a, b) =>
          localSortKey(a[0], a[1], sortBy, currentUser, communityRatings) -
          localSortKey(b[0], b[1], sortBy, currentUser, communityRatings)
        ),
    [localResults, sortBy, currentUser, communityRatings],
  );

  const sortedNearby = useMemo(
    () => sortBy === 'none'
      ? filteredNearby
      : [...filteredNearby].sort((a, b) =>
          nearbySortKey(a, sortBy, currentUser, communityRatings, customRestaurants) -
          nearbySortKey(b, sortBy, currentUser, communityRatings, customRestaurants)
        ),
    [filteredNearby, sortBy, currentUser, communityRatings, customRestaurants],
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">

      {/* ── Location search panel ────────────────────────────── */}
      <div className="rounded-xl border border-orange-100 bg-orange-50 p-4 mb-4">
        <p className="text-xs font-semibold text-orange-500 uppercase tracking-wider mb-3">
          📍 Search Nearby
        </p>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <input
            type="text"
            placeholder="Enter zip code or address…"
            value={locationInput}
            onChange={(e) => { dispatch(setLocationInput(e.target.value)); setNearbyError(""); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && canSearch) handleNearbySearch(); }}
            className="flex-1 rounded-md border-0 py-1.5 px-3 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-orange-500 sm:text-sm"
          />
          <div className="flex gap-2 shrink-0">
            <button
              onClick={handleNearbySearch}
              disabled={!canSearch || nearbyLoading}
              className="px-4 py-1.5 rounded-lg bg-gradient-to-br from-orange-500 to-red-500 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-brand-sm"
            >
              {nearbyLoading ? 'Searching…' : 'Search'}
            </button>
            {isNearbyMode && (
              <button
                onClick={handleClearNearby}
                className="px-4 py-1.5 rounded-md border border-gray-300 bg-white text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Clear nearby
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-3">
          <span className="text-xs text-orange-500 font-medium mr-1">Radius:</span>
          {RADIUS_OPTIONS.map(({ label, meters }) => (
            <button
              key={meters}
              type="button"
              onClick={() => dispatch(setRadiusMeters(meters))}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                radiusMeters === meters
                  ? 'bg-orange-500 border-orange-500 text-white'
                  : 'bg-white border-gray-300 text-gray-600 hover:border-orange-400 hover:text-orange-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {!canSearch && (locationInput.trim() || radiusMeters) && (
          <p className="text-xs text-orange-400 mt-2 italic">
            {!locationInput.trim()
              ? 'Enter an address or zip code to search.'
              : 'Select a radius to search.'}
          </p>
        )}

        {nearbyError && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-1.5 mt-2">
            {nearbyError}
          </p>
        )}
      </div>

      {/* ── Filter panel ─────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 mb-4 flex flex-wrap items-center gap-x-6 gap-y-3">

        {/* Price */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider shrink-0">Price</span>
          {[1, 2, 3, 4].map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => dispatch(togglePriceFilter(level))}
              className={pillClass(priceFilters.has(level))}
            >
              {PRICE_LABELS[level]}
            </button>
          ))}
          {priceFilters.size > 0 && (
            <button
              type="button"
              onClick={() => dispatch(clearPriceFilters())}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        {/* Open now / at time */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider shrink-0">Hours</span>
          <button
            type="button"
            onClick={() => dispatch(toggleOpenNow())}
            className={pillClass(openNowFilter)}
          >
            Open Now
          </button>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-400">at</span>
            <input
              type="time"
              value={openAtTime}
              onChange={(e) => dispatch(setOpenAtTime(e.target.value))}
              className="rounded border border-gray-300 px-1.5 py-0.5 text-xs text-gray-700 focus:ring-1 focus:ring-orange-500 focus:outline-none"
            />
            {openAtTime && (
              <button
                type="button"
                onClick={() => dispatch(setOpenAtTime(""))}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            )}
          </div>
          {isNearbyMode && openAtTime && (
            <span className="text-xs text-amber-600 italic">
              Nearby results show current open/closed only.
            </span>
          )}
        </div>

        {/* Delivery / Takeout */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider shrink-0">Service</span>
          <button
            type="button"
            onClick={() => dispatch(toggleDeliveryFilter())}
            className={pillClass(deliveryFilter)}
          >
            Delivery
          </button>
          <button
            type="button"
            onClick={() => dispatch(toggleTakeoutFilter())}
            className={pillClass(takeoutFilter)}
          >
            Takeout
          </button>
        </div>
      </div>

      {/* ── Name / cuisine search row ────────────────────────── */}
      <div className="flex gap-3 mb-4">
        <input
          type="text"
          placeholder="Search by name…"
          value={query}
          onChange={(e) => dispatch(setQuery(e.target.value))}
          className="block w-full rounded-md border-0 py-1.5 px-3 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-orange-500 sm:text-sm"
        />
        <select
          value={cuisineFilter}
          onChange={(e) => dispatch(setCuisineFilter(e.target.value))}
          className="rounded-md border-0 py-1.5 px-3 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-inset focus:ring-orange-500 sm:text-sm"
        >
          <option value="All">All cuisines</option>
          {cuisineTypes.map(type => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </div>

      {/* ── Saved restaurants section ────────────────────────── */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <p className="text-sm font-semibold text-gray-700">
            Saved Restaurants
            <span className="ml-1.5 text-sm font-normal text-gray-400">({sortedLocal.length})</span>
          </p>

          <div className="flex items-center gap-2 ml-auto">
            <label className="text-xs text-gray-500 font-medium whitespace-nowrap">Sort by:</label>
            <select
              value={sortBy}
              onChange={(e) => dispatch(setSortBy(e.target.value))}
              className="rounded-md border-0 py-1 px-2.5 text-sm text-gray-700 shadow-sm ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-inset focus:ring-orange-500"
            >
              <option value="none">Default</option>
              <option value="google-desc">Google Rating ↑</option>
              <option value="personal-desc">Your Rating ↑</option>
              <option value="community-desc">Community Rating ↑</option>
            </select>
          </div>
        </div>

        {sortedLocal.length === 0 ? (
          <p className="text-gray-500 text-sm">No saved restaurants match your search.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sortedLocal.map(([id, r]) => {
              const isFavorited = currentUser.favorites.map(String).includes(String(id));
              const isSelected  = currentUser.selections.map(String).includes(String(id));
              return (
                <div key={id} onClick={() => setDetailId(id)} className="flex flex-col rounded-lg border border-gray-200 p-4 shadow-sm bg-white cursor-pointer hover:border-orange-300 hover:shadow-md transition-shadow">
                  <div className="flex justify-between items-start">
                    <div className="min-w-0">
                      <span className="text-orange-600 font-semibold">{r.name}</span>
                      {getMostRecentDate(currentUser.accepted, id) && (
                        <span className="ml-2 text-xs text-gray-400 whitespace-nowrap">
                          Last chosen {getMostRecentDate(currentUser.accepted, id)}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); dispatch(updateUserFavorites({ restaurantId: id, userId: currentUser.id })); }}
                      className={`text-xl shrink-0 ${isFavorited ? 'text-red-500' : 'text-gray-300 hover:text-red-300'}`}
                    >
                      &#9829;
                    </button>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">{r.type} · {PRICE_LABELS[r.price]} · Opens {r.hours}</p>
                  <div className="mt-1">
                    <RatingDisplay
                      restaurantId={id}
                      googleRating={r.rating ?? null}
                      personalRating={
                        currentUser.reviews[String(id)]?.length
                          ? currentUser.reviews[String(id)].reduce((s, rv) => s + Number(rv.rating), 0) / currentUser.reviews[String(id)].length
                          : null
                      }
                    />
                  </div>
                  <div className="mt-auto pt-3">
                    <div className="flex gap-2 text-xs text-gray-500 min-h-[1.25rem]">
                      {r.takeout && <span className="bg-gray-100 px-2 py-0.5 rounded">Takeout</span>}
                      {r.delivery && <span className="bg-gray-100 px-2 py-0.5 rounded">Delivery</span>}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); dispatch(addUserSelection(id)); }}
                      disabled={isSelected}
                      className="mt-3 w-full rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-3 py-1.5 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-brand-sm"
                    >
                      {isSelected ? 'Added to selections' : 'Add to selections'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Nearby results section (Places API) ──────────────── */}
      {isNearbyMode && (
        <div>
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <p className="text-sm font-semibold text-gray-700">
              Nearby
              <span className="text-sm font-normal text-gray-500 ml-1">— {resolvedAddress}</span>
              <span className="ml-1.5 text-sm font-normal text-gray-400">({sortedNearby.length})</span>
            </p>
            <div className="flex items-center gap-3 ml-auto">
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500 font-medium whitespace-nowrap">Sort by:</label>
                <select
                  value={sortBy}
                  onChange={(e) => dispatch(setSortBy(e.target.value))}
                  className="rounded-md border-0 py-1 px-2.5 text-sm text-gray-700 shadow-sm ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-inset focus:ring-orange-500"
                >
                  <option value="none">Default</option>
                  <option value="google-desc">Google Rating ↑</option>
                  <option value="personal-desc">Your Rating ↑</option>
                  <option value="community-desc">Community Rating ↑</option>
                  <option value="distance-asc">Distance: Nearest</option>
                  <option value="distance-desc">Distance: Farthest</option>
                </select>
              </div>
            </div>
          </div>

          {sortedNearby.length === 0 && !nearbyLoading ? (
            <p className="text-gray-500 text-sm">No nearby restaurants match your filters.</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {sortedNearby.map((place) => {
                const { googlePlaceId: placeId, name, googleRating, priceLevel, address, cuisineType, openNow, distanceKm } = place;

                const existingEntry = Object.entries(customRestaurants)
                  .find(([, r]) => r.googlePlaceId === placeId || r.name === name);
                const existingId = existingEntry?.[0];
                const isSelected = existingId
                  ? currentUser.selections.map(String).includes(existingId)
                  : false;
                const isAdding = addingId === placeId;

                return (
                  <div
                    key={placeId}
                    onClick={() => existingId && setDetailId(existingId)}
                    className={`flex flex-col rounded-lg border border-gray-200 p-4 shadow-sm bg-white ${existingId ? 'cursor-pointer hover:border-orange-300 hover:shadow-md transition-shadow' : ''}`}
                  >
                    <div className="flex justify-between items-start">
                      <span className="text-orange-600 font-semibold">{name}</span>
                      {openNow != null && (
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ml-2 ${
                          openNow ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
                        }`}>
                          {openNow ? 'Open' : 'Closed'}
                        </span>
                      )}
                    </div>

                    <p className="text-sm text-gray-500 mt-1">
                      {cuisineType ? `${cuisineType} · ` : ''}{PRICE_LABELS[priceLevel] ?? '—'}
                    </p>

                    {address && (
                      <p className="text-xs text-gray-400 mt-0.5 truncate">{address}</p>
                    )}

                    {distanceKm != null && (
                      <p className="text-xs text-orange-400 mt-0.5">
                        {(distanceKm * 0.621371).toFixed(1)} mi away
                      </p>
                    )}

                    {googleRating != null && (
                      <div className="mt-1">
                        <span className="text-xs text-amber-500 font-semibold">★ {googleRating.toFixed(1)}</span>
                        <span className="text-xs text-gray-400 ml-1">Google</span>
                      </div>
                    )}

                    <div className="mt-auto pt-3">
                      <div className="flex gap-2 text-xs text-gray-500 min-h-[1.25rem]">
                        {place.takeout && <span className="bg-gray-100 px-2 py-0.5 rounded">Takeout</span>}
                        {place.delivery && <span className="bg-gray-100 px-2 py-0.5 rounded">Delivery</span>}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); !isSelected && !isAdding && handleAddPlacesRestaurant(place); }}
                        disabled={isSelected || isAdding}
                        className="mt-3 w-full rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-3 py-1.5 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-brand-sm"
                      >
                        {isAdding ? 'Adding…' : isSelected ? 'Added to selections' : 'Add to selections'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}


      {detailId && (
        <RestaurantDetailModal
          restaurantId={detailId}
          restaurantMap={customRestaurants}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  );
}
