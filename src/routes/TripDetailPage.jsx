import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { pushToast } from '../redux/slices/toastSlice';
import { api } from '../lib/api';
import { groupsApi } from '../lib/groupsApi';
import ConfirmDialog from '../components/ConfirmDialog';
import RestaurantDetailModal from '../components/RestaurantDetailModal';
import DietaryTagChips from '../components/DietaryTagChips';

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

// ── Members section ─────────────────────────────────────────

function MembersSection({ trip, canHostAct, currentUserId, onRefresh }) {
  const navigate = useNavigate();
  const dispatch = useDispatch();
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
  const [generatingLink, setGeneratingLink] = useState(false);

  const handleCopyInviteLink = async () => {
    setGeneratingLink(true);
    try {
      const { token } = await api.trips.createInviteLink(trip.id);
      const url = `${window.location.origin}/trips/join/${token}`;
      // Some browsers gate clipboard.writeText behind a "secure context"
      // (HTTPS or localhost). Fall through to selectable text in the toast
      // when the API isn't available so the user can still copy manually.
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch { /* fall through */ }
      dispatch(pushToast({
        id: `trip-invite-${Date.now()}`,
        status: copied ? 'success' : 'info',
        label: copied
          ? 'Invite link copied — share it with anyone you want to add.'
          : `Invite link: ${url}`,
      }));
    } catch (err) {
      dispatch(pushToast({
        id: `trip-invite-err-${Date.now()}`,
        status: 'error',
        label: err.message ?? 'Could not generate invite link.',
      }));
    } finally {
      setGeneratingLink(false);
    }
  };

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
            <li key={m.userId} className="flex items-start gap-2 flex-wrap">
              <span className="text-sm text-gray-800 truncate min-w-0 flex-1">
                {m.user.username}{isMemberHost && <span className="ml-1 text-xs text-orange-500">👑 host</span>}{isMe && <span className="ml-1 text-xs text-gray-400">(you)</span>}
                <span className="ml-2"><DietaryTagChips tags={m.user.dietaryTags} /></span>
              </span>
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

          {/* Shareable link — alternative to username-by-username invite.
              Generates a signed token; anyone with the resulting URL
              who's signed in is auto-added as a member when they open it.
              30-day expiry on the server side; rotate JWT_SECRET to
              invalidate every outstanding link. */}
          <button
            onClick={handleCopyInviteLink}
            disabled={generatingLink}
            className="text-xs font-medium text-orange-600 hover:text-orange-800 disabled:opacity-40 mb-2"
          >
            {generatingLink ? 'Generating…' : '🔗 Copy invite link'}
          </button>

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
    <section id="trip-anchors" className="rounded-xl border border-gray-200 bg-white p-4 scroll-mt-4">
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

function MealEventsSection({ trip, currentUserId, isHost, isArchived, onRefresh, setTrip }) {
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
      setOptionPickerForEvent(null);
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
      setOptionPickerForEvent(null);
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

// ── Trip insights panel ──────────────────────────────────────
// Lazy-loaded rollup over the trip's completed meal events. Mirrors the
// group insights panel (see GroupDetailPage.jsx) with one trip-specific
// extra: a meal-slot breakdown (breakfast / lunch / dinner / snack counts).
function TripInsightsPanel({ tripId }) {
  const [open, setOpen]       = useState(false);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [infoForId, setInfoForId] = useState(null);

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
  const SLOT_LABELS   = { BREAKFAST: '🥐 Breakfast', LUNCH: '🥗 Lunch', DINNER: '🍽 Dinner', SNACK: '🍪 Snack' };

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
          {loading && <p className="text-sm text-gray-400">Loading insights…</p>}
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
