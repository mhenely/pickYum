import { useState, useEffect, useRef } from 'react';
import { Dialog, DialogPanel } from '@headlessui/react';
import { XMarkIcon, ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { useDispatch, useSelector } from 'react-redux';
import { addUserOption, removeUserOption, setRestaurantNote, persistAddReview, removeUserReview, addUserAcceptance, setMatchOptOut, updateCustomRestaurant, toggleAcceptedExcludeFromInsights } from '../redux/slices/userInfoSlice';
import { showChosenCelebration } from '../redux/slices/celebrationSlice';
import useCurrentUser from '../hooks/useCurrentUser';
import InfoRow from './InfoRow';
import HeartWithKebab from './HeartWithKebab';
import { PRICE_LABELS } from '../utils/restaurantConstants';
import { normalizeUrl } from '../utils/normalizeUrl';
import { googleMapsUrl } from '../utils/googleMapsUrl';
import { getOpenStatus, formatLocalTime } from '../utils/openingHours';
import { socialApi } from '../lib/socialApi';
import { api, placePhotoUrl } from '../lib/api';

const sid = (id) => String(id);
const mean = (nums) => nums.reduce((a, b) => a + b, 0) / nums.length;

// ── Photo gallery (hero + arrow nav + thumbnail strip) ──────────────────
// First photo renders as a hero (~h-48); remaining photos sit below in a
// thumbnail row. Two ways to flip through: clicking a thumb, or the
// prev/next chevron buttons that overlay the hero (only shown when
// there's more than one photo). State is local so the gallery resets
// to the first photo each time the modal reopens. All photos go
// through our /api/places/photo proxy so the Google API key stays
// server-side. Index wraps in both directions for a "carousel" feel —
// pressing next from the last photo lands on the first.
function PhotoGallery({ photos, restaurantName }) {
  const [active, setActive] = useState(0);
  // Defensive — `photos[active]?.name` is the proxy URL input. If a
  // photo entry is missing `name` somehow, skip it so we never call the
  // proxy with an invalid value.
  const valid = photos.filter((p) => p?.name);
  if (valid.length === 0) return null;
  const safeActive = Math.min(active, valid.length - 1);
  const hero = valid[safeActive];
  const hasMultiple = valid.length > 1;

  const prev = () => setActive((i) => (i - 1 + valid.length) % valid.length);
  const next = () => setActive((i) => (i + 1) % valid.length);

  return (
    <div className="rounded-t-xl overflow-hidden">
      <div className="relative h-48 bg-gray-100">
        <img
          key={hero.name}
          src={placePhotoUrl(hero, 1200)}
          alt={restaurantName}
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
        {hasMultiple && (
          <>
            {/* Prev / next chevrons — fixed-position overlay, semi-
                transparent so the photo shows through. type="button"
                so they don't accidentally submit any parent form
                (the modal isn't a form today, but defensive). */}
            <button
              type="button"
              onClick={prev}
              aria-label="Previous photo"
              className="absolute left-2 top-1/2 -translate-y-1/2 h-8 w-8 flex items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors"
            >
              <ChevronLeftIcon className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={next}
              aria-label="Next photo"
              className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 flex items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors"
            >
              <ChevronRightIcon className="h-5 w-5" />
            </button>
            {/* Position counter — "3 / 5" in the top-right corner.
                Helps users know how many photos are in the carousel
                without having to scan the thumbnail strip. Lives in
                the TOP-right (not bottom) because the thumbnail
                strip below the hero butts right up against the
                hero's bottom edge, leaving no visual breathing room
                for a bottom-right chip — it ended up looking like
                it was sitting ON the thumbnails. Top-right is also
                a more conventional spot for photo counters
                (matches Google Maps / Instagram / Airbnb). */}
            <span className="absolute top-2 right-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white tabular-nums">
              {safeActive + 1} / {valid.length}
            </span>
          </>
        )}
      </div>
      {hasMultiple && (
        <div className="flex gap-1 p-2 bg-gray-50 overflow-x-auto">
          {valid.slice(0, 5).map((ph, i) => (
            <button
              key={ph.name}
              type="button"
              onClick={() => setActive(i)}
              className={`relative h-14 w-20 shrink-0 overflow-hidden rounded transition-all ${
                i === safeActive ? 'ring-2 ring-orange-500' : 'opacity-80 hover:opacity-100'
              }`}
            >
              <img
                src={placePhotoUrl(ph, 200)}
                alt=""
                loading="lazy"
                className="absolute inset-0 h-full w-full object-cover"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Rating chip (Google / Yours / Community) ────────────────────────────
// One inline group: "Google ★ 4.5 (800)". All three sources sit in a
// single horizontal row so the rating section claims one line of
// vertical space instead of three stacked tiles. Color is on the label
// and value only — no background fill — which lets the three groups
// read as a single band. Em-dash when the rating is missing, keeping
// the layout stable across restaurants with thin data.
function RatingChip({ label, value, count, accent }) {
  // accent: 'amber' (Google) | 'orange' (Yours) | 'purple' (Community)
  // Inlined classes (rather than computed via template-string concat)
  // so Tailwind's JIT actually sees the full class names at build time.
  const theme = {
    amber:  { label: 'text-amber-700',  value: 'text-amber-700',  count: 'text-amber-700/70' },
    orange: { label: 'text-orange-700', value: 'text-orange-700', count: 'text-orange-700/70' },
    purple: { label: 'text-purple-700', value: 'text-purple-700', count: 'text-purple-700/70' },
  }[accent];
  const hasValue = value != null && !Number.isNaN(Number(value));
  return (
    <div className="flex items-baseline gap-1 min-w-0">
      <span className={`text-[10px] font-semibold uppercase tracking-wider ${theme.label}`}>
        {label}
      </span>
      <span className={`text-sm font-bold tabular-nums ${theme.value}`}>
        {hasValue ? `★ ${Number(value).toFixed(1)}` : '—'}
      </span>
      {typeof count === 'number' && count > 0 && (
        <span className={`text-[10px] tabular-nums ${theme.count}`}>
          ({count.toLocaleString()})
        </span>
      )}
    </div>
  );
}

// ── Open-now / closing-soon status pill ─────────────────────────────────
// Renders one of four states:
//   - Open + closing in <= 60 min → yellow "Closing soon · 9:30 PM"
//   - Open                       → green  "Open now · until 9:30 PM"
//   - Closed                     → red    "Closed · opens 11:00 AM"
//   - No data                    → null (caller decides whether to skip
//                                  the whole hours block or fall back to
//                                  a free-form `hours` string)
function OpenStatusBadge({ status }) {
  if (!status.hasData) return null;
  const base = 'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold';
  if (status.isOpen && status.closingSoon) {
    return (
      <span className={`${base} bg-yellow-100 text-yellow-800`}>
        <span className="h-1.5 w-1.5 rounded-full bg-yellow-500" />
        Closing soon
        {status.closesAt && (
          <span className="font-normal opacity-70"> · {formatLocalTime(status.closesAt)}</span>
        )}
      </span>
    );
  }
  if (status.isOpen) {
    return (
      <span className={`${base} bg-green-100 text-green-700`}>
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
        Open now
        {status.closesAt && (
          <span className="font-normal opacity-70"> · until {formatLocalTime(status.closesAt)}</span>
        )}
      </span>
    );
  }
  return (
    <span className={`${base} bg-red-100 text-red-700`}>
      <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
      Closed
      {status.opensAt && (
        <span className="font-normal opacity-70"> · opens {formatLocalTime(status.opensAt)}</span>
      )}
    </span>
  );
}

// Module-scope Set tracking which restaurants we've already asked
// the server to refresh-if-stale during this browser session.
// Without this, opening the same detail modal twice in a session
// would fire two refresh-restaurant POSTs (and risk two Place
// Details API calls if the row crossed the stale threshold between
// opens). Session-scoped — clears on page reload, which is fine:
// the server's STALE_DAYS check is the real cost guard, this is
// just an extra layer of "don't spam the endpoint."
const refreshAttempted = new Set();

// Coarse "time ago" string for the Google-data-freshness hint on the
// detail modal. Surfaces "Updated 3 days ago" / "2 weeks ago" /
// "3 months ago". Returns an empty string for null timestamps OR
// values < 7 days old — fresh data doesn't need a freshness label,
// only-stale data does (we want users to know when fields like
// photos / hours / phone might be out of date, not to crow about
// recent updates).
function formatGoogleDataAge(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const days = Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000));
  if (days < 7) return '';
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

// Adapt the server's /api/restaurants/:id shape (canonical Restaurant
// row, with rating as Decimal-stringified, type as `cuisineType`,
// price as `priceLevel`, etc.) into the in-memory shape the modal
// reads from when restaurantMap supplies the row. Kept as a free
// function so the resolution below stays a one-liner.
function normalizeFetchedRestaurant(r) {
  if (!r) return null;
  return {
    ...r,
    // Field-name parity with the in-memory shape used by cards / Redux.
    type:    r.cuisineType ?? r.type    ?? null,
    price:   r.priceLevel  ?? r.price   ?? null,
    rating:  r.googleRating != null ? Number(r.googleRating) : null,
    photos:  Array.isArray(r.photos) ? r.photos : [],
  };
}

// `readOnly`  — hides write-actions (review form, note editor, recommend,
//               default Add/Favorite buttons). Reviews + recs stay
//               visible but become display-only. Implied true for
//               guests (unauthenticated viewers).
// `actions`   — custom JSX rendered in place of the default Add-to-
//               Options / Favorite buttons. `null` hides the action
//               row entirely (e.g. group voting modal where the
//               action is implicit elsewhere on the page).
// `fallback`  — snapshot of the restaurant from a caller-provided
//               source (e.g. a group session payload). Used as the
//               `r` resolution when restaurantMap doesn't have the
//               id, so the modal isn't empty for the first ~150ms
//               while the API fetch lands.
// `onArchive` / `onUnarchive` / `onDelete` — when set, render
//   Archive / Unarchive / Delete buttons in the action row. Used by
//   HistoryPage to move those operations off the card and into the
//   detail modal (cleaner card UX + consolidated confirmation).
// `isArchived` — drives the Archive vs Unarchive label.
const RestaurantDetailModal = ({
  restaurantId,
  restaurantMap,
  onClose,
  readOnly = false,
  actions,
  fallback,
  onArchive,
  onUnarchive,
  onDelete,
  isArchived = false,
  // When true, the modal opens with the Yours review tab active AND
  // the write-review form already expanded. Used by HistoryPage's
  // "Add Review" card button so the user lands directly in the form
  // instead of having to click through. Ignored in readOnly mode.
  defaultShowReviewForm = false,
  // When true, renders the body as an inline panel (no Dialog
  // wrapper, no backdrop, no fixed positioning, no close button) so
  // the same content can flow as a column in a Compare-page grid.
  // The parent provides height context via h-full; the body's
  // internal scroll container takes over once content exceeds the
  // cell. `onClose` is unused in inline mode — dismiss is handled
  // externally by the surrounding page.
  inline = false,
}) => {
  const dispatch = useDispatch();
  const userInfo = useCurrentUser();
  const isAuthenticated = useSelector((state) => state.auth?.status === 'authenticated');
  // Effective read-only state — explicit prop OR guest viewer. Used
  // throughout to gate write UI. Pulled into one constant so the
  // checks below stay readable.
  const isReadOnly = readOnly || !isAuthenticated;

  // Self-fetched copy of the row from /api/restaurants/:id. Used when
  // restaurantMap is missing the entry (e.g. group voting page —
  // guests have no Redux user-data). The endpoint is public + cached
  // server-side, so this is cheap.
  const [fetched, setFetched] = useState(null);
  useEffect(() => {
    const numId = Number(restaurantId);
    if (!numId) return;
    // Skip when restaurantMap already has it — that's the authoritative
    // source for authenticated users (carries notes/etc. for the user).
    if (restaurantMap?.[restaurantId]) return;
    let cancelled = false;
    api.restaurants.get(numId)
      .then(({ restaurant }) => { if (!cancelled) setFetched(restaurant); })
      .catch(() => { /* fall through to fallback below */ });
    return () => { cancelled = true; };
  }, [restaurantId, restaurantMap]);

  // ── On-demand refresh-if-stale ──────────────────────────────
  // Fire `refresh-restaurant/:id` on modal mount so the Google
  // data on the row the user is *actively looking at* gets
  // refreshed if it's stale (>STALE_DAYS old). Server is the gate:
  // already-fresh rows return a no-op without spending API quota,
  // custom rows are skipped entirely. Client just throttles repeat
  // calls within the same session.
  //
  // The on-modal-open pattern means refresh spend tracks user
  // intent — viewing 5 of 50 saved restaurants in a month costs 5
  // refresh calls, not 50. Replaces the eager "batch-refresh all
  // stale rows on app boot" pattern (refresh-places still exists
  // for manual/admin sweeps but isn't auto-fired).
  //
  // Read-only contexts (guest viewers, group voting modal) skip
  // the refresh — they have no auth to spend quota on the user's
  // behalf, and the row would belong to a different user anyway.
  useEffect(() => {
    if (isReadOnly) return;
    const numId = Number(restaurantId);
    if (!numId) return;
    if (refreshAttempted.has(numId)) return;
    refreshAttempted.add(numId);

    let cancelled = false;
    api.users.refreshRestaurant(numId)
      .then(({ refreshed, restaurant }) => {
        if (cancelled || !refreshed || !restaurant) return;
        // Mirror the server's update into Redux so cards / modals
        // re-render with the fresh data. Same field shape the
        // loader uses (cuisineType → type, priceLevel → price,
        // googleRating → rating Number, etc.) — see slice loader.
        dispatch(updateCustomRestaurant({
          id: String(restaurant.id),
          data: {
            name:    restaurant.name,
            type:    restaurant.cuisineType ?? null,
            price:   restaurant.priceLevel  ?? null,
            rating:  restaurant.googleRating != null ? Number(restaurant.googleRating) : null,
            ratingCount: restaurant.ratingCount ?? null,
            phone:   restaurant.phone   ?? null,
            website: restaurant.website ?? null,
            takeout:  !!restaurant.takeout,
            delivery: !!restaurant.delivery,
            lat: restaurant.lat ?? null,
            lng: restaurant.lng ?? null,
            photos: Array.isArray(restaurant.photos) ? restaurant.photos : [],
            regularOpeningHours: restaurant.regularOpeningHours ?? null,
            googleDataUpdatedAt: restaurant.googleDataUpdatedAt ?? null,
          },
        }));
      })
      .catch(() => { /* non-fatal — stale data is better than a thrown modal */ });
    return () => { cancelled = true; };
  }, [restaurantId, isReadOnly, dispatch]);

  // Resolution priority: in-memory map (Redux) → freshly fetched →
  // caller-provided snapshot fallback. The fetched row carries
  // server-normalized fields (rating as Decimal, etc.), so we adapt
  // them to the in-memory shape via the inline normalizer.
  const r = restaurantMap?.[restaurantId]
    ?? (fetched ? normalizeFetchedRestaurant(fetched) : null)
    ?? fallback
    ?? null;

  const savedNote = r ? (userInfo.notes?.[sid(restaurantId)] ?? '') : '';
  const [noteText, setNoteText] = useState(savedNote);

  // ── Recommendation state ──────────────────────────────────
  const [myRec, setMyRec]               = useState(null);   // { id, tip } | null
  const [socialRecs, setSocialRecs]     = useState([]);     // [{ fromUser, tip }]
  const [showTipInput, setShowTipInput] = useState(false);
  const [tipText, setTipText]           = useState('');
  const [recLoading, setRecLoading]     = useState(false);
  const [recError, setRecError]         = useState('');
  const [socialRecsExpanded, setSocialRecsExpanded] = useState(false);

  // Hours start collapsed — only today's row is visible until the user
  // taps "Show full week". Cuts the vertical footprint of a fully-
  // populated weekly schedule (7 rows ~14px each ~100px) down to a
  // single line for the common case where the user just wants to know
  // "open today?". Click toggles to expanded; closing/reopening the
  // modal returns to collapsed.
  const [hoursExpanded, setHoursExpanded] = useState(false);

  // ── Review tab state ──────────────────────────────────────
  // communityData carries the full /reviews response (reviews array +
  // server-aggregated communityRating + total count). We fetch on
  // mount instead of on tab-click so the ratings tri-card at the top
  // of the modal has the community rating and count ready without a
  // second click. The api client's 5s GET cache makes this cheap if
  // the user opens then closes/reopens within the window.
  const [reviewTab, setReviewTab] = useState('yours'); // 'yours' | 'community'
  const [communityData, setCommunityData] = useState(null); // null = not yet fetched
  const [communityLoading, setCommunityLoading] = useState(false);

  // ── Review form state ─────────────────────────────────────
  // defaultShowReviewForm pre-expands the form when the caller wants
  // to land users directly in the write flow (HistoryPage's
  // "Add Review" button). Guests / read-only viewers can't write, so
  // the prop is gated by !isReadOnly even if the caller forgets.
  const [showReviewForm, setShowReviewForm] = useState(
    defaultShowReviewForm && !isReadOnly,
  );

  // Ref on the Reviews section so we can auto-scroll the modal body
  // there when `defaultShowReviewForm` is set. Without this, opening
  // the modal via "Add Review" lands the user at the top of the
  // photo gallery and they have to scroll past everything to find
  // the form. See the effect below for the scroll trigger.
  const reviewsSectionRef = useRef(null);

  // On mount (and whenever the caller flips defaultShowReviewForm
  // mid-open, which doesn't happen in current callers but is cheap
  // to handle), bring the Reviews section to the top of the
  // scrollable body. requestAnimationFrame waits one paint so the
  // layout is finalized — without it, the photo gallery's lazy
  // images haven't laid out yet and the scroll target moves after
  // we've already jumped to it. `block: 'start'` aligns the
  // section's top edge with the visible top of the scroll
  // container; `behavior: 'instant'` skips the smooth-scroll
  // animation since the user explicitly asked to land here and
  // doesn't want to wait through a 300ms scroll. scrollIntoView
  // only scrolls the nearest scrollable ancestor (the modal body
  // with `overflow-y-auto`), so the page itself doesn't move.
  useEffect(() => {
    if (!defaultShowReviewForm || isReadOnly) return;
    const id = requestAnimationFrame(() => {
      reviewsSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
    return () => cancelAnimationFrame(id);
  }, [defaultShowReviewForm, isReadOnly]);
  const [reviewContent, setReviewContent] = useState('');
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewDate, setReviewDate] = useState(() => new Date().toLocaleDateString());
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  // Moved above the `if (!r) return null` early-return below so React's
  // hooks rule (must be called in the same order every render) is
  // never violated when the resolved row is briefly absent. The
  // setter is consumed by handleToggleMatchOptOut further down.
  const [matchToggleBusy, setMatchToggleBusy] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) return;
    const numId = Number(restaurantId);
    if (!numId) return;
    Promise.all([
      socialApi.getMyRecForRestaurant(numId).catch(() => ({ recommendation: null })),
      socialApi.getSocialRecs(numId).catch(() => ({ recommendations: [] })),
    ]).then(([myData, socialData]) => {
      setMyRec(myData.recommendation);
      if (myData.recommendation?.tip) setTipText(myData.recommendation.tip);
      setSocialRecs(socialData.recommendations ?? []);
    });
  }, [restaurantId, isAuthenticated]);

  useEffect(() => {
    const numId = Number(restaurantId);
    if (!numId) return;
    let cancelled = false;
    setCommunityLoading(true);
    api.restaurants.getReviews(numId)
      .then((data) => { if (!cancelled) setCommunityData(data); })
      .catch(() => { if (!cancelled) setCommunityData({ reviews: [], averageRating: null, communityRating: null, total: 0 }); })
      .finally(() => { if (!cancelled) setCommunityLoading(false); });
    return () => { cancelled = true; };
  }, [restaurantId]);

  const handleRecommend = async () => {
    setRecLoading(true);
    setRecError('');
    try {
      const { recommendation } = await socialApi.recommend(Number(restaurantId), tipText.trim() || undefined);
      setMyRec(recommendation);
      setShowTipInput(false);
      window.dispatchEvent(new CustomEvent('pickyum:recommendation-changed'));
    } catch (err) {
      setRecError(err.message ?? 'Could not save recommendation.');
    } finally {
      setRecLoading(false);
    }
  };

  const handleUnrecommend = async () => {
    setRecLoading(true);
    setRecError('');
    try {
      await socialApi.unrecommend(Number(restaurantId));
      setMyRec(null);
      setTipText('');
      setShowTipInput(false);
      window.dispatchEvent(new CustomEvent('pickyum:recommendation-changed'));
    } catch (err) {
      setRecError(err.message ?? 'Could not remove recommendation.');
    } finally {
      setRecLoading(false);
    }
  };

  if (!r) return null;

  const reviews   = userInfo.reviews[sid(restaurantId)] || [];
  const avgRating = reviews.length ? mean(reviews.map((rv) => rv.rating)) : null;
  // isFavorite used to drive the action-row Favorite/Unfavorite
  // button; that's replaced by <HeartWithKebab> in the modal header,
  // which manages its own state. Leave the favorited derivation out
  // of this function entirely.
  const isSelected = userInfo.options.map(sid).includes(sid(restaurantId));
  const noteDirty = noteText !== savedNote;

  // ── Field projections used by the header + body layout ───────────────
  // Display values are normalized once here so the render tree stays
  // readable: every conditional below is just `field && <Row>`.
  //
  // `displayable` mirrors the helper used on RestaurantCard — treats
  // null, empty strings, and the legacy "N/A" sentinel as "absent".
  // Customer-typed rows can still carry "N/A" in localStorage from
  // older snapshots, so this guard is defensive.
  const isShown = (v) => typeof v === 'string' && v.trim() && v.trim() !== 'N/A';
  const address    = isShown(r.address)  ? r.address  : null;
  const phone      = isShown(r.phone)    ? r.phone    : null;
  const website    = isShown(r.website)  ? r.website  : null;
  const googleHref = googleMapsUrl(r);
  // Price chip in header — `r.price` is the legacy/in-memory shape
  // (number 1-4), `r.priceLevel` is the API shape; either may be set
  // depending on the data path that produced this row.
  const priceLabel = r.price != null
    ? PRICE_LABELS[r.price]
    : (r.priceLevel != null ? PRICE_LABELS[r.priceLevel] : null);

  // Opening hours — structured periods drive the open-now badge
  // (recomputed against the user's clock so it stays accurate
  // regardless of when the row was last refreshed). `weekdayDescriptions`
  // powers the readable hours table.
  const openStatus = getOpenStatus(r.regularOpeningHours);
  const weekdayDescriptions = Array.isArray(r.regularOpeningHours?.weekdayDescriptions)
    ? r.regularOpeningHours.weekdayDescriptions
    : [];
  const hasFreeformHours = isShown(r.hours);
  // Google's weekdayDescriptions is MONDAY-first; JS Date.getDay() is
  // SUNDAY-first. Convert so the highlighted row matches "today" for
  // the user. Sunday (0) maps to index 6 in Google's array; everything
  // else shifts down by one.
  const jsDay = new Date().getDay();
  const todayIndex = (jsDay + 6) % 7;

  const handleSaveNote = () => {
    dispatch(setRestaurantNote({ restaurantId: sid(restaurantId), text: noteText }));
  };

  // ── Match-opt-out toggle (custom rows only) ──────────────────
  // The toggle below the personal note lets owners proactively opt
  // out of the Search page's Place-match scan for THIS custom row
  // (use case: "Cooking at home" will never have a Google match,
  // user doesn't want to see prompts about it). Server enforces
  // ownership + custom-row constraints; we mirror in Redux on
  // success so the next search reflects immediately. Optimistic
  // toggle reverted on API error.
  // (matchToggleBusy state is declared above the early-return at
  //  line ~445 to keep the hooks order consistent.)
  const handleToggleMatchOptOut = async (nextValue) => {
    if (matchToggleBusy) return;
    setMatchToggleBusy(true);
    // Optimistic update — UI reflects the new state before the
    // round-trip lands. Revert on failure.
    dispatch(setMatchOptOut({ id: sid(restaurantId), excludeFromPlaceMatching: nextValue }));
    try {
      await api.restaurants.setMatchSettings(Number(restaurantId), {
        excludeFromPlaceMatching: nextValue,
      });
    } catch (err) {
      console.warn('[match-opt-out] save failed:', err);
      dispatch(setMatchOptOut({ id: sid(restaurantId), excludeFromPlaceMatching: !nextValue }));
    } finally {
      setMatchToggleBusy(false);
    }
  };

  const handleSubmitReview = async () => {
    if (!reviewContent.trim()) return;
    setReviewSubmitting(true);
    await dispatch(persistAddReview({
      restaurantId: sid(restaurantId),
      userId: userInfo.id,
      content: reviewContent.trim(),
      rating: Number(reviewRating),
      date: reviewDate,
    }));
    setReviewContent('');
    setReviewRating(5);
    setReviewDate(new Date().toLocaleDateString());
    setShowReviewForm(false);
    setReviewSubmitting(false);
  };

  // ── Panel body content ─────────────────────────────────────
  // Identical in both modes. Hooks must live above this point;
  // everything below is rendered into one of two shells (modal or
  // inline) selected at the bottom of the function. Keeping the JSX
  // in a const (rather than extracting to a sub-component) avoids
  // re-running every hook in this 400-line component every time we
  // toggle the wrapper.
  const body = (
    <>
      {/* ── Photo hero / gallery strip ───────────────────────
              Renders only when Google Places returned photos. First
              photo is rendered larger as a hero; remaining photos
              (up to 4 more) sit beneath in a thumbnail row that
              swaps the hero on click. State is local to the modal
              so reopening defaults back to the first photo. */}
          {Array.isArray(r.photos) && r.photos.length > 0 && r.photos[0]?.name && (
            <PhotoGallery photos={r.photos} restaurantName={r.name} />
          )}

          {/* ── Header — name + cuisine + price ──────────────────
              Ratings used to live up here as a single-mode toggleable
              RatingDisplay; they moved into a 3-tile block in the body
              so Google + Yours + Community are visible simultaneously.
              That matches the user-listed requirement to show all three
              sources with their counts at once. */}
          <div className="flex justify-between items-start p-6 pb-4">
            <div className="min-w-0">
              <h2 className="text-2xl font-bold text-gray-900 leading-tight">{r.name}</h2>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                {(r.type ?? r.cuisineType) && (
                  <span className="px-2.5 py-0.5 rounded-full bg-orange-100 text-orange-700 text-xs font-semibold">
                    {r.type ?? r.cuisineType}
                  </span>
                )}
                {priceLabel && (
                  <span className="px-2.5 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-semibold">
                    {priceLabel}
                  </span>
                )}
              </div>
            </div>
            <div className="ml-4 shrink-0 flex items-center gap-2">
              {/* HeartWithKebab in the modal header — primary
                  favoriting affordance for the detail view, visible
                  on every entry point that opens the modal (Search,
                  Compare, Choose, History, etc.). Hidden in
                  read-only contexts (group voting, public sharing)
                  where editing favorites makes no sense. */}
              {!readOnly && (
                <HeartWithKebab restaurantId={sid(restaurantId)} size="md" />
              )}
              {/* Close-X is hidden in inline mode — the Compare page
                  renders its own dismiss button as an overhang
                  outside the panel, and inline panels don't have a
                  "close" affordance in the modal sense. */}
              {!inline && (
                <button
                  onClick={onClose}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              )}
            </div>
          </div>

          {/* ── Scrollable body ──────────────────────────────── */}
          <div className="overflow-y-auto px-6 pb-6 flex flex-col gap-5">
            <hr className="border-gray-100" />

            {/* ── Ratings row ──────────────────────────────────
                Single horizontal row of three inline chips so the
                section claims a single line of vertical space. Was
                previously a 3-column tile grid; that took ~64px of
                vertical space with the photo gallery already
                consuming the upper third of the modal. Em-dash
                fallbacks keep alignment stable across restaurants
                with thin data. Personal count = this user's review
                count; Community count = total community reviews;
                Google count = total Google user ratings.
                `flex-wrap` lets the row break on narrow viewports
                rather than truncating any chip. */}
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <RatingChip
                label="Google"
                accent="amber"
                value={r.rating ?? r.googleRating ?? null}
                count={r.ratingCount ?? null}
              />
              <RatingChip
                label="Yours"
                accent="orange"
                value={avgRating}
                count={reviews.length}
              />
              <RatingChip
                label="Community"
                accent="purple"
                value={communityData?.communityRating ?? communityData?.averageRating ?? null}
                count={communityData?.total ?? null}
              />
            </div>

            {/* ── Hours block ─────────────────────────────────
                Three cases:
                  1. structured periods + weekdayDescriptions (Google
                     rows refreshed since the rollout) → status badge
                     + COLLAPSED hours list (today only) with a
                     toggle to expand to the full week
                  2. only a free-form `hours` string on the row (custom
                     entries the user typed in) → plain text fallback
                  3. neither → block skipped entirely
                When expanded, today's row stays highlighted so the
                eye lands on it even within the full list. */}
            {(openStatus.hasData || hasFreeformHours) && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Hours</p>
                  <OpenStatusBadge status={openStatus} />
                </div>
                {weekdayDescriptions.length > 0 ? (
                  <div className="rounded-lg border border-gray-200 overflow-hidden">
                    {/* Collapsed: just today's row. Expanded: all 7
                        rows in MONDAY-first order (Google's
                        convention). The wrapper is the same in both
                        cases so the border + radius look identical;
                        only the contents change. */}
                    <ul className="text-xs text-gray-700 divide-y divide-gray-100">
                      {hoursExpanded
                        ? weekdayDescriptions.map((line, i) => (
                            <li
                              key={i}
                              className={`px-3 py-1.5 ${i === todayIndex ? 'bg-orange-50/60 font-semibold text-gray-900' : 'bg-white'}`}
                            >
                              {line}
                            </li>
                          ))
                        : (
                          <li className="px-3 py-1.5 bg-orange-50/60 font-semibold text-gray-900">
                            {weekdayDescriptions[todayIndex] ?? weekdayDescriptions[0]}
                          </li>
                        )}
                    </ul>
                    {/* Toggle lives inside the bordered container so
                        the affordance is visually attached to the
                        hours list rather than floating beside it. */}
                    <button
                      type="button"
                      onClick={() => setHoursExpanded((v) => !v)}
                      className="w-full text-center text-[11px] font-medium text-orange-600 hover:bg-orange-50 py-1.5 border-t border-gray-100 transition-colors"
                    >
                      {hoursExpanded ? 'Hide full week' : 'Show full week'}
                    </button>
                  </div>
                ) : (
                  hasFreeformHours && <p className="text-sm text-gray-700">{r.hours}</p>
                )}
              </div>
            )}

            {/* ── Contact info grid ───────────────────────────
                Address, Phone, Website, Google. Skip rows whose value
                is missing or the legacy "N/A" sentinel from older
                snapshots. Phone wired as tel: link, website as
                external link, Google as the Maps deep-link.
                Yelp was dropped — the Google row covers the
                "see this place on the open web" use case. */}
            <div className="grid grid-cols-2 gap-x-8 gap-y-4">
              {address && <InfoRow label="Address" value={address} />}
              {phone   && <InfoRow label="Phone"   value={phone}   href={`tel:${phone}`} />}
              {website && <InfoRow label="Website" value={website} href={normalizeUrl(website)} external />}
              {googleHref && (
                <InfoRow label="Google" value="View reviews & photos" href={googleHref} external />
              )}
            </div>

            {/* "Google data updated X ago" hint — only shown when the
                row is meaningfully stale (>7 days). With STALE_DAYS
                bumped to 90, this sets user expectations that
                photos / phone / hours could be a few months old.
                On-modal-open auto-refresh (above) will refresh the
                row in the background when applicable, but the hint
                still appears for the rest of this render cycle. */}
            {(() => {
              const ago = formatGoogleDataAge(r.googleDataUpdatedAt);
              if (!ago) return null;
              return (
                <p className="text-[11px] text-gray-400 italic -mt-2">
                  Google data updated {ago}
                </p>
              );
            })()}

            {/* Service availability */}
            <div className="flex gap-2">
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
                r.takeout ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400 line-through'
              }`}>
                Takeout
              </span>
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
                r.delivery ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400 line-through'
              }`}>
                Delivery
              </span>
            </div>

            {/* Action buttons — three modes, in priority order:
                 1. `actions === null` → render nothing (e.g. group
                    voting modal where action lives elsewhere on page)
                 2. `actions` is supplied  → render caller's JSX (e.g.
                    HistoryPage's "Add Review" button)
                 3. otherwise → default Add-to-Options / Favorite pair
                Read-only viewers (guests OR explicit readOnly prop)
                fall through option 3 and see nothing — the default
                writes are auth-gated. Archive / Delete buttons join
                whichever row renders, when those handlers are set. */}
            {actions === null ? null : (
              <div className="flex flex-wrap gap-3">
                {actions !== undefined ? (
                  actions
                ) : (!isReadOnly && (
                  <>
                    <button
                      onClick={() =>
                        isSelected
                          ? dispatch(removeUserOption(sid(restaurantId)))
                          : dispatch(addUserOption(sid(restaurantId)))
                      }
                      className={[
                        'flex-1 rounded-lg py-2 text-sm font-semibold transition-colors',
                        isSelected
                          ? 'bg-red-50 text-red-600 hover:bg-red-100 border border-red-200'
                          : 'bg-orange-500 text-white hover:bg-orange-500',
                      ].join(' ')}
                    >
                      {isSelected ? 'Remove from Options' : 'Add to Options'}
                    </button>
                    {/* Choose Now — direct-accept shortcut that
                        commits this restaurant without going through
                        the coin-flip / roulette flow. Universal
                        action available anywhere the default modal
                        opens (Search, History, Insights, Socials,
                        Compare via card-click info, etc.) so the
                        user can decide on the spot.
                        Mechanics: records an acceptance with
                        chooseMethod='direct', removes the row from
                        options if it was there, and closes the
                        modal. optionsSnapshot is the user's current
                        options list at choose time — same shape
                        Compare uses for `activeIds`.
                        Skipped when actions or readOnly takes over
                        the row, since those paths replace the
                        default action set entirely. */}
                    <button
                      onClick={() => {
                        dispatch(addUserAcceptance({
                          restaurantId: sid(restaurantId),
                          optionsSnapshot: userInfo.options.map(sid),
                          chooseMethod: 'direct',
                        }));
                        if (isSelected) dispatch(removeUserOption(sid(restaurantId)));
                        // Pop the shared celebration before closing the
                        // detail modal — the global <ChosenCelebration/>
                        // renders on top so the user gets the same
                        // "Tonight you're going to…" feedback as the
                        // Compare-page Choose-Now flow.
                        dispatch(showChosenCelebration(sid(restaurantId)));
                        onClose?.();
                      }}
                      className="flex-1 rounded-lg py-2 text-sm font-semibold bg-green-600 text-white hover:bg-green-500 transition-colors"
                    >
                      Choose Now
                    </button>
                    {/* The header now hosts <HeartWithKebab>, which
                        covers default-list toggle AND multi-list
                        management — so the action-row Favorite
                        button is gone. Keeping both was redundant
                        and the header position is more discoverable
                        for users coming in from any entry point. */}
                  </>
                ))}
                {/* History-page operations live in the modal so the
                    card can stay clean. Archive vs Unarchive flips on
                    the row's current archive state. */}
                {onArchive && !isArchived && (
                  <button
                    onClick={onArchive}
                    className="rounded-lg py-2 px-4 text-sm font-medium border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    Archive
                  </button>
                )}
                {onUnarchive && isArchived && (
                  <button
                    onClick={onUnarchive}
                    className="rounded-lg py-2 px-4 text-sm font-medium border border-orange-300 bg-white text-orange-600 hover:bg-orange-50 transition-colors"
                  >
                    Restore
                  </button>
                )}
                {onDelete && (
                  <button
                    onClick={onDelete}
                    className="rounded-lg py-2 px-4 text-sm font-medium border border-red-300 bg-white text-red-600 hover:bg-red-50 transition-colors"
                  >
                    Remove
                  </button>
                )}
              </div>
            )}

            {/* ── Insights opt-out ─────────────────────────────────
                Per-entry toggle for the InsightsPage aggregation.
                Visible only in history context (any of the history
                operations is bound). Mirrors the HistoryRowKebab
                action — same semantic ("does this place shape my
                taste profile?") but with room here for the helper
                copy that explains why a user might want to opt out.
                The kebab path is the fast lane; this is the
                discoverable, labeled lane. */}
            {(onArchive || onUnarchive || onDelete) && (() => {
              // Pulled inline (rather than at the top of the component)
              // because the history-context branch is the only consumer
              // and this keeps the section's logic colocated with its UI.
              const acceptedRows = userInfo.accepted.filter(
                (a) => String(a.restaurantId) === String(restaurantId),
              );
              if (acceptedRows.length === 0) return null;
              const anyExcluded = acceptedRows.some((a) => a.excludeFromInsights);
              const targets    = acceptedRows.filter((a) => a.id != null);
              const canToggle  = targets.length > 0;
              const handleFlip = () => {
                const next = !anyExcluded;
                for (const row of targets) {
                  // Skip rows already in the target state — see
                  // HistoryRowKebab for the same optimization.
                  if (row.excludeFromInsights !== next) {
                    dispatch(toggleAcceptedExcludeFromInsights({
                      acceptedId: row.id,
                      excludeFromInsights: next,
                    }));
                  }
                }
              };
              return (
                <div className="border-t border-gray-100 pt-3 mt-2">
                  <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                    <input
                      type="checkbox"
                      // Checked = "count in insights" (i.e. NOT excluded). The
                      // semantic match between the box and the label matters —
                      // a user reading "Count this in my insights" expects the
                      // checkbox to mean "yes, count it."
                      checked={!anyExcluded}
                      onChange={handleFlip}
                      disabled={!canToggle}
                      className="mt-0.5 accent-orange-500 disabled:opacity-50"
                    />
                    <span>
                      <span className="font-medium">Count this in my insights</span>
                      <span className="block text-xs text-gray-500 mt-0.5">
                        Group and trip picks you didn’t choose yourself can be left
                        out of your taste profile. Unchecking keeps this in your
                        history but drops it from totals, cuisine trends, and the
                        weekday heatmap.
                      </span>
                    </span>
                  </label>
                </div>
              );
            })()}

            {/* ── Recommend section (authenticated, write-mode only) ── */}
            {isAuthenticated && !isReadOnly && (
              <div className="border-t border-gray-100 pt-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold text-gray-700">Recommend</p>
                  {myRec && !showTipInput && (
                    <div className="flex gap-3">
                      <button
                        onClick={() => setShowTipInput(true)}
                        className="text-xs text-orange-500 hover:text-orange-700 transition-colors"
                      >
                        {myRec.tip ? 'Edit tip' : 'Add tip'}
                      </button>
                      <button
                        onClick={handleUnrecommend}
                        disabled={recLoading}
                        className="text-xs text-gray-400 hover:text-red-500 transition-colors disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>

                {myRec && !showTipInput ? (
                  <div className="flex items-start gap-2 rounded-lg bg-orange-50 border border-orange-200 px-3 py-2.5">
                    <span className="text-orange-600 font-bold text-sm mt-0.5">✓</span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-orange-700">You recommended this</p>
                      {myRec.tip && (
                        <p className="text-xs text-orange-600 mt-0.5 italic">"{myRec.tip}"</p>
                      )}
                    </div>
                  </div>
                ) : showTipInput ? (
                  <div className="space-y-2">
                    <textarea
                      value={tipText}
                      onChange={(e) => setTipText(e.target.value)}
                      placeholder="Add an optional tip — best dish, parking, vibe…"
                      rows={2}
                      maxLength={200}
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500 resize-none"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => { setShowTipInput(false); setTipText(myRec?.tip ?? ''); }}
                        className="px-3 py-1.5 text-xs font-medium text-gray-400 hover:text-gray-600"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleRecommend}
                        disabled={recLoading}
                        className="rounded-md bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-50 transition-colors"
                      >
                        {recLoading ? 'Saving…' : myRec ? 'Update' : 'Recommend'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowTipInput(true)}
                    className="w-full rounded-lg border border-dashed border-orange-300 py-2 text-sm font-medium text-orange-600 hover:bg-orange-50 transition-colors"
                  >
                    + Recommend to your network
                  </button>
                )}

                {recError && <p className="mt-1 text-xs text-red-500">{recError}</p>}
              </div>
            )}

            {/* ── Friends' recommendations ─────────────────────── */}
            {isAuthenticated && socialRecs.length > 0 && (
              <div className="border-t border-gray-100 pt-4">
                <button
                  onClick={() => setSocialRecsExpanded((v) => !v)}
                  className="flex items-center gap-2 w-full text-left"
                >
                  <p className="text-sm font-semibold text-gray-700">
                    Recommended by friends
                  </p>
                  <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 rounded-full bg-orange-100 text-orange-700 text-[11px] font-bold px-1.5">
                    {socialRecs.length}
                  </span>
                  <span className="ml-auto text-xs text-gray-400">{socialRecsExpanded ? '▲' : '▼'}</span>
                </button>

                {socialRecsExpanded && (
                  <ul className="mt-3 space-y-2">
                    {socialRecs.map((rec) => (
                      <li key={rec.fromUser.id} className="rounded-lg bg-gray-50 px-3 py-2.5">
                        <div className="flex items-center gap-2 mb-0.5">
                          <div className="h-6 w-6 rounded-full bg-orange-100 flex items-center justify-center text-orange-600 font-bold text-xs shrink-0">
                            {rec.fromUser.username[0].toUpperCase()}
                          </div>
                          <span className="text-xs font-semibold text-gray-700">{rec.fromUser.username}</span>
                        </div>
                        {rec.tip && (
                          <p className="text-xs text-gray-500 italic ml-8">"{rec.tip}"</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Reviews — tabbed: Yours / Community.
                ref captured for the auto-scroll behavior triggered
                by `defaultShowReviewForm` (see effect at top). */}
            <div ref={reviewsSectionRef} className="border-t border-gray-100 pt-4">

              {/* Tab bar — Yours / Community. The previous "Google" tab
                  pulled review text directly from the Places API
                  (Enterprise tier); we now link out to Google Maps in
                  the info row above instead — same content for users,
                  free to us, and no TOS author-attribution burden. */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex gap-1 rounded-lg bg-gray-100 p-0.5">
                  {['yours', 'community'].map((tab) => (
                    <button
                      key={tab}
                      onClick={() => { setReviewTab(tab); setShowReviewForm(false); }}
                      className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                        reviewTab === tab
                          ? 'bg-white text-gray-900 shadow-sm'
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {tab === 'yours'
                        ? `Yours${reviews.length > 0 ? ` (${reviews.length})` : ''}`
                        : `Community${communityData?.total != null ? ` (${communityData.total})` : ''}`}
                    </button>
                  ))}
                </div>
                {reviewTab === 'yours' && !showReviewForm && !isReadOnly && (
                  <button
                    onClick={() => setShowReviewForm(true)}
                    className="text-xs font-medium text-orange-600 hover:text-orange-500 transition-colors"
                  >
                    + Write a Review
                  </button>
                )}
              </div>

              {/* ── Yours tab ──────────────────────────────────── */}
              {reviewTab === 'yours' && (
                <>
                  {showReviewForm && (
                    <div className="mb-3 rounded-lg border border-orange-200 bg-orange-50 p-3 space-y-2">
                      <textarea
                        value={reviewContent}
                        onChange={(e) => setReviewContent(e.target.value)}
                        placeholder="What did you think?"
                        rows={3}
                        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500 resize-none bg-white"
                      />
                      <div className="flex items-center gap-3">
                        <label className="text-xs font-medium text-gray-600">Rating</label>
                        <select
                          value={reviewRating}
                          onChange={(e) => setReviewRating(e.target.value)}
                          className="rounded-md border border-gray-300 pl-2 pr-8 py-1 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white"
                        >
                          {[5, 4, 3, 2, 1].map((n) => (
                            <option key={n} value={n}>{'★'.repeat(n)} {n}</option>
                          ))}
                        </select>
                        <input
                          type="date"
                          value={(() => { const [m, d, y] = reviewDate.split('/'); return y && m && d ? `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}` : ''; })()}
                          onChange={(e) => {
                            const [y, m, d] = e.target.value.split('-');
                            if (y && m && d) setReviewDate(`${parseInt(m)}/${parseInt(d)}/${y}`);
                          }}
                          className="ml-auto rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white"
                        />
                      </div>
                      <div className="flex justify-end gap-2 pt-1">
                        <button
                          onClick={() => { setShowReviewForm(false); setReviewContent(''); setReviewRating(5); }}
                          className="px-3 py-1.5 text-xs font-medium text-gray-400 hover:text-gray-600 transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleSubmitReview}
                          disabled={reviewSubmitting || !reviewContent.trim()}
                          className="rounded-md bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-50 transition-colors"
                        >
                          {reviewSubmitting ? 'Saving…' : 'Submit'}
                        </button>
                      </div>
                    </div>
                  )}

                  {reviews.length > 0 ? (
                    <div className="flex flex-col gap-2 max-h-52 overflow-y-auto pr-1">
                      {reviews.map((rv) => (
                        <div key={rv.id ?? `${rv.content}-${rv.date}`} className="rounded-lg bg-gray-50 px-3 py-2.5">
                          <div className="flex justify-between items-center mb-0.5">
                            <span className="text-xs font-bold text-amber-500">★ {rv.rating}</span>
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-gray-400">{rv.date}</span>
                              {/* Delete-review X is owner-only and a
                                  write action — gated by !isReadOnly so
                                  read-only viewers (Compare panel,
                                  group modal) don't see it. */}
                              {!isReadOnly && (
                                <button
                                  onClick={() => dispatch(removeUserReview({ restaurantId: sid(restaurantId), id: rv.id }))}
                                  className="text-xs text-gray-300 hover:text-red-400 transition-colors"
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                          </div>
                          <p className="text-xs text-gray-600 leading-relaxed">{rv.content}</p>
                        </div>
                      ))}
                    </div>
                  ) : !showReviewForm ? (
                    <p className="text-xs text-gray-400 italic">No reviews yet. Be the first!</p>
                  ) : null}
                </>
              )}

              {/* ── Community tab ───────────────────────────────── */}
              {reviewTab === 'community' && (
                <>
                  {communityLoading && (
                    <p className="text-xs text-gray-400 italic">Loading…</p>
                  )}
                  {!communityLoading && communityData && (communityData.reviews?.length ?? 0) === 0 && (
                    <p className="text-xs text-gray-400 italic">No community reviews yet.</p>
                  )}
                  {!communityLoading && communityData && (communityData.reviews?.length ?? 0) > 0 && (
                    <div className="flex flex-col gap-2 max-h-52 overflow-y-auto pr-1">
                      {communityData.reviews.map((rv) => {
                        // Reviews from deleted accounts come back with user: null.
                        // We keep the rating + content (the community-benefit
                        // data) but anonymize the avatar and name.
                        const isOrphan = !rv.user;
                        const displayName = rv.user?.username ?? '[deleted user]';
                        const avatarChar  = rv.user?.username?.[0]?.toUpperCase() ?? '·';
                        return (
                          <div key={rv.id} className="rounded-lg bg-gray-50 px-3 py-2.5">
                            <div className="flex justify-between items-center mb-0.5">
                              <div className="flex items-center gap-2">
                                <div
                                  className={`h-5 w-5 rounded-full flex items-center justify-center font-bold text-[10px] shrink-0 ${
                                    isOrphan ? 'bg-gray-200 text-gray-400' : 'bg-orange-100 text-orange-600'
                                  }`}
                                >
                                  {avatarChar}
                                </div>
                                <span className={`text-xs font-semibold ${isOrphan ? 'text-gray-400 italic' : 'text-gray-700'}`}>
                                  {displayName}
                                </span>
                                <span className="text-xs font-bold text-amber-500">★ {Number(rv.rating).toFixed(1)}</span>
                              </div>
                              <span className="text-xs text-gray-400">
                                {new Date(rv.createdAt).toLocaleDateString()}
                              </span>
                            </div>
                            {rv.content && (
                              <p className="text-xs text-gray-600 leading-relaxed mt-1 ml-7">{rv.content}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}

            </div>

            {/* Personal note — write-only. Hidden in read-only mode
                (Compare panel, group voting modal) since the note
                editor is a write action and a guest viewer has no
                "me" to save against. Owners still see their saved
                note in the inline reviews section above. */}
            {!isReadOnly && (
              <div className="border-t border-gray-100 pt-4">
                <p className="text-sm font-semibold text-gray-700 mb-2">Your Note</p>
                <textarea
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="Jot something down — parking tips, must-order dishes, who to bring…"
                  rows={3}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500 resize-none"
                />
                {(noteDirty || savedNote) && (
                  <div className="flex justify-end gap-2 mt-2">
                    {savedNote && (
                      <button
                        onClick={() => { setNoteText(''); dispatch(setRestaurantNote({ restaurantId: sid(restaurantId), text: '' })); }}
                        className="px-3 py-1.5 text-xs font-medium text-gray-400 hover:text-red-400 transition-colors"
                      >
                        Clear
                      </button>
                    )}
                    {noteDirty && (
                      <button
                        onClick={handleSaveNote}
                        className="rounded-md bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 transition-colors"
                      >
                        Save note
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Match-opt-out toggle. Shown only for custom rows
                (no googlePlaceId) when the modal isn't read-only.
                Lets users proactively silence the Place-match
                scan for rows that will never have a Google
                equivalent ("Cooking at home", "Office potluck").
                Bidirectional — they can re-enable from the same
                control. Optimistic — Redux mirror flips first,
                API call rolls back on failure. */}
            {!isReadOnly && r && !r.googlePlaceId && (
              <div className="border-t border-gray-100 pt-4">
                <label className="flex items-start gap-2 text-sm text-gray-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={r.excludeFromPlaceMatching === true}
                    onChange={(e) => handleToggleMatchOptOut(e.target.checked)}
                    disabled={matchToggleBusy}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-orange-500 focus:ring-orange-400"
                  />
                  <span>
                    Don't suggest Google matches for this restaurant
                    <span className="block text-[11px] text-gray-400 mt-0.5">
                      Useful for entries that won't have a Google listing (e.g. home cooking).
                    </span>
                  </span>
                </label>
              </div>
            )}
          </div>
    </>
  );

  // Inline mode: render as a flat panel sized by its grid cell.
  // `h-full` fills the cell so 2-up / 2x2 grids land at equal
  // heights; `overflow-hidden` clips the rounded corners on the
  // photo gallery and contains the body's internal scroll.
  if (inline) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm flex flex-col h-full overflow-hidden">
        {body}
      </div>
    );
  }

  return (
    <Dialog open onClose={onClose} className="relative z-50">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />

      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-lg rounded-xl bg-white shadow-xl flex flex-col max-h-[90vh]">
          {body}
        </DialogPanel>
      </div>
    </Dialog>
  );
};

// Convenience export — same component in inline mode. Lets the
// Compare page write `<RestaurantDetailPanel ... />` without having
// to remember to thread `inline` through every call site.
export const RestaurantDetailPanel = (props) => (
  <RestaurantDetailModal {...props} inline />
);

export default RestaurantDetailModal;
