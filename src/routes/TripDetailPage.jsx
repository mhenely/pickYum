import { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { api } from '../lib/api';
import { groupsApi } from '../lib/groupsApi';
import ConfirmDialog from '../components/ConfirmDialog';

// Trip detail — members + anchors management. Meal events live in
// phase 2 (placeholder section below). The host gets edit affordances
// on members and anchors; non-host members see read-only lists plus a
// "leave trip" button. Once archivedAt is set, every action is hidden.

// ── Helpers ──────────────────────────────────────────────────

function formatDateRange(startDate, endDate) {
  if (!startDate && !endDate) return 'Dates not set';
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  const start = startDate ? new Date(startDate).toLocaleDateString(undefined, opts) : null;
  const end   = endDate   ? new Date(endDate).toLocaleDateString(undefined, opts)   : null;
  if (start && end) return `${start} – ${end}`;
  return start ?? end;
}

// ── Members section ─────────────────────────────────────────

function MembersSection({ trip, canHostAct, currentUserId, onRefresh }) {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [inviting,    setInviting]    = useState(false);
  const [inviteError, setInviteError] = useState('');
  // Per-invite action loading state (rescind button).
  const [rescindingId, setRescindingId] = useState(null);
  // Import-from-group state. The dropdown lists every group the user is
  // a member of (host or not). Lazily loaded on first interaction.
  const [showImport,   setShowImport]   = useState(false);
  const [groups,       setGroups]       = useState([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [importingId,  setImportingId]  = useState(null);
  const [importError,  setImportError]  = useState('');

  const handleInvite = async (e) => {
    e.preventDefault();
    if (!username.trim()) return;
    setInviteError('');
    setInviting(true);
    try {
      await api.trips.inviteMember(trip.id, username.trim());
      setUsername('');
      onRefresh();
    } catch (err) {
      setInviteError(err.message ?? 'Could not send invite.');
    } finally {
      setInviting(false);
    }
  };

  const loadGroups = async () => {
    if (groupsLoaded) return;
    try {
      const { groups: list } = await groupsApi.list();
      setGroups(list ?? []);
      setGroupsLoaded(true);
    } catch (err) {
      setImportError(err.message ?? 'Could not load your groups.');
    }
  };

  const handleImport = async (groupId) => {
    setImportError('');
    setImportingId(groupId);
    try {
      await api.trips.importInvitesFromGroup(trip.id, groupId);
      setShowImport(false);
      onRefresh();
    } catch (err) {
      setImportError(err.message ?? 'Could not import invites.');
    } finally {
      setImportingId(null);
    }
  };

  const handleRescind = async (inviteId) => {
    setRescindingId(inviteId);
    try {
      await api.trips.rescindInvite(trip.id, inviteId);
      onRefresh();
    } catch { /* non-fatal */ }
    finally { setRescindingId(null); }
  };

  const handleRemove = async (userId) => {
    try {
      await api.trips.removeMember(trip.id, userId);
      // If the user removed themselves, they're no longer a member —
      // bounce back to the trips list since the detail page will 403.
      if (userId === currentUserId) navigate('/trips');
      else onRefresh();
    } catch {
      /* non-fatal; UI stays put */
    }
  };

  const pendingInvites = trip.invites ?? [];

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-gray-700 mb-3">
        Members <span className="text-gray-400 font-normal">({trip.members.length})</span>
      </h2>

      <ul className="flex flex-col gap-2 mb-3">
        {trip.members.map((m) => {
          const isMemberHost = m.userId === trip.hostId;
          const isMe         = m.userId === currentUserId;
          return (
            <li key={m.userId} className="flex items-center gap-2">
              <span className="text-sm text-gray-800 truncate flex-1">
                {m.user.username}{isMemberHost && <span className="ml-1 text-xs text-orange-500">👑 host</span>}{isMe && <span className="ml-1 text-xs text-gray-400">(you)</span>}
              </span>
              {/* Show "Remove" if host (and not the host removing themselves)
                  OR if the row is the current user removing themselves. */}
              {!trip.archivedAt && ((canHostAct && !isMemberHost) || (isMe && !isMemberHost)) && (
                <button
                  onClick={() => handleRemove(m.userId)}
                  className="text-xs font-medium text-red-500 hover:text-red-700"
                >
                  {isMe ? 'Leave' : 'Remove'}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {/* Pending invites — visible to host only (others have no use for
          this surface; the invitee sees their own invite in the navbar
          bell). Host can rescind anything still pending. */}
      {canHostAct && pendingInvites.length > 0 && (
        <div className="border-t border-gray-100 pt-2 mb-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
            Pending invites
          </p>
          <ul className="flex flex-col gap-1.5">
            {pendingInvites.map((inv) => (
              <li key={inv.id} className="flex items-center gap-2">
                <span className="text-sm text-gray-700 truncate flex-1">{inv.invited.username}</span>
                <button
                  onClick={() => handleRescind(inv.id)}
                  disabled={rescindingId === inv.id}
                  className="text-xs font-medium text-gray-500 hover:text-red-500 disabled:opacity-40"
                >
                  Rescind
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canHostAct && (
        <>
          <form onSubmit={handleInvite} className="flex gap-2 mb-2">
            <input
              type="text"
              value={username}
              onChange={(e) => { setUsername(e.target.value); setInviteError(''); }}
              placeholder="Invite by username"
              className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <button
              type="submit"
              disabled={!username.trim() || inviting}
              className="rounded-md bg-orange-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-orange-400 disabled:opacity-40"
            >
              {inviting ? 'Sending…' : 'Invite'}
            </button>
          </form>
          {inviteError && <p className="text-xs text-red-500 mb-2">{inviteError}</p>}

          <div className="border-t border-gray-100 pt-2">
            {!showImport ? (
              <button
                onClick={() => { setShowImport(true); loadGroups(); }}
                className="text-xs font-medium text-orange-600 hover:text-orange-800"
              >
                + Invite all members of a group
              </button>
            ) : (
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-1.5">Pick a group:</p>
                {!groupsLoaded ? (
                  <p className="text-xs text-gray-400 italic">Loading your groups…</p>
                ) : groups.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">You're not in any groups yet.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {groups.map((g) => (
                      <li key={g.id} className="flex items-center justify-between gap-2">
                        <span className="text-sm text-gray-700 truncate">{g.name}</span>
                        <button
                          onClick={() => handleImport(g.id)}
                          disabled={importingId === g.id}
                          className="text-xs font-medium text-orange-600 hover:text-orange-800 disabled:opacity-40"
                        >
                          {importingId === g.id ? 'Inviting…' : 'Invite all'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {importError && <p className="text-xs text-red-500 mt-1">{importError}</p>}
                <button
                  onClick={() => { setShowImport(false); setImportError(''); }}
                  className="text-xs font-medium text-gray-500 hover:text-gray-700 mt-2"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

// ── Anchors section ─────────────────────────────────────────

function AnchorsSection({ trip, canHostAct, onRefresh }) {
  const [showAdd,    setShowAdd]    = useState(false);
  const [newLabel,   setNewLabel]   = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [addError,   setAddError]   = useState('');
  const [saving,     setSaving]     = useState(false);
  // editing/promoting/deleting tracked by anchor id so each row's button
  // can render its own loading state without conflating with siblings.
  const [actioningId, setActioningId] = useState(null);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!newLabel.trim() || !newAddress.trim()) return;
    setAddError('');
    setSaving(true);
    try {
      await api.trips.addAnchor(trip.id, { label: newLabel.trim(), address: newAddress.trim() });
      setNewLabel(''); setNewAddress('');
      setShowAdd(false);
      onRefresh();
    } catch (err) {
      setAddError(err.message ?? 'Could not add anchor.');
    } finally {
      setSaving(false);
    }
  };

  const handleSetPrimary = async (anchor) => {
    if (anchor.isPrimary) return;
    setActioningId(anchor.id);
    try {
      await api.trips.updateAnchor(trip.id, anchor.id, { isPrimary: true });
      onRefresh();
    } catch { /* non-fatal */ }
    finally { setActioningId(null); }
  };

  const handleDelete = async (anchor) => {
    setActioningId(anchor.id);
    try {
      await api.trips.deleteAnchor(trip.id, anchor.id);
      onRefresh();
    } catch { /* non-fatal */ }
    finally { setActioningId(null); }
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-gray-700 mb-3">
        Anchors <span className="text-gray-400 font-normal">({trip.anchors.length})</span>
      </h2>
      <p className="text-xs text-gray-500 mb-3">
        Locations like your hotel or conference center — used as the default search center when adding restaurants to meal events.
      </p>

      {trip.anchors.length === 0 ? (
        <p className="text-xs text-gray-400 italic mb-3">No anchors yet.</p>
      ) : (
        <ul className="flex flex-col gap-2 mb-3">
          {trip.anchors.map((a) => (
            <li
              key={a.id}
              className={`rounded-lg border p-3 ${a.isPrimary ? 'border-orange-300 bg-orange-50/40' : 'border-gray-200'}`}
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-gray-900 truncate">{a.label}</p>
                    {a.isPrimary && (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-orange-200 text-orange-800">
                        Primary
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 truncate">{a.address}</p>
                </div>
                {canHostAct && (
                  <div className="flex items-center gap-1 shrink-0">
                    {!a.isPrimary && (
                      <button
                        onClick={() => handleSetPrimary(a)}
                        disabled={actioningId === a.id}
                        className="rounded px-2 py-1 text-xs font-medium text-orange-600 hover:bg-orange-100 disabled:opacity-40"
                      >
                        Set primary
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(a)}
                      disabled={actioningId === a.id}
                      className="rounded px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-50 disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {canHostAct && (
        trip.anchors.length < 10 ? (
          !showAdd ? (
            <button
              onClick={() => setShowAdd(true)}
              className="text-xs font-medium text-orange-600 hover:text-orange-800"
            >
              + Add an anchor
            </button>
          ) : (
            <form onSubmit={handleAdd} className="flex flex-col gap-2">
              <input
                type="text"
                value={newLabel}
                onChange={(e) => { setNewLabel(e.target.value); setAddError(''); }}
                placeholder="Label (e.g. Hotel)"
                maxLength={64}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              <input
                type="text"
                value={newAddress}
                onChange={(e) => { setNewAddress(e.target.value); setAddError(''); }}
                placeholder="Address"
                autoComplete="street-address"
                maxLength={256}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              {addError && <p className="text-xs text-red-500">{addError}</p>}
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={!newLabel.trim() || !newAddress.trim() || saving}
                  className="rounded-md bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-400 disabled:opacity-40"
                >
                  {saving ? 'Saving…' : 'Add anchor'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowAdd(false); setAddError(''); setNewLabel(''); setNewAddress(''); }}
                  className="text-xs font-medium text-gray-500 hover:text-gray-700"
                >
                  Cancel
                </button>
              </div>
            </form>
          )
        ) : (
          <p className="text-xs text-gray-400 italic">Anchor limit reached (10).</p>
        )
      )}
    </section>
  );
}

// ── Meal events section (Phase 2) ───────────────────────────
// The day-by-day calendar of trip meals with voting state. Reuses the
// existing GroupEvent table on the backend (events with tripId set) and
// the existing session/voting machinery, so this UI is mostly about:
// (1) grouping events by date, (2) presenting a per-meal add-restaurant
// flow, and (3) routing voting to /session/:sessionId (the same page
// groups use).

const MEAL_SLOTS = [
  { value: 'BREAKFAST', label: 'Breakfast', icon: '☕' },
  { value: 'LUNCH',     label: 'Lunch',     icon: '🥪' },
  { value: 'DINNER',    label: 'Dinner',    icon: '🍽️' },
  { value: 'SNACK',     label: 'Snack',     icon: '🍪' },
];
const SLOT_ORDER = Object.fromEntries(MEAL_SLOTS.map((s, i) => [s.value, i]));

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

function MealEventsSection({ trip, currentUserId, isHost, isArchived, onRefresh }) {
  const navigate = useNavigate();
  // User's personal favorites + selections are the source for the per-meal
  // restaurant picker. We don't run a separate Places search here — keep
  // the UI compact and reuse what the user has already curated.
  const customRestaurants = useSelector((s) => s.userInfo.customRestaurants ?? {});
  const userFavorites     = useSelector((s) => s.userInfo.users?.[0]?.favorites ?? []);
  const userSelections    = useSelector((s) => s.userInfo.users?.[0]?.options   ?? []);

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
      await api.trips.createEvent(trip.id, {
        name: newName.trim(),
        scheduledFor,
        mealSlot: newSlot || null,
        participantUserIds: [...newParticipants],
      });
      setShowCreate(false);
      setNewName(''); setNewDate(''); setNewTime(''); setNewSlot('');
      setNewParticipants(new Set());
      onRefresh();
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
      await api.trips.addEventOption(trip.id, eventId, Number(restaurantId));
      setOptionPickerForEvent(null);
      onRefresh();
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
      onRefresh();
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
      // Reuse the existing /session/:sessionId page. GroupSessionPage reads
      // session.tripId and routes the Back affordance accordingly.
      navigate(`/session/${sessionId}`);
    } catch (err) {
      setCreateError(err.message ?? 'Could not start voting.');
    } finally {
      setActioningEventId(null);
    }
  };

  const handleResumeVoting = (event) => {
    if (event.sessionId) navigate(`/session/${event.sessionId}`);
  };

  const handleAcceptResult = async (eventId) => {
    setActioningEventId(eventId);
    try {
      await api.trips.acceptResult(trip.id, eventId);
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
    setConfirmDelete(null);
    setActioningEventId(eventId);
    try {
      await api.trips.deleteEvent(trip.id, eventId);
      onRefresh();
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
      await api.trips.setSchedule(trip.id, eventId, iso);
      setSchedulePickerForEvent(null);
      setScheduleDraft('');
      onRefresh();
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
      onRefresh();
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
  const buildPickList = (event) => {
    const already = new Set(event.options.map((o) => String(o.restaurantId)));
    const ids = [...new Set([...userFavorites, ...userSelections].map(String))];
    return ids
      .map((id) => customRestaurants[id])
      .filter((r) => r && Number.isInteger(Number(r.id)) && !already.has(String(r.id)));
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
              const isOwn    = ev.createdById === currentUserId;
              const canEdit  = (isHost || isOwn) && !isArchived;
              const canVote  = isHost && !isArchived && ev.status === 'OPEN' && ev.options.length >= 2;
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
                    {canEdit && ev.status !== 'VOTING' && (
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

                      {!isArchived && (
                        optionPickerForEvent === ev.id ? (
                          <div className="flex flex-col gap-1 mb-2">
                            {pickable.length === 0 ? (
                              <p className="text-[11px] text-gray-400 italic">
                                Your favorites + selections are empty (or already added). Add some restaurants from the Search page first.
                              </p>
                            ) : (
                              <select
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
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setOptionPickerForEvent(ev.id)}
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
                    {ev.status === 'VOTING' && (
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
            onClick={() => setShowCreate(true)}
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
                className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              <input
                type="time"
                value={newTime}
                onChange={(e) => setNewTime(e.target.value)}
                className="w-28 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
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

// ── Page ────────────────────────────────────────────────────

export default function TripDetailPage() {
  const { id } = useParams();
  // useNavigate is consumed inside MembersSection (for "leave" → bounce
  // to /trips); the page itself doesn't need it directly.
  const currentUserId = useSelector((s) => s.auth.user?.id);

  const [trip,    setTrip]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [archiving, setArchiving] = useState(false);
  // null = no dialog; true = archive-confirm dialog open.
  const [confirmArchive, setConfirmArchive] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
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

  if (loading) return <p className="text-center text-sm text-gray-400 py-20">Loading trip…</p>;
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
    } catch (err) {
      setError(err.message ?? 'Could not archive trip.');
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
      <p className="text-xs text-gray-400 mb-5">{formatDateRange(trip.startDate, trip.endDate)}</p>

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
        />
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
