import { useState, useEffect } from 'react';
import { Dialog, DialogPanel } from '@headlessui/react';
import { XMarkIcon, ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { useDispatch, useSelector } from 'react-redux';
import { addUserOption, removeUserOption, updateUserFavorites, setRestaurantNote, persistAddReview, removeUserReview } from '../redux/slices/userInfoSlice';
import useCurrentUser from '../hooks/useCurrentUser';
import InfoRow from './InfoRow';
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
            {/* Position counter — "3 / 5" in the bottom-right corner.
                Helps users know how many photos are in the carousel
                without having to scan the thumbnail strip. */}
            <span className="absolute bottom-2 right-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white tabular-nums">
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

const RestaurantDetailModal = ({ restaurantId, restaurantMap, onClose }) => {
  const dispatch = useDispatch();
  const userInfo = useCurrentUser();
  const isAuthenticated = useSelector((state) => state.auth?.status === 'authenticated');

  const r = restaurantMap?.[restaurantId];
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
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [reviewContent, setReviewContent] = useState('');
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewDate, setReviewDate] = useState(() => new Date().toLocaleDateString());
  const [reviewSubmitting, setReviewSubmitting] = useState(false);

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
  const isFavorite = userInfo.favorites.map(sid).includes(sid(restaurantId));
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

  return (
    <Dialog open onClose={onClose} className="relative z-50">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />

      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-lg rounded-xl bg-white shadow-xl flex flex-col max-h-[90vh]">

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
            <button
              onClick={onClose}
              className="ml-4 shrink-0 text-gray-400 hover:text-gray-600 transition-colors"
            >
              <XMarkIcon className="h-6 w-6" />
            </button>
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

            {/* Action buttons */}
            <div className="flex gap-3">
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
              <button
                onClick={() =>
                  dispatch(updateUserFavorites({ restaurantId: sid(restaurantId), userId: userInfo.id }))
                }
                className={[
                  'flex-1 rounded-lg py-2 text-sm font-semibold transition-colors border',
                  isFavorite
                    ? 'bg-red-50 text-red-600 hover:bg-red-100 border-red-200'
                    : 'bg-white text-gray-600 hover:bg-gray-50 border-gray-200',
                ].join(' ')}
              >
                {isFavorite ? '♥ Unfavorite' : '♡ Favorite'}
              </button>
            </div>

            {/* ── Recommend section (authenticated only) ───────── */}
            {isAuthenticated && (
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

            {/* Reviews — tabbed: Yours / Community */}
            <div className="border-t border-gray-100 pt-4">

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
                {reviewTab === 'yours' && !showReviewForm && (
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
                              <button
                                onClick={() => dispatch(removeUserReview({ restaurantId: sid(restaurantId), id: rv.id }))}
                                className="text-xs text-gray-300 hover:text-red-400 transition-colors"
                              >
                                ✕
                              </button>
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

            {/* Personal note */}
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
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
};

export default RestaurantDetailModal;
