import { useState, useMemo, useRef, useEffect, useCallback, lazy, Suspense } from "react";
import { useDispatch, useSelector } from "react-redux";
import RestaurantDetailModal from "../components/RestaurantDetailModal";
import { addUserOption, updateUserFavorites, addCustomRestaurant } from "../redux/slices/userInfoSlice";
import {
  setNearbyResults, setLocationInput, setRadiusMeters, setSearchCuisineType, clearNearby,
  togglePriceFilter, clearPriceFilters, toggleOpenNow, setOpenAtTime,
  toggleDeliveryFilter, toggleTakeoutFilter, setSortBy, setQuery, setCuisineFilter,
  setCurrentPage,
} from "../redux/slices/searchSlice";
import { CUISINE_OPTIONS } from "../utils/cuisineTypes";
import useCurrentUser from "../hooks/useCurrentUser";
import RestaurantCard from "../components/RestaurantCard";
// Lazy: the maps chunk (~13 KB gzip via vendor-maps) loads only when the
// user has nearby results AND has the map toggle on. Pre-search empty
// state and the saved-restaurants view never trigger the network.
const NearbyMap = lazy(() => import("../components/NearbyMap"));
import { buildAcceptedStats, formatLastChosen } from "../utils/acceptedStats";
import { api } from "../lib/api";
// Still imported for the filter UI (price chip selector, etc.) — the card
// component handles its own PRICE_LABELS lookup internally.
import { PRICE_LABELS } from "../utils/restaurantConstants";

// Nearby results per page. Map-visible mode uses a 2-col grid so we fit 10
// (5 rows of 2). Map-hidden mode uses a 3-col grid so 9 (3 rows of 3) lines
// up cleanly. Either way the pagination math reads from the active value
// and the searchSlice resets currentPage on any filter change.
const NEARBY_PAGE_SIZE_WITH_MAP    = 10;
const NEARBY_PAGE_SIZE_WITHOUT_MAP = 9;

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

// ── Cuisine normalization ──────────────────────────────────────────────────
// Saved restaurants store whatever the user typed in (e.g. "Mexican"),
// while Google's Places API returns formal primaryTypeDisplayName labels
// (e.g. "Mexican Restaurant"). Normalizing both lets a single dropdown
// entry filter both data sources — without this, picking "Mexican" would
// match saved-only and "Mexican Restaurant" would match nearby-only, with
// no way for the user to know which form to pick.
function normalizeCuisine(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/\s+restaurant\s*$/i, '').trim();
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

  // O(N) precompute over the user's accepted history; the saved-restaurants
  // row map below reads last-chosen in O(1). Was a full accepted-array scan
  // per visible card on every render.
  const acceptedStats = useMemo(
    () => buildAcceptedStats(currentUser.accepted),
    [currentUser.accepted],
  );

  // ── Persisted search state (Redux) ────────────────────────────
  const {
    nearbyResults, locationInput, radiusMeters, resolvedAddress,
    resolvedLat, resolvedLng,
    // searchCuisineType is the SEARCH-TIME filter (passed to the API
    // so Google only returns places of that cuisine). Distinct from
    // `cuisineFilter` below, which is a post-filter on already-fetched
    // results — see searchSlice for the rationale.
    searchCuisineType,
    priceFilters: priceFiltersArray,
    openNowFilter, openAtTime, deliveryFilter, takeoutFilter,
    sortBy, query, cuisineFilter,
    currentPage,
  } = useSelector((s) => s.search);

  // Convert array → Set for O(1) membership checks in filter logic
  const priceFilters = new Set(priceFiltersArray);

  // ── Transient UI state (local only) ───────────────────────────
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyError,   setNearbyError]   = useState("");
  // "In-flight" tracker for the Add-to-options button on nearby cards.
  // Scoped to that button only — clicking the card body materializes
  // silently and never touches this, so the button doesn't flicker
  // through "Adding…" when the user only meant to open the modal.
  const [addingId,      setAddingId]      = useState(null);
  const [detailId,      setDetailId]      = useState(null);
  // Saved restaurants is a "filter my own collection" surface. On Search,
  // the primary intent is discovery, so we collapse it by default and let
  // the user expand when they want to grep their existing picks.
  const [savedExpanded, setSavedExpanded] = useState(false);

  // Two-way card↔marker sync. `hoveredPlaceId` recolors the matching pin
  // when hovering a card AND adds a ring to the matching card when
  // hovering a pin — both paths set this same state. Local because it's
  // pure UI ephemera that shouldn't survive a refresh.
  const [hoveredPlaceId, setHoveredPlaceId] = useState(null);

  // Stable id-bound handlers for RestaurantCard's `*WithId` props. With
  // RestaurantCard's data resolution now tolerating `id` set without a
  // `restaurantMap`, both saved AND nearby cards can route hover and
  // detail-open through stable callbacks — memo bails out for the cards
  // whose props actually didn't change. Hover sweeping 10 cards used to
  // re-render all 10 per pointer step; now only the 2 whose isHighlighted
  // boolean flipped re-render.
  const handleCardClickWithId      = useCallback((id) => setDetailId(id), []);
  const handleFavoriteToggleWithId = useCallback((id) => {
    dispatch(updateUserFavorites({ restaurantId: id, userId: currentUser?.id }));
  }, [dispatch, currentUser?.id]);
  const handleMouseEnterWithId     = useCallback((id) => {
    setHoveredPlaceId(id);
    // Opportunistic prefetch: kick off materialization when the user first
    // hovers a nearby card. inFlightMaterializations dedups so hovering
    // twice (or hovering then clicking) won't fire duplicate POSTs.
    // Replaces the eager "materialize-all-20-on-search" pass that was
    // wasting writes for results the user never opened.
    const place = placesByIdRef.current.get(id);
    if (place) ensurePlaceMaterialized(place).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps -- ensurePlaceMaterialized is defined later in the function; refs make it safe to skip
  }, []);
  const handleMouseLeaveWithId     = useCallback(() => setHoveredPlaceId(null), []);

  // Map visibility toggle. On desktop the map shares the row with the
  // grid (sticky); on small screens it stacks above. The toggle lets
  // users hide it when they want full-width cards or just don't care.
  // Defaults to true so the feature is discoverable.
  const [mapVisible, setMapVisible] = useState(true);

  // googlePlaceId → Promise<localId>. Used to deduplicate concurrent
  // materializations. After a nearby search we fan out a background
  // materialize for every result so card clicks are instant; if the user
  // clicks a card before its background fetch resolves, we attach to the
  // same promise instead of firing a redundant POST.
  // Lives in a ref (not state) because we don't want re-renders when it
  // mutates — it's an imperative cache, not UI state.
  const inFlightMaterializations = useRef(new Map());

  // Lookup keyed by googlePlaceId — populated whenever new nearby results
  // arrive. Used by the hover handler to find the full Place object given
  // only a placeId, so we can fire on-hover materialization without
  // threading the place data through the stable handler.
  const placesByIdRef = useRef(new Map());

  // Address book — saved locations the user can pick from in a dropdown
  // attached to the location input. The default entry (if any) auto-fills
  // the input on first mount; the rest are available via the dropdown.
  const savedAddresses = currentUser?.addresses ?? [];
  const defaultSavedAddress = savedAddresses.find((a) => a.isDefault)?.address ?? null;

  // ── Trip-override banner (Phase 4) ────────────────────────────
  // When the user has an active, non-archived trip with a primary anchor,
  // we offer a one-click swap of the search location to that anchor's
  // address. This is a soft override — clicking it only fills the input;
  // the user still has to hit search. Matches the address-book interaction
  // (no auto-search on selection, per earlier UX preference).
  const [activeTrips, setActiveTrips] = useState([]);
  // Persistent-for-session dismissal, keyed by trip id but scoped per-user.
  // Without the per-user namespace, a logout-login on the same tab would
  // share the dismissal list across accounts — user A dismissing trip 42
  // would suppress user B's (unrelated) trip 42 banner. Storage key suffix
  // changes with currentUser?.id so the Set we load is the matching one.
  const dismissalStorageKey = `pickyum_trip_banner_dismissed_${currentUser?.id ?? 'guest'}`;
  const [dismissedTripIds, setDismissedTripIds] = useState(() => {
    try {
      const raw = sessionStorage.getItem(dismissalStorageKey);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
  });
  // Re-hydrate the Set when the current user changes (logout→login on same
  // tab). Without this effect, the Set stays bound to whoever was logged
  // in at mount time. Skipped in useEffect deps for sessionStorage itself
  // because sessionStorage isn't a reactive source.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(dismissalStorageKey);
      setDismissedTripIds(new Set(raw ? JSON.parse(raw) : []));
    } catch { setDismissedTripIds(new Set()); }
  }, [dismissalStorageKey]);

  // Fetch trips lazily on mount. Only when the user is authed — the call
  // requires a JWT cookie. Guests just don't get the banner. We also skip
  // when an unauthenticated `api.trips.list` would 401 noisily.
  useEffect(() => {
    if (!currentUser?.id) return;
    let cancelled = false;
    api.trips.list()
      .then(({ trips }) => { if (!cancelled) setActiveTrips(trips ?? []); })
      .catch(() => { /* non-fatal — banner just stays hidden */ });
    return () => { cancelled = true; };
  }, [currentUser?.id]);

  // Pick the most relevant trip-with-anchor to surface in the banner.
  // Priority: trips currently in their date window > future trips > undated
  // trips. Past-end trips are filtered out entirely (no use offering a
  // search override for a finished trip).
  const bannerTrip = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const candidates = activeTrips
      .filter((t) => !t.archivedAt)
      .filter((t) => !dismissedTripIds.has(t.id))
      .map((t) => {
        const primary = t.anchors?.find((a) => a.isPrimary);
        if (!primary) return null;
        const start = t.startDate ? new Date(t.startDate) : null;
        const end   = t.endDate   ? new Date(t.endDate)   : null;
        if (end && end < today) return null;
        // Score: 2 = currently within window, 1 = future, 0 = undated.
        let score = 0;
        if (start && end && start <= today && today <= end) score = 2;
        else if (start && start > today) score = 1;
        return { trip: t, anchor: primary, score, start };
      })
      .filter(Boolean);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Same score: prefer the soonest start date.
      if (!a.start && !b.start) return 0;
      if (!a.start) return 1;
      if (!b.start) return -1;
      return a.start - b.start;
    });
    return candidates[0];
  }, [activeTrips, dismissedTripIds]);

  // Banner action: copy the trip's primary anchor address into the input.
  // No auto-search — the user still presses Search or Enter. Dismissing
  // the banner is also a no-op against the form; only the override-button
  // mutates input.
  const handleUseTripAnchor = () => {
    if (!bannerTrip) return;
    dispatch(setLocationInput(bannerTrip.anchor.address));
    // Don't auto-dismiss after use — the user might want to tweak the
    // address. They can dismiss explicitly if they want it gone.
  };

  const handleDismissBanner = () => {
    if (!bannerTrip) return;
    setDismissedTripIds((prev) => {
      const next = new Set(prev);
      next.add(bannerTrip.trip.id);
      try { sessionStorage.setItem(dismissalStorageKey, JSON.stringify([...next])); } catch { /* sessionStorage off */ }
      return next;
    });
  };

  // One-shot prefill of locationInput from the default saved address.
  // Fires only when the input is empty so we never clobber whatever the
  // user is currently typing. Guarded by a ref so it doesn't re-fire when
  // the user manually clears the input — without that, clearing would
  // immediately repopulate from the saved default, which feels broken.
  const didPrefillFromDefault = useRef(false);
  useEffect(() => {
    if (didPrefillFromDefault.current) return;
    if (defaultSavedAddress && locationInput === '') {
      dispatch(setLocationInput(defaultSavedAddress));
      didPrefillFromDefault.current = true;
    }
  }, [defaultSavedAddress, locationInput, dispatch]);

  // Address-book dropdown toggle + outside-click handling. Closing on
  // outside-click feels more native than a dedicated close button.
  const [addressDropdownOpen, setAddressDropdownOpen] = useState(false);
  const addressDropdownRef = useRef(null);
  useEffect(() => {
    if (!addressDropdownOpen) return;
    const handleClick = (e) => {
      if (addressDropdownRef.current && !addressDropdownRef.current.contains(e.target)) {
        setAddressDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [addressDropdownOpen]);

  // Geolocation state — "locating" is briefly shown after the user taps
  // the button to convey that the browser is fetching coords. `geoError`
  // surfaces denials / unavailable permissions.
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState('');

  // Hits the browser Geolocation API, populates locationInput with the
  // returned coords (the backend's Geocoding pass will resolve them to a
  // human address in the Nearby header), and dispatches an immediate
  // search. The coords-as-string approach saves a round trip — Google's
  // Geocoder happily accepts "lat,lng" as input.
  const handleUseCurrentLocation = () => {
    if (!navigator.geolocation) {
      setGeoError('Your browser does not support location detection.');
      return;
    }
    setGeoError('');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude.toFixed(6);
        const lng = pos.coords.longitude.toFixed(6);
        dispatch(setLocationInput(`${lat},${lng}`));
        setLocating(false);
        // Defer the search one tick so the Redux update lands first; canSearch
        // is computed from the just-updated locationInput.
        setTimeout(() => { handleNearbySearch(); }, 0);
      },
      (err) => {
        setLocating(false);
        const msg = err.code === err.PERMISSION_DENIED
          ? 'Location permission denied. Enable it in your browser settings to use this feature.'
          : err.code === err.POSITION_UNAVAILABLE
          ? 'Could not determine your location — try entering an address.'
          : 'Location request timed out. Try again or enter an address.';
        setGeoError(msg);
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  };

  // Selects an address-book entry: populates the input and closes the
  // dropdown. Deliberately does NOT auto-fire the search — the user may
  // want to tweak the radius, type filters, or further edit the address
  // before committing. They search manually via the Search button or
  // Enter key, matching how typed input behaves.
  const handleSelectAddress = (entry) => {
    dispatch(setLocationInput(entry.address));
    setAddressDropdownOpen(false);
    setGeoError('');
    setNearbyError('');
  };

  const canSearch    = locationInput.trim().length > 0 && radiusMeters !== null;
  const isNearbyMode = nearbyResults !== null;

  // ── Handlers ──────────────────────────────────────────────────

  const handleNearbySearch = async () => {
    if (!canSearch) return;
    setNearbyLoading(true);
    setNearbyError("");
    try {
      // Pass the cuisine slug so the server filters at the Google
      // Places API call rather than after the fact. null/empty falls
      // back to the default 3-slice fan-out across all food types.
      const { restaurants: places, resolvedAddress: addr, resolvedLat, resolvedLng } =
        await api.places.nearby(locationInput.trim(), radiusMeters, searchCuisineType);
      dispatch(setNearbyResults({
        results: places,
        resolvedAddress: addr ?? locationInput.trim(),
        resolvedLat,
        resolvedLng,
      }));

      // Materialization is now deferred to first user intent (hover or
      // click — see onCardClick / onMouseEnter on the nearby cards below).
      // The previous "materialize-all-on-search" pass fired 20 parallel
      // POST /api/restaurants writes for every search; most of those
      // results were never opened, every one invalidated the api.ts cache
      // for /api/restaurants (3-segment prefix rule), and the cluster of
      // writes pegged the server's writeLimiter on power users. The
      // existing inFlightMaterializations dedup keeps the on-demand path
      // race-safe — second hover/click on the same place attaches to the
      // first request rather than firing a new one.
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

  // Ensures a Places result is materialized as a Restaurant row + cached in
  // Redux. Returns the local id string. Used by both the whole-card
  // detail-open click and the "Add to options" button below, and also
  // pre-warmed in the background for every nearby result after a search.
  //
  // Three-tier short-circuit, in order:
  //   1. Already in the Redux cache — return synchronously.
  //   2. Materialization already in flight for this placeId — share the
  //      same promise so concurrent callers don't fire duplicate POSTs.
  //   3. Otherwise, start a new POST and register it in the in-flight Map
  //      until it resolves (then clean up so a future refetch can re-run).
  const ensurePlaceMaterialized = async (place) => {
    const existingEntry = Object.entries(customRestaurants)
      .find(([, r]) => r.googlePlaceId === place.googlePlaceId || r.name === place.name);
    if (existingEntry) return existingEntry[0];

    const inFlight = inFlightMaterializations.current.get(place.googlePlaceId);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const { restaurant } = await api.restaurants.create({
        name: place.name,
        googlePlaceId: place.googlePlaceId,
        cuisineType: place.cuisineType ?? undefined,
        priceLevel: place.priceLevel ?? undefined,
        googleRating: place.googleRating ?? undefined,
        // ratingCount / photos / regularOpeningHours are server-validated
        // and stored on the Restaurant row so Compare/Choose/History
        // (which read by id) get the same data as Search-nearby
        // (which reads from the Places response). Without this pass-
        // through, materialized rows would have empty hours/photos
        // until the refresh-places cron back-filled them. Reviews are
        // intentionally not passed — see googleMapsUrl helper for the
        // cost rationale.
        ratingCount: place.ratingCount ?? undefined,
        photos: place.photos && place.photos.length ? place.photos : undefined,
        regularOpeningHours: place.regularOpeningHours ?? undefined,
        // Phone + website now come back on the nearby search response
        // (Pro tier, same SKU as the rest). Persisting at materialize
        // time means the modal can show these without waiting on
        // refresh-places to back-fill — closes the gap that caused
        // "Phone / Website missing" on freshly-saved nearby cards.
        phone:   place.phone   ?? undefined,
        website: place.website ?? undefined,
        takeout: place.takeout,
        delivery: place.delivery,
        // Pass coords through so the new Restaurant row is map-ready
        // immediately — Compare page can render its pin without
        // waiting for the refresh-places back-fill cycle.
        lat: place.lat ?? undefined,
        lng: place.lng ?? undefined,
      });
      const id = String(restaurant.id);
      dispatch(addCustomRestaurant({
        id,
        data: {
          name: place.name,
          type: place.cuisineType ?? 'Restaurant',
          price: place.priceLevel ?? 1,
          rating: place.googleRating ?? null,
          ratingCount: place.ratingCount ?? null,
          // Mirrored so Compare/Choose cards (which pull from
          // customRestaurants) show the address line just like the
          // Search-nearby card does. Empty string fallback keeps the
          // shape consistent — the card already handles missing values.
          address: place.address ?? null,
          // hours stays null at materialize time (we use the structured
          // regularOpeningHours field instead — see below). Phone +
          // website now ride along on the nearby search response so we
          // can store them immediately; null fallback covers places
          // that don't have them in Google's data. Cards and modals do
          // truthiness checks, so null cleanly hides missing rows.
          hours:   null,
          phone:   place.phone   ?? null,
          website: place.website ?? null,
          takeout: place.takeout,
          delivery: place.delivery,
          googlePlaceId: place.googlePlaceId,
          lat: place.lat ?? null,
          lng: place.lng ?? null,
          // Mirror photo data into the Redux store too so cards pull
          // from the same shape regardless of where they're rendered.
          // Empty array (not null) when the place had none — keeps the
          // shape stable for consumers that do `photos.length` etc.
          photos: place.photos ?? [],
          // Structured hours mirrored so the detail modal can render
          // the weekly table + open-now badge immediately without
          // re-fetching from the server.
          regularOpeningHours: place.regularOpeningHours ?? null,
        },
      }));
      return id;
    })().finally(() => {
      inFlightMaterializations.current.delete(place.googlePlaceId);
    });

    inFlightMaterializations.current.set(place.googlePlaceId, promise);
    return promise;
  };

  // Whole-card click on a nearby result: materialize (if needed) so the
  // detail modal has data to render, then open it. The materialization is
  // silent — doesn't add the Place to the user's options and doesn't
  // touch `addingId`, so the "Add to options" button never flickers
  // through "Adding…" when the user only meant to open the modal.
  //
  // The pre-materialize fan-out in handleNearbySearch usually means this
  // resolves either synchronously (place already cached) or attaches to
  // an in-flight promise, so the modal opens near-instantly.
  const handleOpenPlaceDetail = async (place) => {
    try {
      const id = await ensurePlaceMaterialized(place);
      setDetailId(id);
    } catch (err) {
      console.error("Failed to open place detail:", err);
    }
  };

  const handleAddPlacesRestaurant = async (place) => {
    setAddingId(place.googlePlaceId);
    try {
      const id = await ensurePlaceMaterialized(place);
      dispatch(addUserOption(id));
    } catch (err) {
      console.error("Failed to add Places restaurant:", err);
    } finally {
      setAddingId(null);
    }
  };

  // ── Build results ──────────────────────────────────────────────
  // Dropdown sources from BOTH saved and nearby. Dedupe by normalized key
  // so "Mexican" (saved) and "Mexican Restaurant" (Google nearby) collapse
  // into a single dropdown entry — keep whichever label was seen first.
  const cuisineTypes = useMemo(
    () => {
      const seen = new Map(); // normalized → original label
      const add = (label) => {
        const key = normalizeCuisine(label);
        if (key && !seen.has(key)) seen.set(key, label);
      };
      Object.values(customRestaurants).forEach((r) => add(r.type));
      (nearbyResults ?? []).forEach((p) => add(p.cuisineType));
      return [...seen.values()].sort();
    },
    [customRestaurants, nearbyResults],
  );

  // Pre-compute the normalized filter once per render so neither result
  // memo re-derives it for every row.
  const normalizedCuisineFilter = cuisineFilter === "All" ? null : normalizeCuisine(cuisineFilter);

  const localResults = useMemo(
    () => {
      const filters = new Set(priceFiltersArray);
      return Object.entries(customRestaurants).filter(([, r]) => {
        if (query && !r.name.toLowerCase().startsWith(query.toLowerCase())) return false;
        if (normalizedCuisineFilter && normalizeCuisine(r.type) !== normalizedCuisineFilter) return false;
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
    [customRestaurants, query, normalizedCuisineFilter, priceFiltersArray, openAtTime, openNowFilter, deliveryFilter, takeoutFilter],
  );

  const filteredNearby = useMemo(
    () => {
      if (!nearbyResults) return [];
      const filters = new Set(priceFiltersArray);
      return nearbyResults.filter((p) => {
        if (query && !p.name.toLowerCase().startsWith(query.toLowerCase())) return false;
        if (normalizedCuisineFilter && normalizeCuisine(p.cuisineType) !== normalizedCuisineFilter) return false;
        if (filters.size > 0 && !filters.has(p.priceLevel)) return false;
        if (!openAtTime && openNowFilter && p.openNow === false) return false;
        if (deliveryFilter && !p.delivery) return false;
        if (takeoutFilter && !p.takeout)   return false;
        return true;
      });
    },
    [nearbyResults, query, normalizedCuisineFilter, priceFiltersArray, openAtTime, openNowFilter, deliveryFilter, takeoutFilter],
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

  // ── Lookup maps for nearby-card matching ───────────────────────
  // The grid's per-card matching used to call Object.entries(customRestaurants)
  // .find(...) inside the map callback — O(cards × customRestaurants) per
  // render, ~1000 comparisons for a typical 10-card page with 100 saved
  // restaurants. These two indexes flatten it to O(1) per lookup and only
  // rebuild when customRestaurants actually changes.
  const customByPlaceId = useMemo(() => {
    const m = new Map();
    for (const [id, r] of Object.entries(customRestaurants)) {
      if (r?.googlePlaceId) m.set(r.googlePlaceId, id);
    }
    return m;
  }, [customRestaurants]);

  const customByName = useMemo(() => {
    const m = new Map();
    for (const [id, r] of Object.entries(customRestaurants)) {
      if (r?.name) m.set(r.name, id);
    }
    return m;
  }, [customRestaurants]);

  // Same idea for the "is this already in user's options?" check below —
  // currentUser.options is small but the lookup runs per card. Set lookup
  // is O(1) and the membership check reads cleaner.
  const userOptionsSet = useMemo(
    () => new Set(currentUser.options.map(String)),
    [currentUser.options],
  );

  // ── Pagination derivation ──────────────────────────────────────
  // The slice resets currentPage to 0 on every filter/sort/query change, so
  // we only have to clamp here for the edge case where the persisted page
  // is out of bounds (e.g. user had page=2 but a hot reload swapped in
  // shorter results). Math.max guards against -Infinity from an empty set.
  // Page size swings with map visibility — see the constants at the top.
  // Read off mapVisible directly (a state below) so toggling the map mid-
  // session re-paginates without a remount.
  const nearbyPageSize = mapVisible ? NEARBY_PAGE_SIZE_WITH_MAP : NEARBY_PAGE_SIZE_WITHOUT_MAP;
  const pageCount = Math.max(1, Math.ceil(sortedNearby.length / nearbyPageSize));
  const safePage  = Math.min(currentPage, pageCount - 1);
  const pagedNearby = useMemo(
    () => sortedNearby.slice(safePage * nearbyPageSize, (safePage + 1) * nearbyPageSize),
    [sortedNearby, safePage, nearbyPageSize],
  );

  // Keep placesByIdRef in lockstep with the visible nearby list so the
  // hover-driven materialize handler can resolve placeId → full Place
  // without prop-threading. We populate from `nearbyResults` (the full
  // unfiltered set) so a hover on a filter-hidden card would still work
  // if it ever resurfaced via a filter toggle — but in practice the
  // current page is what fires hovers.
  useEffect(() => {
    const m = new Map();
    for (const p of nearbyResults ?? []) {
      if (p?.googlePlaceId) m.set(p.googlePlaceId, p);
    }
    placesByIdRef.current = m;
  }, [nearbyResults]);

  return (
    // flex-col so the pre-search empty-state can flex-1 and fill the
    // remaining viewport height (parent <main> is flex-1 from the shell).
    // w-full to ensure the column spans <main>'s width before mx-auto caps it.
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 flex flex-col">

      {/* ── Trip-override banner (Phase 4) ───────────────────────
          Sits above the search panel so the suggestion reads as a
          modifier of the search you're about to run, not as part of
          the panel itself. Soft action: fills the input only, doesn't
          search. */}
      {bannerTrip && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-blue-700 mb-0.5">
              🧳 You have an active trip — {bannerTrip.trip.name}
            </p>
            <p className="text-xs text-blue-900/70">
              Search near <span className="font-medium">{bannerTrip.anchor.label}</span>{' '}
              ({bannerTrip.anchor.address}) instead?
            </p>
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleUseTripAnchor}
                className="rounded-md bg-blue-500 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-400"
              >
                Use trip location
              </button>
              <button
                type="button"
                onClick={handleDismissBanner}
                className="text-[11px] font-medium text-blue-700/70 hover:text-blue-900"
              >
                Not now
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={handleDismissBanner}
            aria-label="Dismiss"
            className="text-blue-400 hover:text-blue-700 shrink-0 leading-none text-lg"
          >
            ×
          </button>
        </div>
      )}

      {/* ── Location search panel ────────────────────────────── */}
      <div className="rounded-xl border border-orange-100 bg-orange-50 p-4 mb-4">
        <p className="text-xs font-semibold text-orange-500 uppercase tracking-wider mb-3">
          📍 Search Nearby
        </p>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          {/* Input + address-book dropdown sit in a relative wrapper so
              the dropdown menu can position-absolute beneath the input.
              The wrapper keeps the chevron button visually attached to
              the input's right edge instead of being a separate control. */}
          <div className="relative flex-1" ref={addressDropdownRef}>
            <input
              type="text"
              placeholder="Enter zip code or address…"
              value={locationInput}
              onChange={(e) => { dispatch(setLocationInput(e.target.value)); setNearbyError(""); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && canSearch) handleNearbySearch(); }}
              // pr-9 leaves room for the chevron button below.
              className="w-full rounded-md border-0 py-1.5 pl-3 pr-9 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-orange-500 sm:text-sm"
            />
            {/* Chevron button — only renders when the user has at least
                one saved address. With zero entries it'd just open an
                empty menu, which is noise. */}
            {savedAddresses.length > 0 && (
              <button
                type="button"
                onClick={() => setAddressDropdownOpen((v) => !v)}
                aria-label="Saved addresses"
                aria-expanded={addressDropdownOpen}
                className="absolute inset-y-0 right-0 px-2 flex items-center text-gray-400 hover:text-orange-500 transition-colors"
              >
                <span className={`transition-transform ${addressDropdownOpen ? 'rotate-180' : ''}`}>▾</span>
              </button>
            )}
            {addressDropdownOpen && savedAddresses.length > 0 && (
              <ul className="absolute z-20 mt-1 w-full max-h-60 overflow-y-auto rounded-md bg-white shadow-lg ring-1 ring-black/5 focus:outline-none">
                {savedAddresses.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => handleSelectAddress(entry)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-orange-50 hover:text-orange-700 transition-colors flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-gray-800 truncate">{entry.label}</p>
                        <p className="text-xs text-gray-500 truncate">{entry.address}</p>
                      </div>
                      {entry.isDefault && (
                        <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 shrink-0">
                          Default
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex gap-2 shrink-0 flex-wrap">
            <button
              type="button"
              onClick={handleUseCurrentLocation}
              disabled={locating || nearbyLoading}
              title="Use my current location"
              className="px-3 py-1.5 rounded-md border border-orange-300 bg-white text-sm font-medium text-orange-600 hover:bg-orange-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {locating ? 'Locating…' : '📍 My location'}
            </button>
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

          {/* Cuisine type — search-time pre-filter. Picks which
              Google Places type slug to pass to /api/places/nearby.
              Empty value (default) triggers the server's 3-slice
              fan-out across all food categories; a specific type
              collapses to a single targeted call (max 20 results
              of that cuisine). Distinct from the displayed-results
              post-filter below. */}
          <span className="text-xs text-orange-500 font-medium ml-3 mr-1">Cuisine:</span>
          <select
            value={searchCuisineType ?? ''}
            onChange={(e) => dispatch(setSearchCuisineType(e.target.value || null))}
            className="px-2.5 py-1 rounded-full text-xs font-medium border bg-white border-gray-300 text-gray-700 hover:border-orange-400 focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-200 transition-colors"
          >
            <option value="">Any</option>
            {CUISINE_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        {!canSearch && (locationInput.trim() || radiusMeters) && (
          <p className="text-xs text-orange-400 mt-2 italic">
            {!locationInput.trim()
              ? 'Enter an address or zip code to search.'
              : 'Select a radius to search.'}
          </p>
        )}

        {geoError && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-1.5 mt-2">
            {geoError}
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
          // Asymmetric padding: the right side has to clear the native
          // browser chevron, otherwise long option text (e.g. "All cuisines")
          // overlaps it. Matches the `pl-2 pr-6/8` pattern used elsewhere.
          className="rounded-md border-0 py-1.5 pl-3 pr-8 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-inset focus:ring-orange-500 sm:text-sm"
        >
          <option value="All">All cuisines</option>
          {cuisineTypes.map(type => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </div>

      {/* ── Pre-search empty state ────────────────────────────── */}
      {/* When no nearby search has run yet, the body is mostly whitespace
          (the saved-restaurants section below is collapsed by default and
          may not exist at all for new users). Fill that space with a
          gentle prompt pointing at the search box and shipping a few
          encouragements so the page reads as intentional rather than
          blank. flex-1 makes this absorb leftover vertical height inside
          the SearchPage flex column, which in turn anchors the Footer at
          the bottom of the viewport on short pages. */}
      {!isNearbyMode && (
        <div className="flex-1 flex flex-col items-center justify-center text-center py-12 px-4">
          <div className="text-5xl mb-4 select-none" aria-hidden="true">🍽</div>
          <h2 className="text-xl font-semibold text-gray-700 mb-2">
            Ready to find somewhere to eat?
          </h2>
          <p className="text-sm text-gray-500 max-w-md mb-6">
            Enter a location above to discover nearby restaurants
            {Object.keys(customRestaurants).length > 0 ? ' — or expand your saved restaurants below.' : '.'}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl w-full">
            {[
              { icon: '📍', label: 'Search nearby', body: 'Zip code or address + a radius — we pull live Google data.' },
              { icon: '🎲', label: 'Pick for me',   body: 'Add a few options, then flip a coin or spin the wheel.' },
              { icon: '👥', label: 'Decide together', body: 'Create a group, share a link, vote on where to eat.' },
            ].map(({ icon, label, body }) => (
              <div
                key={label}
                className="rounded-lg border border-orange-100 bg-white/60 p-3 text-left shadow-sm"
              >
                <div className="text-lg mb-1" aria-hidden="true">{icon}</div>
                <p className="text-sm font-semibold text-orange-700">{label}</p>
                <p className="text-xs text-gray-500 leading-snug mt-0.5">{body}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Nearby results section (Places API) ──────────────── */}
      {/* Discovery is the primary intent on this page, so Nearby renders
          BEFORE the user's Saved Restaurants section. Saved is collapsed by
          default below — see the rationale on `savedExpanded`. */}
      {isNearbyMode && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <p className="text-sm font-semibold text-gray-700">
              Nearby
              <span className="text-sm font-normal text-gray-500 ml-1">— {resolvedAddress}</span>
              <span className="ml-1.5 text-sm font-normal text-gray-400">({sortedNearby.length})</span>
            </p>
            <div className="flex items-center gap-3 ml-auto">
              {/* Map toggle — only meaningful when the env key is set
                  AND we have a center to anchor on. Hidden otherwise so
                  the page doesn't promise a feature it can't deliver. */}
              {import.meta.env.VITE_GOOGLE_MAPS_API_KEY && resolvedLat != null && resolvedLng != null && (
                <button
                  type="button"
                  onClick={() => setMapVisible((v) => !v)}
                  aria-pressed={mapVisible}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    mapVisible
                      ? 'bg-orange-500 border-orange-500 text-white'
                      : 'bg-white border-gray-300 text-gray-600 hover:border-orange-400 hover:text-orange-600'
                  }`}
                >
                  {mapVisible ? 'Hide map' : 'Show map'}
                </button>
              )}
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500 font-medium whitespace-nowrap">Sort by:</label>
                <select
                  value={sortBy}
                  onChange={(e) => dispatch(setSortBy(e.target.value))}
                  // pr-8 leaves room for the browser's native chevron so option
              // text doesn't sit underneath it.
              className="rounded-md border-0 py-1 pl-2.5 pr-8 text-sm text-gray-700 shadow-sm ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-inset focus:ring-orange-500"
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

          {/* Two-column split when the map is visible: cards on the
              left, sticky map on the right. The grid drops to 2 cols
              (instead of 3) when the map is showing because the column
              is narrower. On <md the map stacks above the grid; from md
              onwards the map sits beside the cards and the grid drops
              to a single column to fit the narrower left track. */}
          <div className={mapVisible ? 'md:flex md:gap-5 md:items-start' : ''}>
            <div className={mapVisible ? 'md:flex-1 md:min-w-0' : ''}>
              {sortedNearby.length === 0 && !nearbyLoading ? (
                <p className="text-gray-500 text-sm">No nearby restaurants match your filters.</p>
              ) : (
                // Grid responsiveness depends on map state:
                //   - Map visible: 1-col from base up to <lg (cards stack
                //     beside the side map), 2-col at lg+ where there's
                //     enough horizontal room for both.
                //   - Map hidden:  the full responsive ladder (1 → 2 at sm,
                //     → 3 at lg). Same as before.
                <div className={`grid grid-cols-1 gap-4 ${mapVisible ? 'lg:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3'}`}>
                  {pagedNearby.map((place) => {
                    const { googlePlaceId: placeId, name } = place;

                    // Match a freshly-fetched Place against the local customRestaurants
                    // cache so the card can be clickable (open detail) when the row
                    // already exists, and avoid double-add when the user has already
                    // saved it. Prefer googlePlaceId (canonical); fall back to name
                    // for cases where the user saved the restaurant manually before
                    // Google returned a place id. Both lookups are O(1).
                    const existingId = customByPlaceId.get(placeId) ?? customByName.get(name);
                    const isSelected = existingId ? userOptionsSet.has(existingId) : false;
                    const isAdding = addingId === placeId;

                    return (
                      <RestaurantCard
                        key={placeId}
                        // `id` is set purely to power the *WithId hover
                        // callbacks below — RestaurantCard's data resolution
                        // now tolerates `id` without `restaurantMap` and
                        // falls through to `data` as expected.
                        id={placeId}
                        data={place}
                        size="md"
                        // Whole-card click is per-row state (existingId
                        // branch), so this one stays an inline closure.
                        onCardClick={existingId
                          ? () => setDetailId(existingId)
                          : () => handleOpenPlaceDetail(place)}
                        // Stable id-bound hover handlers — memo bails for
                        // cards whose isHighlighted boolean didn't change,
                        // turning a per-pointer-step 10-card re-render
                        // cascade into just the 2 cards that flipped.
                        onMouseEnterWithId={handleMouseEnterWithId}
                        onMouseLeaveWithId={handleMouseLeaveWithId}
                        // Reverse side: when a marker is hovered we ring
                        // the matching card here.
                        isHighlighted={hoveredPlaceId === placeId}
                      >
                        <button
                          onClick={(e) => { e.stopPropagation(); !isSelected && !isAdding && handleAddPlacesRestaurant(place); }}
                          disabled={isSelected || isAdding}
                          className="w-full rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-3 py-1.5 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-brand-sm"
                        >
                          {isAdding ? 'Adding…' : isSelected ? 'Added to options' : 'Add to options'}
                        </button>
                      </RestaurantCard>
                    );
                  })}
                </div>
              )}

          {/* Pagination controls — hidden when there's a single page so we
              don't show a useless "1" with disabled arrows. The page index
              is persisted in searchSlice so navigating away and back keeps
              the user on the page they were viewing. */}
          {pageCount > 1 && (
            <div className="mt-5 flex items-center justify-center gap-1.5 text-sm">
              <button
                type="button"
                onClick={() => dispatch(setCurrentPage(safePage - 1))}
                disabled={safePage === 0}
                className="px-3 py-1 rounded-md border border-gray-300 bg-white text-gray-600 hover:border-orange-400 hover:text-orange-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label="Previous page"
              >
                ‹
              </button>
              {Array.from({ length: pageCount }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => dispatch(setCurrentPage(i))}
                  aria-current={i === safePage ? 'page' : undefined}
                  className={`min-w-[2rem] px-2 py-1 rounded-md border text-sm font-medium transition-colors ${
                    i === safePage
                      ? 'bg-orange-500 border-orange-500 text-white'
                      : 'bg-white border-gray-300 text-gray-600 hover:border-orange-400 hover:text-orange-600'
                  }`}
                >
                  {i + 1}
                </button>
              ))}
              <button
                type="button"
                onClick={() => dispatch(setCurrentPage(safePage + 1))}
                disabled={safePage === pageCount - 1}
                className="px-3 py-1 rounded-md border border-gray-300 bg-white text-gray-600 hover:border-orange-400 hover:text-orange-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label="Next page"
              >
                ›
              </button>
            </div>
          )}
            </div>{/* /left column (cards + pagination) */}

            {/* Map column — sticky beside the cards from md+ so it stays
                put while the user scrolls through the grid. Stacks above
                the grid only on <md (real-mobile widths where there's no
                room for side-by-side). Width grows at lg+ since there's
                more horizontal room. Only renders when the user has the
                map toggled on AND we got a center back from the geocoder. */}
            {mapVisible && resolvedLat != null && resolvedLng != null && (
              // Map column width:
              //   - md   (768-1023): 360 px — enough to read pin labels
              //     while leaving ~400 px for the 1-col cards beside it.
              //   - lg+  (1024+):    560 px — more room for the map at
              //     widths where the cards switch to a 2-col grid.
              <div className="mt-4 md:mt-0 md:w-[360px] lg:w-[560px] md:shrink-0 md:sticky md:top-4 md:self-start">
                <div className="h-[300px] md:h-[calc(100vh-6rem)] rounded-xl overflow-hidden border border-gray-200 shadow-sm bg-gray-50">
                  {/* Suspense fallback is a flat tile so map-chunk fetch
                      doesn't visually disrupt the layout. The component
                      itself initializes Google Maps on mount. */}
                  <Suspense fallback={<div className="h-full w-full bg-gray-100 animate-pulse" />}>
                    <NearbyMap
                      places={pagedNearby}
                      center={{ lat: resolvedLat, lng: resolvedLng }}
                      hoveredId={hoveredPlaceId}
                      onMarkerHover={setHoveredPlaceId}
                      // Marker click → modal. Hover already kicked off
                      // materialization, so the modal usually opens instantly.
                      onMarkerClick={(place) => {
                        const entry = Object.entries(customRestaurants)
                          .find(([, r]) => r.googlePlaceId === place.googlePlaceId || r.name === place.name);
                        if (entry) setDetailId(entry[0]);
                        else handleOpenPlaceDetail(place);
                      }}
                    />
                  </Suspense>
                </div>
              </div>
            )}
          </div>{/* /split wrapper */}
        </div>
      )}

      {/* ── Saved restaurants section ────────────────────────── */}
      {/* Collapsed by default. Hidden entirely when the user has nothing
          saved yet (brand-new users). Header is a toggle button that flips
          the chevron and reveals the sort dropdown + grid. */}
      {Object.keys(customRestaurants).length > 0 && (
        <div className="mb-8">
          <button
            type="button"
            onClick={() => setSavedExpanded((v) => !v)}
            aria-expanded={savedExpanded}
            className="w-full flex items-center gap-2 mb-3 text-left rounded-lg hover:bg-gray-50 transition-colors px-2 py-1.5 -mx-2"
          >
            <span className={`text-gray-400 transition-transform inline-block ${savedExpanded ? 'rotate-90' : ''}`}>▸</span>
            <span className="text-sm font-semibold text-gray-700">Saved Restaurants</span>
            <span className="text-sm font-normal text-gray-400">({sortedLocal.length})</span>
            {!savedExpanded && (
              <span className="ml-auto text-xs text-gray-400">Click to expand</span>
            )}
          </button>

          {savedExpanded && (
            <>
              <div className="flex items-center justify-end mb-3 gap-2">
                <label className="text-xs text-gray-500 font-medium whitespace-nowrap">Sort by:</label>
                <select
                  value={sortBy}
                  onChange={(e) => dispatch(setSortBy(e.target.value))}
                  // pr-8 leaves room for the browser's native chevron so option
                  // text doesn't sit underneath it.
                  className="rounded-md border-0 py-1 pl-2.5 pr-8 text-sm text-gray-700 shadow-sm ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-inset focus:ring-orange-500"
                >
                  <option value="none">Default</option>
                  <option value="google-desc">Google Rating ↑</option>
                  <option value="personal-desc">Your Rating ↑</option>
                  <option value="community-desc">Community Rating ↑</option>
                </select>
              </div>

              {sortedLocal.length === 0 ? (
                <p className="text-gray-500 text-sm">No saved restaurants match your search.</p>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {/* RestaurantCard looks the row up via `restaurantMap`, so the
                      value half of the entry is intentionally unused here. */}
                  {sortedLocal.map(([id]) => {
                    const isFavorited = currentUser.favorites.map(String).includes(String(id));
                    const isSelected  = currentUser.options.map(String).includes(String(id));
                    const personalReviews = currentUser.reviews[String(id)];
                    const personalRating  = personalReviews?.length
                      ? personalReviews.reduce((s, rv) => s + Number(rv.rating), 0) / personalReviews.length
                      : null;
                    return (
                      <RestaurantCard
                        key={id}
                        id={id}
                        restaurantMap={customRestaurants}
                        size="md"
                        personalRating={personalRating}
                        lastChosen={formatLastChosen(acceptedStats, id)}
                        // *WithId variants are stable across renders, so the
                        // memoized RestaurantCard actually bails out instead
                        // of re-rendering every saved card on every keystroke.
                        onCardClickWithId={handleCardClickWithId}
                        isFavorited={isFavorited}
                        onFavoriteToggleWithId={handleFavoriteToggleWithId}
                      >
                        <button
                          onClick={(e) => { e.stopPropagation(); dispatch(addUserOption(id)); }}
                          disabled={isSelected}
                          className="w-full rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-3 py-1.5 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-brand-sm"
                        >
                          {isSelected ? 'Added to options' : 'Add to options'}
                        </button>
                      </RestaurantCard>
                    );
                  })}
                </div>
              )}
            </>
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
