import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { pushToast } from '../redux/slices/toastSlice';
import { api } from '../lib/api';
import { groupsApi } from '../lib/groupsApi';
import ConfirmDialog from '../components/ConfirmDialog';
import RestaurantDetailModal from '../components/RestaurantDetailModal';
import DietaryTagChips from '../components/DietaryTagChips';
import MembersSection from '../components/trip/MembersSection';
import AnchorsSection from '../components/trip/AnchorsSection';
import MealEventsSection from '../components/trip/MealEventsSection';
import { SkeletonDetailPage, SkeletonLine, SkeletonStatGrid } from '../components/Skeleton';

// Trip detail — members + anchors management. Meal events live in
// phase 2 (placeholder section below). The host gets edit affordances
// on members and anchors; non-host members see read-only lists plus a
// "leave trip" button. Once archivedAt is set, every action is hidden.

// Module-level empty array shared by every selector below that falls
// back when the corresponding slice path is missing. Without this, each
// `?? []` would return a fresh array reference per call and React-
// Redux's dev-mode selector-stability check would warn on every
// dispatch. Same pattern as `allLists` / `Toaster`'s EMPTY_QUEUE.
const EMPTY_ID_LIST = [];
const EMPTY_OBJECT  = Object.freeze({});

// ── Helpers ──────────────────────────────────────────────────

function formatDateRange(startDate, endDate) {
  if (!startDate && !endDate) return 'Dates not set';
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  const start = startDate ? new Date(startDate).toLocaleDateString(undefined, opts) : null;
  const end   = endDate   ? new Date(endDate).toLocaleDateString(undefined, opts)   : null;
  if (start && end) return `${start} – ${end}`;
  return start ?? end;
}

// Formats an ISO trip date as YYYY-MM-DD for `<input type="date">`. Trip
// startDate / endDate are stored as UTC midnight (the client sends
// YYYY-MM-DD from a date input; `new Date('YYYY-MM-DD')` parses as UTC),
// so we extract UTC parts here — using local getDate() would shift to
// the previous day for users west of UTC.
function tripDateToInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}


function TripInsightsPanel({ tripId }) {
  const [open, setOpen]       = useState(false);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [infoForId, setInfoForId] = useState(null);
  // Threaded into RestaurantDetailModal so it can render instantly for any
  // restaurant the user has touched before (covers most insight clicks).
  // Without this the modal sits blank until /api/restaurants/:id resolves.
  const customRestaurants = useSelector((s) => s.userInfo.customRestaurants ?? EMPTY_OBJECT);

  const handleToggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (data) return;
    setLoading(true); setError('');
    try {
      const result = await api.trips.getInsights(tripId);
      setData(result);
    } catch (err) {
      setError(err.message ?? 'Could not load insights.');
    } finally {
      setLoading(false);
    }
  };

  const METHOD_LABELS = { vote: '🗳 Vote', flip: '🪙 Flip', spin: '🎰 Spin' };
  const SLOT_LABELS   = { BREAKFAST: '🥐 Breakfast', BRUNCH: '🥞 Brunch', LUNCH: '🥗 Lunch', DINNER: '🍽 Dinner', SNACK: '🍪 Snack' };

  return (
    <section>
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between text-left rounded-xl border border-gray-200 bg-white px-4 py-3 hover:bg-gray-50 transition-colors"
      >
        <span className="text-sm font-semibold text-gray-700">📊 Trip insights</span>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="mt-2 rounded-xl border border-gray-200 bg-white p-4">
          {loading && (
            <div className="flex flex-col gap-3">
              <SkeletonStatGrid tiles={3} />
              <SkeletonLine width="w-2/3" height="h-3" />
              <SkeletonLine width="w-1/2" height="h-3" />
            </div>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}
          {data && !loading && !error && (
            data.totalEvents === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">
                No completed meals yet. Come back after the trip makes a few decisions.
              </p>
            ) : (
              <div className="flex flex-col gap-5">
                {/* Stat tiles */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <p className="text-2xl font-black text-orange-600">{data.totalEvents}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">meals decided</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <p className="text-2xl font-black text-orange-600">{data.distinctWinners}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">different winners</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <p className="text-2xl font-black text-orange-600">{Object.keys(data.memberAppearances ?? {}).length}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">members participated</p>
                  </div>
                </div>

                {/* Meal slot breakdown — trip-specific */}
                {Object.keys(data.mealSlotCounts ?? {}).length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Meals by slot</p>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(data.mealSlotCounts).map(([slot, c]) => (
                        <span key={slot} className="rounded-full bg-amber-50 border border-amber-100 text-amber-700 px-3 py-1 text-xs">
                          {SLOT_LABELS[slot] ?? slot} · <span className="font-semibold">{c}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Method breakdown */}
                {Object.keys(data.methodCounts ?? {}).length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">How decisions are made</p>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(data.methodCounts).map(([m, c]) => (
                        <span key={m} className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
                          {METHOD_LABELS[m] ?? m} · <span className="font-semibold">{c}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {data.topWinners?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Trip favorites in practice</p>
                    <ul className="space-y-1.5">
                      {data.topWinners.map((r) => (
                        <li key={r.restaurantId}>
                          <button
                            type="button"
                            onClick={() => setInfoForId(r.restaurantId)}
                            className="w-full flex items-center justify-between rounded-lg bg-green-50 border border-green-100 px-3 py-1.5 transition-colors hover:bg-green-100 hover:border-green-200 focus:outline-none focus:ring-2 focus:ring-green-400 text-left"
                          >
                            <span className="text-sm font-medium text-green-800 truncate">🏆 {r.name}</span>
                            <span className="text-xs text-green-700 shrink-0">
                              won {r.wins}× · {Math.round(r.winRate * 100)}%
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {data.oftenSkipped?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Always added, never chosen</p>
                    <ul className="space-y-1.5">
                      {data.oftenSkipped.map((r) => (
                        <li key={r.restaurantId}>
                          <button
                            type="button"
                            onClick={() => setInfoForId(r.restaurantId)}
                            className="w-full flex items-center justify-between rounded-lg bg-amber-50 border border-amber-100 px-3 py-1.5 transition-colors hover:bg-amber-100 hover:border-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-400 text-left"
                          >
                            <span className="text-sm font-medium text-amber-900 truncate">{r.name}</span>
                            <span className="text-xs text-amber-700 shrink-0">
                              considered {r.considered}× · 0 wins
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {Object.keys(data.memberAppearances ?? {}).length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Who shows up</p>
                    <ul className="space-y-1.5">
                      {Object.entries(data.memberAppearances)
                        .sort(([, a], [, b]) => b - a)
                        .slice(0, 8)
                        .map(([name, count]) => (
                          <li key={name} className="flex items-center justify-between text-sm">
                            <span className="text-gray-700">{name}</span>
                            <span className="text-xs text-gray-500">
                              {count} of {data.totalEvents}
                            </span>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}

                {/* Vote alignment — % of meals each member voted for the winner */}
                {(() => {
                  const aligned = Object.entries(data.memberWinAccuracy ?? {})
                    .filter(([, v]) => v && v.picks > 0)
                    .sort(([, a], [, b]) => b.rate - a.rate);
                  if (aligned.length === 0) return null;
                  return (
                    <div>
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Vote alignment</p>
                      <p className="text-[11px] text-gray-400 mb-2">
                        How often each member's vote matched the meal's winner.
                      </p>
                      <ul className="space-y-1.5">
                        {aligned.map(([name, v]) => {
                          const pct = Math.round(v.rate * 100);
                          const tone = pct >= 80 ? 'text-emerald-700 bg-emerald-50 border-emerald-100'
                                     : pct <= 25 ? 'text-purple-700 bg-purple-50 border-purple-100'
                                     :             'text-gray-700 bg-gray-50 border-gray-100';
                          return (
                            <li key={name} className={`flex items-center gap-3 rounded-lg border px-3 py-1.5 ${tone}`}>
                              <span className="text-sm font-medium flex-shrink-0 truncate min-w-0 flex-1">{name}</span>
                              <div className="w-24 h-1.5 bg-white/60 rounded-full overflow-hidden flex-shrink-0">
                                <div
                                  className={pct >= 80 ? 'bg-emerald-500 h-full' : pct <= 25 ? 'bg-purple-500 h-full' : 'bg-gray-400 h-full'}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="text-xs font-mono w-16 text-right flex-shrink-0">
                                {pct}% · {v.wins}/{v.picks}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })()}

                {Object.keys(data.memberCuisines ?? {}).length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">What each member proposes</p>
                    <ul className="space-y-1.5">
                      {Object.entries(data.memberCuisines).map(([name, cuisines]) => (
                        <li key={name} className="flex items-center gap-2 text-sm">
                          <span className="text-gray-700 font-medium min-w-0 truncate" style={{ flex: '0 0 6rem' }}>{name}</span>
                          <div className="flex gap-1.5 flex-wrap min-w-0">
                            {cuisines.map((c) => (
                              <span
                                key={c.cuisine}
                                className="rounded-full bg-orange-50 border border-orange-100 text-orange-700 text-[11px] px-2 py-0.5"
                              >
                                {c.cuisine} <span className="font-semibold">·{c.count}</span>
                              </span>
                            ))}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )
          )}
        </div>
      )}

      {infoForId && (
        <RestaurantDetailModal
          restaurantId={Number(infoForId)}
          // Without restaurantMap the modal renders nothing until its own
          // /api/restaurants/:id fetch resolves — which is the 2+ second
          // delay between click and modal appearing. Threading the user's
          // customRestaurants here lets the modal open instantly for any
          // restaurant they've previously interacted with (the common
          // case for trip-insights clicks).
          restaurantMap={customRestaurants}
          readOnly
          actions={null}
          onClose={() => setInfoForId(null)}
        />
      )}
    </section>
  );
}

// ── Page ────────────────────────────────────────────────────

export default function TripDetailPage() {
  const { id } = useParams();
  // useNavigate is consumed inside MembersSection (for "leave" → bounce
  // to /trips); the page itself doesn't need it directly.
  const currentUserId = useSelector((s) => s.auth.user?.id);
  const dispatch = useDispatch();

  const [trip,    setTrip]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [archiving, setArchiving] = useState(false);
  // null = no dialog; true = archive-confirm dialog open.
  const [confirmArchive, setConfirmArchive] = useState(false);

  // `load` is called both on initial mount AND from every mutation
  // handler. Without the `trip != null` gate we'd set loading=true on
  // every refresh, which blanks the entire page with "Loading trip…"
  // for the duration of the fetch — making every click feel laggy.
  // Now: first load shows the placeholder; subsequent refreshes keep
  // the existing trip on screen and swap in the fresh copy when it
  // arrives.
  const load = useCallback(async () => {
    setTrip((prev) => { if (!prev) setLoading(true); return prev; });
    setError('');
    try {
      const { trip: t } = await api.trips.get(Number(id));
      setTrip(t);
    } catch (err) {
      setError(err.message ?? 'Could not load trip.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <SkeletonDetailPage />;
  if (error)   return <p className="text-center text-sm text-red-500 py-20">{error}</p>;
  if (!trip)   return null;

  const isHost     = trip.hostId === currentUserId;
  const isArchived = !!trip.archivedAt;
  const canHostAct = isHost && !isArchived;

  const handleArchive = async () => {
    setConfirmArchive(false);
    setArchiving(true);
    try {
      const { trip: updated } = await api.trips.archive(trip.id);
      setTrip(updated);
      dispatch(pushToast({
        id: `trip-archive-${Date.now()}`,
        status: 'success',
        label: `Trip "${updated.name}" archived`,
      }));
    } catch (err) {
      setError(err.message ?? 'Could not archive trip.');
      dispatch(pushToast({
        id: `trip-archive-err-${Date.now()}`,
        status: 'error',
        label: 'Could not archive trip',
        detail: err?.message,
      }));
    } finally {
      setArchiving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
      <Link to="/trips" className="text-xs text-orange-500 hover:text-orange-400 transition-colors mb-4 inline-block">
        ← Back to trips
      </Link>

      <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">{trip.name}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{trip.destination}</p>
        </div>
        {isArchived && (
          <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 shrink-0">
            Archived
          </span>
        )}
      </div>
      <p className="text-xs text-gray-400 mb-3">{formatDateRange(trip.startDate, trip.endDate)}</p>

      {/* Primary anchor pill — surfaces what nearby-search will use as
          its center. Click jumps to the anchors section for management.
          When no anchor is set, a CTA explains why nearby-search is
          disabled on meal events (the prior silent-disable was confusing). */}
      {(() => {
        const primary = (trip.anchors ?? []).find((a) => a.isPrimary) ?? (trip.anchors ?? [])[0];
        if (primary) {
          return (
            <a
              href="#trip-anchors"
              className="inline-flex items-center gap-1.5 rounded-full bg-gray-50 border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100 mb-3"
              title="Manage trip anchors"
            >
              <span aria-hidden="true">📍</span>
              <span className="truncate max-w-[200px]">{primary.label}</span>
            </a>
          );
        }
        if (canHostAct) {
          return (
            <a
              href="#trip-anchors"
              className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 border border-amber-200 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 mb-3"
            >
              <span aria-hidden="true">📍</span>
              <span>Add an anchor to enable nearby search</span>
            </a>
          );
        }
        return null;
      })()}

      {/* Dietary roll-up — union of every member's dietaryTags. Surfaces
          the group's collective constraints up front so the meal planner
          (or whoever's adding candidates) can keep them in mind. Hidden
          when no member has tagged anything to avoid an empty chip strip. */}
      {(() => {
        const tagSet = new Set();
        const tagByUser = new Map(); // tag → [usernames] for the tooltip
        for (const m of trip.members ?? []) {
          const tags = m.user?.dietaryTags ?? [];
          for (const t of tags) {
            tagSet.add(t);
            if (!tagByUser.has(t)) tagByUser.set(t, []);
            tagByUser.get(t).push(m.user.username);
          }
        }
        if (tagSet.size === 0) return null;
        return (
          <div className="rounded-md border border-emerald-100 bg-emerald-50/50 px-3 py-2 mb-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700 shrink-0">
                Group dietary
              </span>
              {[...tagSet].sort().map((t) => (
                <span
                  key={t}
                  title={`${(tagByUser.get(t) ?? []).join(', ')}`}
                  className="inline-flex items-center text-xs px-2 py-0.5 rounded-full bg-emerald-100 border border-emerald-200 text-emerald-800"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Next-meal callout — surfaces the nearest upcoming meal so users
          don't have to scroll the events list to answer "what's next?".
          Only shows when there's at least one scheduled, non-DONE meal in
          the future. */}
      {(() => {
        const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
        const next = (trip.events ?? [])
          .filter((e) => e.status !== 'DONE' && e.scheduledFor && new Date(e.scheduledFor) >= startOfToday)
          .sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor))[0];
        if (!next) return null;
        const dt = new Date(next.scheduledFor);
        const whenLabel = dt.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        return (
          <div className="mb-5 flex items-center gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm">
            <span className="text-orange-700 font-semibold shrink-0">Next:</span>
            <span className="text-gray-800 truncate min-w-0">{next.name}</span>
            <span className="text-orange-700/80 text-xs shrink-0 ml-auto">{whenLabel}</span>
          </div>
        );
      })()}

      <div className="flex flex-col gap-4 mb-5">
        <MembersSection
          trip={trip}
          canHostAct={canHostAct}
          currentUserId={currentUserId}
          onRefresh={load}
        />
        <AnchorsSection
          trip={trip}
          canHostAct={canHostAct}
          onRefresh={load}
        />

        <MealEventsSection
          trip={trip}
          currentUserId={currentUserId}
          isHost={isHost}
          isArchived={isArchived}
          onRefresh={load}
          // Optimistic-update lever — lets handlers apply local trip
          // mutations (event add/remove) without waiting for a refetch.
          // The list updates the moment the server confirms instead of
          // the moment the entire trip refetch returns.
          setTrip={setTrip}
        />

        <TripInsightsPanel tripId={trip.id} />
      </div>

      {canHostAct && (
        <div className="border-t border-gray-200 pt-4">
          <button
            onClick={() => setConfirmArchive(true)}
            disabled={archiving}
            className="text-xs font-medium text-red-500 hover:text-red-700 disabled:opacity-40"
          >
            {archiving ? 'Archiving…' : 'Archive this trip'}
          </button>
        </div>
      )}

      {confirmArchive && (
        <ConfirmDialog
          message="Archive this trip? It will become read-only for everyone."
          confirmLabel="Archive"
          onConfirm={handleArchive}
          onCancel={() => setConfirmArchive(false)}
        />
      )}
    </div>
  );
}
