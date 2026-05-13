import { useState, useEffect } from 'react';
import { Dialog, DialogPanel } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useDispatch, useSelector } from 'react-redux';
import { addUserOption, removeUserOption, updateUserFavorites, setRestaurantNote, persistAddReview, removeUserReview } from '../redux/slices/userInfoSlice';
import useCurrentUser from '../hooks/useCurrentUser';
import RatingDisplay from './RatingDisplay';
import InfoRow from './InfoRow';
import { PRICE_LABELS } from '../utils/restaurantConstants';
import { normalizeUrl } from '../utils/normalizeUrl';
import { socialApi } from '../lib/socialApi';
import { api } from '../lib/api';

const sid = (id) => String(id);
const mean = (nums) => nums.reduce((a, b) => a + b, 0) / nums.length;

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

  // ── Review tab state ──────────────────────────────────────
  const [reviewTab, setReviewTab] = useState('yours'); // 'yours' | 'community'
  const [communityReviews, setCommunityReviews] = useState(null); // null = not yet fetched
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
    if (reviewTab !== 'community') return;
    if (communityReviews !== null) return; // already fetched
    const numId = Number(restaurantId);
    if (!numId) return;
    setCommunityLoading(true);
    api.restaurants.getReviews(numId)
      .then((data) => setCommunityReviews(data.reviews ?? []))
      .catch(() => setCommunityReviews([]))
      .finally(() => setCommunityLoading(false));
  }, [reviewTab, restaurantId, communityReviews]);

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

          {/* ── Header ───────────────────────────────────────── */}
          <div className="flex justify-between items-start p-6 pb-4">
            <div className="min-w-0">
              <h2 className="text-2xl font-bold text-gray-900 leading-tight">{r.name}</h2>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <span className="px-2.5 py-0.5 rounded-full bg-orange-100 text-orange-700 text-xs font-semibold">
                  {r.type}
                </span>
                <RatingDisplay
                  restaurantId={restaurantId}
                  googleRating={r.rating ?? null}
                  personalRating={avgRating}
                />
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

            {/* Info grid */}
            <div className="grid grid-cols-2 gap-x-8 gap-y-4">
              <InfoRow label="Price"   value={PRICE_LABELS[r.price] ?? '—'} />
              <InfoRow label="Opens"   value={r.hours ?? '—'} />
              {r.phone   && <InfoRow label="Phone"   value={r.phone}   href={`tel:${r.phone}`} />}
              {r.website && <InfoRow label="Website" value={r.website} href={normalizeUrl(r.website)} external />}
              {r.yelp    && <InfoRow label="Yelp"    value={r.yelp}    href={normalizeUrl(r.yelp)}    external />}
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

              {/* Tab bar */}
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
                        : `Community${communityReviews !== null ? ` (${communityReviews.length})` : ''}`}
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
                          className="rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white"
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
                  {!communityLoading && communityReviews !== null && communityReviews.length === 0 && (
                    <p className="text-xs text-gray-400 italic">No community reviews yet.</p>
                  )}
                  {!communityLoading && communityReviews && communityReviews.length > 0 && (
                    <div className="flex flex-col gap-2 max-h-52 overflow-y-auto pr-1">
                      {communityReviews.map((rv) => (
                        <div key={rv.id} className="rounded-lg bg-gray-50 px-3 py-2.5">
                          <div className="flex justify-between items-center mb-0.5">
                            <div className="flex items-center gap-2">
                              <div className="h-5 w-5 rounded-full bg-orange-100 flex items-center justify-center text-orange-600 font-bold text-[10px] shrink-0">
                                {rv.user.username[0].toUpperCase()}
                              </div>
                              <span className="text-xs font-semibold text-gray-700">{rv.user.username}</span>
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
                      ))}
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
