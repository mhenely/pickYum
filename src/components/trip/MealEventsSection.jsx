// Trip's day-by-day meal calendar. Reuses the GroupEvent backend (events
// with tripId set) and the existing session/voting machinery, so this
// component is mostly about:
//   (1) grouping events by date,
//   (2) presenting a per-meal add-restaurant flow (saved + nearby),
//   (3) routing voting to /vote/:sessionId (same page groups use).
//
// All the helpers used by MealEventsSection (date formatting, slot order,
// the nearby picker, the per-event vote-method picker) are co-located
// here because they're tightly coupled to this surface — pulling them
// into shared util files would add cross-file coupling without reuse
// payoff.

import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { api } from '../../lib/api';
import ConfirmDialog from '../ConfirmDialog';

// Module-level empty sentinels for useSelector fallbacks. Without this,
// each `?? []` would return a fresh array reference per call and trigger
// dev-mode selector-stability warnings on every dispatch.
const EMPTY_ID_LIST = [];
const EMPTY_OBJECT  = Object.freeze({});

const MEAL_SLOTS = [
  { value: 'BREAKFAST', label: 'Breakfast', icon: '☕' },
  { value: 'LUNCH',     label: 'Lunch',     icon: '🥪' },
  { value: 'DINNER',    label: 'Dinner',    icon: '🍽️' },
  { value: 'SNACK',     label: 'Snack',     icon: '🍪' },
];
const SLOT_ORDER = Object.fromEntries(MEAL_SLOTS.map((s, i) => [s.value, i]));

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

// Date helpers. We group events by the calendar day of `scheduledFor` (or
// "Unscheduled" if null), then within each day sort by mealSlot order.
function dayKey(iso) {
  if (!iso) return 'unscheduled';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unscheduled';
  // YYYY-MM-DD in the user's local timezone — same string for two events on
  // the "same day" even if their UTC date differs.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDayLabel(key) {
  if (key === 'unscheduled') return 'Unscheduled';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long', month: 'short', day: 'numeric',
  });
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Inline nearby-search result picker. Used by the meal "Add restaurant"
// flow when the trip has a primary anchor with a geocodable address.
// Results come from /api/places/nearby keyed by the anchor address; the
// parent component owns the cache so switching between meals on the same
// trip doesn't re-spend the Places quota.
function NearbyOptionPicker({
  anchor, radiusMeters, loading, error, results,
  alreadyAddedPlaceIds, disabled, onPick,
}) {
  if (loading) {
    return <p className="text-[11px] text-gray-400 italic">Searching near {anchor.label}…</p>;
  }
  if (error) {
    return <p className="text-[11px] text-red-500">{error}</p>;
  }

  // Filter out places already on the meal so the user doesn't accidentally
  // re-add a duplicate (the backend would reject via the unique constraint,
  // but a quiet pre-filter is friendlier UX).
  const visible = results.filter((p) => !p.googlePlaceId || !alreadyAddedPlaceIds.has(p.googlePlaceId));

  if (visible.length === 0) {
    return (
      <p className="text-[11px] text-gray-400 italic">
        No nearby results within {Math.round(radiusMeters / 100) / 10}km of {anchor.label}.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1 max-h-56 overflow-y-auto rounded-md border border-gray-200 bg-white">
      {visible.map((p) => (
        <button
          key={p.googlePlaceId ?? p.name}
          type="button"
          onClick={() => onPick(p)}
          disabled={disabled}
          className="flex items-center justify-between gap-2 px-2 py-1.5 text-left text-xs hover:bg-orange-50 disabled:opacity-40 border-b border-gray-100 last:border-0"
        >
          <div className="min-w-0">
            <p className="font-medium text-gray-800 truncate">{p.name}</p>
            <p className="text-[10px] text-gray-500 truncate">
              {p.cuisineType ?? 'Restaurant'}
              {p.googleRating != null && <> · ⭐ {Number(p.googleRating).toFixed(1)}</>}
              {p.priceLevel != null && <> · {'$'.repeat(p.priceLevel)}</>}
            </p>
          </div>
          <span className="text-orange-600 font-semibold shrink-0">Add</span>
        </button>
      ))}
    </div>
  );
}

// Per-event vote-method picker. Mirrors the group-side component in
// GroupDetailPage.jsx — same race-safe optimistic update, same look. Only
// editable while the event is OPEN; afterwards it falls back to a static
// "Vote: <method>" badge in the event card so everyone sees what they walked
// into. Host *or* event creator can change the method while OPEN (matching
// the trip backend's auth rule in PATCH /vote-method).
function VoteMethodPicker({ tripId, event, canEdit, onUpdated }) {
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');
  const [optimistic, setOptimistic] = useState(null);
  const reqIdRef = useRef(0);

  const propValue    = event.voteMethod ?? 'SIMPLE';
  const displayValue = optimistic ?? propValue;
  const isOpen       = event.status === 'OPEN';

  useEffect(() => {
    if (optimistic != null && propValue === optimistic) setOptimistic(null);
  }, [propValue, optimistic]);

  const handleChange = async (next) => {
    if (next === displayValue) return;
    setOptimistic(next);
    setError('');
    setSaving(true);
    const myReqId = ++reqIdRef.current;
    try {
      await api.trips.setVoteMethod(tripId, event.id, next);
      // Pass the new method back so the parent can apply a local-only
      // update instead of refetching the whole trip.
      if (reqIdRef.current === myReqId) onUpdated(next);
    } catch (err) {
      if (reqIdRef.current === myReqId) {
        setError(err.message ?? 'Could not update vote method.');
        setOptimistic(null);
      }
    } finally {
      if (reqIdRef.current === myReqId) setSaving(false);
    }
  };

  const label = displayValue === 'RANKED' ? 'Ranked-choice' : 'Simple Majority';

  if (!canEdit || !isOpen) {
    return (
      <p className="text-[11px] text-gray-500">
        Vote method: <span className="font-medium text-gray-700">{label}</span>
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-2.5">
      <p className="text-[11px] font-semibold text-gray-600 mb-1">Voting method</p>
      <div className="grid grid-cols-1 mb-2 text-[11px] text-gray-500 leading-snug">
        <p
          className={`col-start-1 row-start-1 transition-opacity ${
            displayValue === 'RANKED' ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          aria-hidden={displayValue !== 'RANKED'}
        >
          Each voter ranks every restaurant. Lowest first-place is eliminated each round until one has a majority.
        </p>
        <p
          className={`col-start-1 row-start-1 transition-opacity ${
            displayValue === 'SIMPLE' ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          aria-hidden={displayValue !== 'SIMPLE'}
        >
          Each voter approves any number of restaurants. Highest total wins.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {[
          { value: 'SIMPLE', label: 'Simple Majority' },
          { value: 'RANKED', label: 'Ranked-choice' },
        ].map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => handleChange(opt.value)}
            className={[
              'rounded-md px-2 py-1 text-[11px] font-semibold border transition-colors',
              displayValue === opt.value
                ? 'bg-orange-500 border-orange-500 text-white'
                : 'bg-white border-gray-300 text-gray-600 hover:border-orange-400',
            ].join(' ')}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {saving && <p className="mt-1 text-[10px] text-gray-400">Saving…</p>}
      {error  && <p className="mt-1 text-[10px] text-red-500">{error}</p>}
    </div>
  );
}

// Sorts events by scheduledFor asc (no-schedule events last) with
// createdAt as the tiebreaker — same ordering the server applies on
// the trip GET, so an optimistically-inserted event lands in the same
// position it would after a refetch.
function compareEventOrder(a, b) {
  const aSf = a.scheduledFor ? new Date(a.scheduledFor).getTime() : Infinity;
  const bSf = b.scheduledFor ? new Date(b.scheduledFor).getTime() : Infinity;
  if (aSf !== bSf) return aSf - bSf;
  const aCa = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const bCa = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  return aCa - bCa;
}

export default function MealEventsSection({ trip, currentUserId, isHost, isArchived, onRefresh, setTrip }) {
  const navigate = useNavigate();
  // User's personal favorites + selections are the source for the per-meal
  // restaurant picker. We don't run a separate Places search here — keep
  // the UI compact and reuse what the user has already curated.
  const customRestaurants = useSelector((s) => s.userInfo.customRestaurants ?? EMPTY_OBJECT);
  // Path was `users?.[0]?.favorites` before the slice-flatten migration
  // (Tier 2 #6 + #7). The legacy path always returned undefined post-
  // flatten, then the `?? []` fallback minted a fresh array each call
  // — same dev-mode selector-stability bug that fired in HeartWithKebab.
  // The new path reads `user.favorites` and the fallback is the shared
  // module-level `EMPTY_ID_LIST` so the missing-data branch returns a
  // stable reference too.
  const userFavorites     = useSelector((s) => s.userInfo.user?.favorites ?? EMPTY_ID_LIST);
  const userSelections    = useSelector((s) => s.userInfo.user?.options   ?? EMPTY_ID_LIST);

  // "Add a meal" form state. Collapsed by default; expanded when the user
  // clicks the affordance. Participant picker defaults to all members
  // (empty array on the backend = "everyone").
  const [showCreate, setShowCreate] = useState(false);
  const [newName,    setNewName]    = useState('');
  const [newDate,    setNewDate]    = useState('');
  const [newTime,    setNewTime]    = useState('');
  const [newSlot,    setNewSlot]    = useState('');
  const [newParticipants, setNewParticipants] = useState(new Set()); // empty = all
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Per-event UI state: which event has its add-option dropdown open, which
  // is busy with an action, etc. Keyed by event id so they don't collide.
  const [optionPickerForEvent, setOptionPickerForEvent] = useState(null);
  // 'saved' shows user favorites/selections (legacy path); 'nearby' runs a
  // Google Places nearby search centered on the trip's primary anchor. The
  // nearby tab is hidden when there's no usable anchor.
  const [pickerMode, setPickerMode] = useState('saved');
  // Cached nearby results per anchor address — lets the user switch between
  // events without re-fetching. Keyed by the anchor's `address` string.
  const [nearbyResults, setNearbyResults] = useState({});
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyError,   setNearbyError]   = useState('');
  const [actioningEventId,     setActioningEventId]     = useState(null);
  // Schedule editor (Phase 3): which event is editing its votingStartsAt,
  // and the draft value while open. Closed → schedulePickerForEvent === null.
  const [schedulePickerForEvent, setSchedulePickerForEvent] = useState(null);
  const [scheduleDraft,          setScheduleDraft]          = useState('');

  // Confirm dialog for delete-meal (host or creator only) — same pattern
  // as the page-level archive confirm. `confirmDelete` holds the meal object
  // when open, null otherwise.
  const [confirmDelete, setConfirmDelete] = useState(null);

  const events = trip.events ?? [];

  // Apply a local change to a single event in the trip, skipping the full
  // /api/trips/:id refetch. All the per-event handlers below use this so
  // each action lands instantly instead of waiting for the trip to refetch
  // (~300-700ms each, plus the visible delay of the list updating after
  // the click). Falls back to onRefresh when setTrip isn't wired up.
  const updateEvent = (eventId, updater) => {
    if (!setTrip) { onRefresh(); return; }
    setTrip((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        events: (prev.events ?? []).map((e) => (e.id === eventId ? updater(e) : e)),
      };
    });
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError('');
    try {
      // Combine date + time into an ISO string. Date without time defaults
      // to 12:00 local — pragmatic anchor that doesn't read as "midnight".
      let scheduledFor = null;
      if (newDate) {
        const t = newTime || '12:00';
        scheduledFor = new Date(`${newDate}T${t}`).toISOString();
      }
      const { event } = await api.trips.createEvent(trip.id, {
        name: newName.trim(),
        scheduledFor,
        mealSlot: newSlot || null,
        participantUserIds: [...newParticipants],
      });
      setShowCreate(false);
      setNewName(''); setNewDate(''); setNewTime(''); setNewSlot('');
      setNewParticipants(new Set());
      // Optimistic: insert the server-returned event into the local trip
      // (sorted by the same scheduledFor/createdAt order the server uses).
      // Skips the full-trip refetch — previously the list flashed empty
      // for ~500-1000ms after submit while waiting on `load()`. Falls back
      // to `onRefresh()` if setTrip isn't wired up.
      if (setTrip) {
        setTrip((prev) => {
          if (!prev) return prev;
          const events = [...(prev.events ?? []), event].sort(compareEventOrder);
          return { ...prev, events };
        });
      } else {
        onRefresh();
      }
    } catch (err) {
      setCreateError(err.message ?? 'Could not create meal.');
    } finally {
      setCreating(false);
    }
  };

  const toggleParticipant = (userId) => {
    setNewParticipants((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  };

  const handleAddOption = async (eventId, restaurantId) => {
    setActioningEventId(eventId);
    try {
      const { option } = await api.trips.addEventOption(trip.id, eventId, Number(restaurantId));
      // Leave the picker open so the user can add more in one pass — the
      // already-pinned filter in buildPickList / alreadyAddedPlaceIds will
      // drop the just-added item from the next render's choices.
      updateEvent(eventId, (e) => ({
        ...e,
        // Append while skipping a server-side duplicate (the route uses
        // upsert, so adding an already-existing option returns the
        // existing row).
        options: (e.options ?? []).some((o) => o.restaurantId === option.restaurantId)
          ? e.options
          : [...(e.options ?? []), option],
      }));
    } catch (err) {
      setCreateError(err.message ?? 'Could not add option.');
    } finally {
      setActioningEventId(null);
    }
  };

  // Trip's primary anchor (host marks one as `isPrimary` per trip). Drives
  // the nearby search center for meal-option discovery. When null, the
  // "Search nearby" affordance is hidden — the user can still pick from
  // their saved restaurants as before.
  const primaryAnchor = (trip.anchors ?? []).find((a) => a.isPrimary)
    ?? (trip.anchors ?? [])[0]
    ?? null;

  // 1500m matches the SearchPage's default radius and is wide enough for an
  // urban hotel/conference-anchor walk-shed. The anchor address goes through
  // /api/places/nearby (server geocodes + dedupes).
  const NEARBY_RADIUS_METERS = 1500;

  const loadNearbyForAnchor = useCallback(async (anchor) => {
    if (!anchor?.address) return;
    if (nearbyResults[anchor.address]) return; // cached
    setNearbyLoading(true);
    setNearbyError('');
    try {
      const { restaurants } = await api.places.nearby(anchor.address, NEARBY_RADIUS_METERS, null);
      setNearbyResults((prev) => ({ ...prev, [anchor.address]: restaurants ?? [] }));
    } catch (err) {
      setNearbyError(err.message ?? 'Could not search nearby.');
    } finally {
      setNearbyLoading(false);
    }
  }, [nearbyResults]);

  // Materializes a Google Places result into a Restaurant row (or reuses the
  // existing row keyed by googlePlaceId), then pins it as a meal option.
  // Mirrors SearchPage's ensurePlaceMaterialized minus the Redux mirror — the
  // trip refetch pulls the materialized restaurant inline on the next render.
  const handleAddNearbyOption = async (eventId, place) => {
    setActioningEventId(eventId);
    try {
      const { restaurant } = await api.restaurants.create({
        name: place.name,
        googlePlaceId: place.googlePlaceId,
        cuisineType: place.cuisineType ?? undefined,
        priceLevel: place.priceLevel ?? undefined,
        googleRating: place.googleRating ?? undefined,
        ratingCount: place.ratingCount ?? undefined,
        photos: place.photos && place.photos.length ? place.photos : undefined,
        regularOpeningHours: place.regularOpeningHours ?? undefined,
        phone:   place.phone   ?? undefined,
        website: place.website ?? undefined,
        takeout: place.takeout,
        delivery: place.delivery,
        lat: place.lat ?? undefined,
        lng: place.lng ?? undefined,
      });
      const { option } = await api.trips.addEventOption(trip.id, eventId, restaurant.id);
      // Leave the picker open so the user can keep adding nearby spots
      // back-to-back. NearbyOptionPicker filters out already-pinned
      // googlePlaceIds, so the just-added row drops from the list.
      updateEvent(eventId, (e) => ({
        ...e,
        options: (e.options ?? []).some((o) => o.restaurantId === option.restaurantId)
          ? e.options
          : [...(e.options ?? []), option],
      }));
    } catch (err) {
      setCreateError(err.message ?? 'Could not add option.');
    } finally {
      setActioningEventId(null);
    }
  };

  const handleRemoveOption = async (eventId, restaurantId) => {
    setActioningEventId(eventId);
    try {
      await api.trips.removeEventOption(trip.id, eventId, restaurantId);
      updateEvent(eventId, (e) => ({
        ...e,
        options: (e.options ?? []).filter((o) => String(o.restaurantId) !== String(restaurantId)),
      }));
    } catch (err) {
      setCreateError(err.message ?? 'Could not remove option.');
    } finally {
      setActioningEventId(null);
    }
  };

  const handleStartVoting = async (eventId) => {
    setActioningEventId(eventId);
    try {
      const { sessionId } = await api.trips.startVoting(trip.id, eventId);
      // Reuse the existing /vote/:sessionId page. GroupSessionPage reads
      // session.tripId and routes the Back affordance accordingly.
      navigate(`/vote/${sessionId}`);
    } catch (err) {
      setCreateError(err.message ?? 'Could not start voting.');
    } finally {
      setActioningEventId(null);
    }
  };

  const handleResumeVoting = (event) => {
    if (event.sessionId) navigate(`/vote/${event.sessionId}`);
  };

  const handleAcceptResult = async (eventId) => {
    setActioningEventId(eventId);
    try {
      // force:true mirrors the host's intent ("Close & save result" while
      // the vote is still live) — the server tallies whatever votes have
      // come in and randomly breaks a tie if one falls out, instead of
      // erroring with "session not done yet".
      await api.trips.acceptResult(trip.id, eventId, { force: true });
      onRefresh();
    } catch (err) {
      setCreateError(err.message ?? 'Could not finalize result.');
    } finally {
      setActioningEventId(null);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    const eventId = confirmDelete.id;
    const wasVoting = confirmDelete.status === 'VOTING';
    setConfirmDelete(null);
    setActioningEventId(eventId);
    try {
      // Server rejects delete while VOTING ("Cancel voting before deleting").
      // Roll the cancel into the delete flow so the user gets a single
      // confirm-and-go interaction instead of having to cancel voting first.
      if (wasVoting) {
        await api.trips.cancelVoting(trip.id, eventId);
      }
      await api.trips.deleteEvent(trip.id, eventId);
      // Optimistic: drop the event from the local trip immediately.
      // Without this the deleted row lingered until the full trip
      // refetch landed.
      if (setTrip) {
        setTrip((prev) => prev ? { ...prev, events: (prev.events ?? []).filter((e) => e.id !== eventId) } : prev);
      } else {
        onRefresh();
      }
    } catch (err) {
      setCreateError(err.message ?? 'Could not delete meal.');
    } finally {
      setActioningEventId(null);
    }
  };

  // ── Schedule (auto-start voting) handlers (Phase 3) ──
  // The backend rejects past times, so we pass the picker's local datetime
  // straight through as an ISO string. Passing null clears the schedule.
  const handleSaveSchedule = async (eventId) => {
    if (!scheduleDraft) return;
    setActioningEventId(eventId);
    try {
      const iso = new Date(scheduleDraft).toISOString();
      const { votingStartsAt } = await api.trips.setSchedule(trip.id, eventId, iso);
      setSchedulePickerForEvent(null);
      setScheduleDraft('');
      updateEvent(eventId, (e) => ({ ...e, votingStartsAt }));
    } catch (err) {
      setCreateError(err.message ?? 'Could not set schedule.');
    } finally {
      setActioningEventId(null);
    }
  };

  const handleClearSchedule = async (eventId) => {
    setActioningEventId(eventId);
    try {
      await api.trips.setSchedule(trip.id, eventId, null);
      setSchedulePickerForEvent(null);
      setScheduleDraft('');
      updateEvent(eventId, (e) => ({ ...e, votingStartsAt: null }));
    } catch (err) {
      setCreateError(err.message ?? 'Could not clear schedule.');
    } finally {
      setActioningEventId(null);
    }
  };

  // Convert an ISO datetime to the `<input type="datetime-local">` shape
  // (YYYY-MM-DDTHH:MM in the user's locale). Returns '' for null/invalid.
  const isoToLocalInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // ── Grouping ──
  // Build [{ dayKey, label, events: [...] }, ...] in calendar order. Within a
  // day, sort by mealSlot (breakfast→snack) then by scheduledFor time, with
  // unscheduled events sinking to the bottom of the day.
  const groupedByDay = (() => {
    const map = new Map();
    for (const ev of events) {
      const key = dayKey(ev.scheduledFor);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(ev);
    }
    const dayKeys = [...map.keys()].sort((a, b) => {
      if (a === 'unscheduled') return 1;
      if (b === 'unscheduled') return -1;
      return a.localeCompare(b);
    });
    return dayKeys.map((k) => ({
      key:    k,
      label:  formatDayLabel(k),
      events: map.get(k).slice().sort((x, y) => {
        const sx = x.mealSlot ? SLOT_ORDER[x.mealSlot] : 99;
        const sy = y.mealSlot ? SLOT_ORDER[y.mealSlot] : 99;
        if (sx !== sy) return sx - sy;
        const tx = x.scheduledFor ? Date.parse(x.scheduledFor) : Infinity;
        const ty = y.scheduledFor ? Date.parse(y.scheduledFor) : Infinity;
        return tx - ty;
      }),
    }));
  })();

  // The dropdown of pickable restaurants for an event. Excludes ones already
  // pinned to that event so the user can't accidentally re-add (it'd no-op
  // due to the unique constraint, but the menu shouldn't tempt them).
  //
  // customRestaurants[id] is keyed by id but the *value* doesn't carry the
  // id field (see userInfoSlice.addCustomRestaurant + loadUserData mapper).
  // We attach the loop's id back onto the row so the integer + dedupe
  // checks have something to read.
  const buildPickList = (event) => {
    const already = new Set(event.options.map((o) => String(o.restaurantId)));
    const ids = [...new Set([...userFavorites, ...userSelections].map(String))];
    return ids
      .filter((id) => Number.isInteger(Number(id)) && !already.has(id))
      .map((id) => customRestaurants[id] ? { ...customRestaurants[id], id } : null)
      .filter(Boolean);
  };

  const canCreate = !isArchived;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-700">Meals</h2>
        <span className="text-xs text-gray-400">{events.length} planned</span>
      </div>

      {events.length === 0 && !showCreate && (
        <p className="text-xs text-gray-400 italic mb-3">No meals planned yet.</p>
      )}

      {/* Day-grouped event list */}
      {groupedByDay.map((day) => (
        <div key={day.key} className="mb-4 last:mb-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">{day.label}</p>
          <ul className="flex flex-col gap-2">
            {day.events.map((ev) => {
              const slotMeta = MEAL_SLOTS.find((s) => s.value === ev.mealSlot);
              const isOwn       = ev.createdById === currentUserId;
              const canEdit     = (isHost || isOwn) && !isArchived;
              // Vote method follows the backend rule: host OR creator can
              // change while the event is OPEN. Non-editors see the static
              // badge from inside VoteMethodPicker.
              const canEditVote = canEdit;
              const canVote     = isHost && !isArchived && ev.status === 'OPEN' && ev.options.length >= 2;
              const busy     = actioningEventId === ev.id;
              const pickable = buildPickList(ev);
              return (
                <li key={ev.id} className="rounded-lg border border-gray-100 bg-gray-50/40 p-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {slotMeta && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 font-medium">
                            {slotMeta.icon} {slotMeta.label}
                          </span>
                        )}
                        <p className="text-sm font-semibold text-gray-900 truncate">{ev.name}</p>
                        {ev.status === 'VOTING' && (
                          <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                            Voting
                          </span>
                        )}
                        {ev.status === 'DONE' && (
                          <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                            Decided
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        {ev.scheduledFor ? formatTime(ev.scheduledFor) : 'No time set'}
                        {ev.participantUserIds.length > 0 && (
                          <> · {ev.participantUserIds.length} participant{ev.participantUserIds.length === 1 ? '' : 's'}</>
                        )}
                        {ev.participantUserIds.length === 0 && (
                          <> · everyone on the trip</>
                        )}
                      </p>
                    </div>
                    {canEdit && ev.status !== 'DONE' && (
                      <button
                        onClick={() => setConfirmDelete(ev)}
                        disabled={busy}
                        className="text-xs text-red-500 hover:text-red-700 disabled:opacity-40 shrink-0"
                      >
                        Delete
                      </button>
                    )}
                  </div>

                  {/* Winner badge for completed meals */}
                  {ev.status === 'DONE' && ev.result && (
                    <p className="text-xs text-green-700 mb-2">
                      <span className="font-medium">Winner:</span> {ev.result.winnerName}
                    </p>
                  )}

                  {/* Options list — visible in OPEN status; hidden detail
                      once voting is live (the session page owns the live view). */}
                  {ev.status === 'OPEN' && (
                    <>
                      <ul className="flex flex-col gap-1 mb-2">
                        {ev.options.length === 0 && (
                          <li className="text-[11px] text-gray-400 italic">No restaurants yet — add at least 2 to start voting.</li>
                        )}
                        {ev.options.map((o) => (
                          <li key={o.restaurantId} className="flex items-center justify-between gap-2 text-xs">
                            <span className="text-gray-700 truncate">{o.restaurant?.name ?? `Restaurant ${o.restaurantId}`}</span>
                            {canEdit && (
                              <button
                                onClick={() => handleRemoveOption(ev.id, o.restaurantId)}
                                disabled={busy}
                                className="text-gray-400 hover:text-red-500 disabled:opacity-40"
                                aria-label="Remove option"
                              >
                                ×
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>

                      <div className="mb-2">
                        <VoteMethodPicker
                          tripId={trip.id}
                          event={ev}
                          canEdit={canEditVote}
                          // Picker passes the new method through so we can
                          // apply it locally instead of refetching the full
                          // trip. Falls back to onRefresh if a caller invokes
                          // onUpdated() with no argument.
                          onUpdated={(nextMethod) =>
                            nextMethod
                              ? updateEvent(ev.id, (e) => ({ ...e, voteMethod: nextMethod }))
                              : onRefresh()
                          }
                        />
                      </div>

                      {!isArchived && (
                        optionPickerForEvent === ev.id ? (
                          <div className="flex flex-col gap-2 mb-2">
                            {/* Tabbed source switcher — only show the "near
                                anchor" tab when the trip has a primary anchor
                                with a usable address. Otherwise stay on the
                                saved-restaurants legacy path. */}
                            {primaryAnchor?.address && (
                              <div className="grid grid-cols-2 gap-1 text-[11px]">
                                {[
                                  { id: 'saved',  label: 'Your saved' },
                                  { id: 'nearby', label: `Near ${primaryAnchor.label}` },
                                ].map((t) => (
                                  <button
                                    key={t.id}
                                    type="button"
                                    onClick={() => {
                                      setPickerMode(t.id);
                                      if (t.id === 'nearby') loadNearbyForAnchor(primaryAnchor);
                                    }}
                                    className={[
                                      'rounded-md px-2 py-1 font-semibold border transition-colors truncate',
                                      pickerMode === t.id
                                        ? 'bg-orange-500 border-orange-500 text-white'
                                        : 'bg-white border-gray-300 text-gray-600 hover:border-orange-400',
                                    ].join(' ')}
                                  >
                                    {t.label}
                                  </button>
                                ))}
                              </div>
                            )}

                            {pickerMode === 'nearby' && primaryAnchor?.address ? (
                              <NearbyOptionPicker
                                anchor={primaryAnchor}
                                radiusMeters={NEARBY_RADIUS_METERS}
                                loading={nearbyLoading}
                                error={nearbyError}
                                results={nearbyResults[primaryAnchor.address] ?? []}
                                alreadyAddedPlaceIds={new Set(
                                  (ev.options ?? []).map((o) => o.restaurant?.googlePlaceId).filter(Boolean),
                                )}
                                disabled={busy}
                                onPick={(place) => handleAddNearbyOption(ev.id, place)}
                              />
                            ) : pickable.length === 0 ? (
                              <p className="text-[11px] text-gray-400 italic">
                                Your favorites + selections are empty (or already added). Add some restaurants from the Search page first.
                              </p>
                            ) : (
                              <select
                                // key forces a fresh uncontrolled <select> after
                                // each add — without it the dropdown keeps the
                                // last picked value, so re-picking the same row
                                // emits no change event.
                                key={ev.options.length}
                                onChange={(e) => e.target.value && handleAddOption(ev.id, e.target.value)}
                                defaultValue=""
                                className="rounded-md border border-gray-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500"
                              >
                                <option value="" disabled>Pick from your saved restaurants…</option>
                                {pickable.map((r) => (
                                  <option key={r.id} value={r.id}>{r.name}</option>
                                ))}
                              </select>
                            )}

                            <button
                              onClick={() => setOptionPickerForEvent(null)}
                              className="text-[11px] text-gray-500 hover:text-gray-700 self-start"
                            >
                              Done
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => {
                              setOptionPickerForEvent(ev.id);
                              // Default to nearby when an anchor is available — the
                              // whole point of trip planning is "places where we are,
                              // not places at home." User can toggle back to saved.
                              if (primaryAnchor?.address) {
                                setPickerMode('nearby');
                                loadNearbyForAnchor(primaryAnchor);
                              } else {
                                setPickerMode('saved');
                              }
                            }}
                            className="text-xs font-medium text-orange-600 hover:text-orange-800 mb-2"
                          >
                            + Add restaurant
                          </button>
                        )
                      )}
                    </>
                  )}

                  {/* Per-meal action row — varies by status + role */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {canVote && (
                      <button
                        onClick={() => handleStartVoting(ev.id)}
                        disabled={busy}
                        className="rounded-md bg-orange-500 px-3 py-1 text-xs font-semibold text-white hover:bg-orange-400 disabled:opacity-40"
                      >
                        {busy ? 'Starting…' : 'Start voting'}
                      </button>
                    )}
                    {ev.status === 'VOTING' && !isArchived && (
                      <>
                        <button
                          onClick={() => handleResumeVoting(ev)}
                          className="rounded-md bg-blue-500 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-400"
                        >
                          Open voting
                        </button>
                        {isHost && (
                          <button
                            onClick={() => handleAcceptResult(ev.id)}
                            disabled={busy}
                            className="text-xs font-medium text-gray-600 hover:text-gray-900 disabled:opacity-40"
                          >
                            {busy ? 'Closing…' : 'Close & save result'}
                          </button>
                        )}
                      </>
                    )}
                  </div>

                  {/* Auto-start schedule (host only, OPEN events). When set,
                      the on-read sweeper in GET /api/trips/:id opens voting
                      automatically once the time passes. */}
                  {isHost && !isArchived && ev.status === 'OPEN' && (
                    <div className="mt-2 text-xs">
                      {schedulePickerForEvent === ev.id ? (
                        <div className="flex flex-col gap-1">
                          <input
                            type="datetime-local"
                            value={scheduleDraft}
                            onChange={(e) => setScheduleDraft(e.target.value)}
                            className="rounded-md border border-gray-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleSaveSchedule(ev.id)}
                              disabled={!scheduleDraft || busy}
                              className="rounded-md bg-orange-500 px-2 py-1 text-[11px] font-semibold text-white hover:bg-orange-400 disabled:opacity-40"
                            >
                              {busy ? 'Saving…' : 'Save'}
                            </button>
                            {ev.votingStartsAt && (
                              <button
                                onClick={() => handleClearSchedule(ev.id)}
                                disabled={busy}
                                className="text-[11px] font-medium text-red-500 hover:text-red-700 disabled:opacity-40"
                              >
                                Clear
                              </button>
                            )}
                            <button
                              onClick={() => { setSchedulePickerForEvent(null); setScheduleDraft(''); }}
                              className="text-[11px] font-medium text-gray-500 hover:text-gray-700"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : ev.votingStartsAt ? (
                        <p className="text-gray-500">
                          Auto-opens at{' '}
                          <span className="font-medium text-gray-700">
                            {new Date(ev.votingStartsAt).toLocaleString(undefined, {
                              month: 'short', day: 'numeric',
                              hour: 'numeric', minute: '2-digit',
                            })}
                          </span>
                          {' '}
                          <button
                            onClick={() => {
                              setSchedulePickerForEvent(ev.id);
                              setScheduleDraft(isoToLocalInput(ev.votingStartsAt));
                            }}
                            className="text-orange-600 hover:text-orange-800 font-medium"
                          >
                            edit
                          </button>
                        </p>
                      ) : (
                        <button
                          onClick={() => {
                            setSchedulePickerForEvent(ev.id);
                            setScheduleDraft('');
                          }}
                          className="text-gray-500 hover:text-gray-700"
                        >
                          + Auto-start voting at a set time
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {/* Create-meal form — collapsed by default */}
      {canCreate && (
        !showCreate ? (
          <button
            onClick={() => {
              setShowCreate(true);
              // Pre-fill the date with the trip's start so the calendar
              // opens on the trip's month (browsers open the date picker
              // on the input's value when set, the current month when
              // empty). User can change it before submitting.
              if (!newDate && trip.startDate) {
                setNewDate(tripDateToInputValue(trip.startDate));
              }
            }}
            className="text-xs font-medium text-orange-600 hover:text-orange-800"
          >
            + Add a meal
          </button>
        ) : (
          <form onSubmit={handleCreate} className="flex flex-col gap-2 border-t border-gray-100 pt-3">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Meal name (e.g. Saturday dinner)"
              maxLength={80}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <div className="flex gap-2">
              <input
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                min={tripDateToInputValue(trip.startDate)}
                max={tripDateToInputValue(trip.endDate)}
                className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              <input
                type="time"
                value={newTime}
                onChange={(e) => setNewTime(e.target.value)}
                /* w-40 (was w-28) — 12-hour locales need ~120-130px to fit
                   "HH:MM AM/PM" with the spinner without the AM/PM control
                   overlapping the digits. */
                className="w-40 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
            </div>
            <select
              value={newSlot}
              onChange={(e) => setNewSlot(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            >
              <option value="">No meal slot</option>
              {MEAL_SLOTS.map((s) => (
                <option key={s.value} value={s.value}>{s.icon} {s.label}</option>
              ))}
            </select>

            {/* Participant picker. Defaults to none = "everyone"; checking
                someone restricts to that subset (good for "couples meal"
                or "the planners are sorting brunch tomorrow" cases). */}
            <details className="text-xs">
              <summary className="cursor-pointer text-gray-600 hover:text-gray-800">
                Participants ({newParticipants.size === 0 ? 'everyone' : `${newParticipants.size} selected`})
              </summary>
              <div className="mt-2 flex flex-col gap-1 pl-2">
                {trip.members.map((m) => (
                  <label key={m.userId} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newParticipants.has(m.userId)}
                      onChange={() => toggleParticipant(m.userId)}
                    />
                    <span className="text-xs text-gray-700">{m.user.username}</span>
                  </label>
                ))}
              </div>
            </details>

            {createError && <p className="text-xs text-red-500">{createError}</p>}

            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={!newName.trim() || creating}
                className="rounded-md bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-400 disabled:opacity-40"
              >
                {creating ? 'Saving…' : 'Add meal'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCreate(false);
                  setCreateError('');
                  setNewName(''); setNewDate(''); setNewTime(''); setNewSlot('');
                  setNewParticipants(new Set());
                }}
                className="text-xs font-medium text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
            </div>
          </form>
        )
      )}

      {confirmDelete && (
        <ConfirmDialog
          message={`Delete "${confirmDelete.name}"? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </section>
  );
}
