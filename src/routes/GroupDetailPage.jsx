import { useState, useEffect, useCallback, useRef } from 'react';
import ConfirmDialog from '../components/ConfirmDialog';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { addUserOption, addCustomRestaurant } from '../redux/slices/userInfoSlice';

// Stable sentinels for useSelector fallbacks. The naive
// `useSelector(s => x ?? [])` produces a NEW [] on every dispatch, which
// fails reference equality and re-renders the consumer (and its tree)
// even when nothing relevant changed. Freezing prevents accidental
// mutation that would compromise the shared reference.
const EMPTY_ARRAY = Object.freeze([]);
const EMPTY_OBJECT = Object.freeze({});
import { groupsApi } from '../lib/groupsApi';
import { socialApi } from '../lib/socialApi';
import { api } from '../lib/api';
import { normalizeUrl } from '../utils/normalizeUrl';
import BallotDetailModal from '../components/BallotDetailModal';
import PublicRestaurantInfoModal from '../components/PublicRestaurantInfoModal';

const STATUS_BADGE = {
  OPEN:   { label: 'Open',             cls: 'bg-green-100 text-green-700' },
  VOTING: { label: 'Voting in progress', cls: 'bg-orange-100 text-orange-700' },
  DONE:   { label: 'Done',             cls: 'bg-gray-100 text-gray-500' },
};

// ── Shared sub-components ─────────────────────────────────────

// ConfirmDialog moved to ../components/ConfirmDialog so TripDetailPage
// (and any future page) can share the same modal pattern.

function InvitePanel({ groupId, existingMemberIds, existingInviteIds, onInvited }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [inviting, setInviting] = useState(null);
  const [error, setError] = useState('');

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true); setError('');
    try { const data = await socialApi.search(query.trim()); setResults(data.users ?? []); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const handleInvite = async (userId) => {
    setInviting(userId);
    try { await groupsApi.invite(groupId, userId); onInvited(); }
    catch (err) { setError(err.message); }
    finally { setInviting(null); }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">Invite a user</h3>
      <form onSubmit={handleSearch} className="flex gap-2 mb-3">
        <input
          className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          placeholder="Search by username or email"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={loading}
          className="rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-orange-400 disabled:opacity-50 transition-colors">
          Search
        </button>
      </form>
      {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
      {results !== null && (
        results.length === 0 ? <p className="text-xs text-gray-500 italic">No users found.</p> : (
          <div className="flex flex-col gap-2">
            {results.map((u) => {
              const isMem = existingMemberIds.has(u.id);
              const isInv = existingInviteIds.has(u.id);
              return (
                <div key={u.id} className="flex items-center justify-between text-sm">
                  <span className="text-gray-800">{u.username}</span>
                  {isMem ? <span className="text-xs text-gray-400">Already a member</span>
                  : isInv ? <span className="text-xs text-gray-400">Invited</span>
                  : (
                    <button disabled={inviting === u.id} onClick={() => handleInvite(u.id)}
                      className="rounded-lg bg-orange-500 px-3 py-1 text-xs font-semibold text-white hover:bg-orange-400 disabled:opacity-50 transition-colors">
                      {inviting === u.id ? 'Inviting…' : 'Invite'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

// ── Host exit dialog ──────────────────────────────────────────
// Shown when the current host clicks "Disband group". Offers two paths:
//   1. Transfer ownership to another member (group keeps running)
//   2. Archive the group entirely (read-only history preserved)
// Auto-collapses to option 2 when there are no other members to hand off to.

function HostExitDialog({ group, onClose, onTransferred, onDisbanded }) {
  const members = group.members ?? [];
  const [selectedId, setSelectedId] = useState(members[0]?.userId ?? '');
  const [mode, setMode] = useState(members.length > 0 ? 'transfer' : 'disband');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    setLoading(true); setError('');
    try {
      if (mode === 'transfer') {
        await groupsApi.transferHost(group.id, Number(selectedId));
        onTransferred();
      } else {
        await groupsApi.disband(group.id);
        onDisbanded();
      }
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 flex flex-col gap-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Leave or disband group</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            You're the host of <span className="font-medium text-gray-700">{group.name}</span>.
            Pick what happens next.
          </p>
        </div>

        {/* Mode selector */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setMode('transfer')}
            disabled={members.length === 0}
            className={`rounded-lg border p-3 text-left transition-colors ${
              mode === 'transfer'
                ? 'border-orange-500 bg-orange-50 ring-1 ring-orange-300'
                : 'border-gray-200 hover:border-gray-300'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <p className="text-sm font-semibold text-gray-900">Transfer & leave</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {members.length === 0 ? 'No other members' : 'Group keeps running'}
            </p>
          </button>
          <button
            onClick={() => setMode('disband')}
            className={`rounded-lg border p-3 text-left transition-colors ${
              mode === 'disband'
                ? 'border-red-400 bg-red-50 ring-1 ring-red-300'
                : 'border-gray-200 hover:border-gray-300'
            }`}
          >
            <p className="text-sm font-semibold text-gray-900">Disband group</p>
            <p className="text-xs text-gray-500 mt-0.5">Archive for everyone</p>
          </button>
        </div>

        {/* Transfer target picker */}
        {mode === 'transfer' && members.length > 0 && (
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">New host</label>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 pl-3 pr-8 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            >
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>{m.user?.username}</option>
              ))}
            </select>
            <p className="text-xs text-gray-400 mt-1.5">
              You'll stay in the group as a regular member. {members[0]?.user?.username && `${members.find((m) => String(m.userId) === String(selectedId))?.user?.username ?? ''} will get full host privileges immediately.`}
            </p>
          </div>
        )}

        {mode === 'disband' && (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
            ⚠️ The group will be archived for everyone. Members lose active access; past events are preserved as read-only history.
          </p>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2 justify-end pt-2">
          <button
            onClick={onClose}
            disabled={loading}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || (mode === 'transfer' && !selectedId)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-brand-sm transition-all disabled:opacity-50 ${
              mode === 'disband'
                ? 'bg-red-500 hover:bg-red-400'
                : 'bg-gradient-to-br from-orange-500 to-red-500 hover:from-orange-400 hover:to-red-400'
            }`}
          >
            {loading ? '…' : mode === 'transfer' ? 'Transfer & leave' : 'Disband group'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Create event modal ────────────────────────────────────────

function CreateEventModal({ groupId, onClose, onCreate }) {
  const [name, setName]       = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  // Group favorites pulled in for the quick-add panel. Loaded once on mount.
  // Pre-selecting all of them is the "quick" affordance — common case is
  // "yes, all the usual spots are candidates again." User unchecks anything
  // they want to exclude this round.
  const [favorites, setFavorites]             = useState([]);
  const [favoritesLoading, setFavoritesLoading] = useState(true);
  const [selectedIds, setSelectedIds]         = useState(() => new Set());

  useEffect(() => {
    let cancelled = false;
    groupsApi.listFavorites(groupId)
      .then(({ favorites: list }) => {
        if (cancelled) return;
        setFavorites(list);
        setSelectedIds(new Set(list.map((f) => f.restaurantId)));
      })
      .catch(() => { /* favorites are optional — silent fail keeps the modal usable */ })
      .finally(() => { if (!cancelled) setFavoritesLoading(false); });
    return () => { cancelled = true; };
  }, [groupId]);

  const toggleFavorite = (restaurantId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(restaurantId)) next.delete(restaurantId);
      else next.add(restaurantId);
      return next;
    });
  };
  const selectAll  = () => setSelectedIds(new Set(favorites.map((f) => f.restaurantId)));
  const selectNone = () => setSelectedIds(new Set());

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true); setError('');
    try {
      // Single round-trip: server seeds the checked-favorite options in the
      // same transaction as the event create. Was previously
      // `createEvent` + N parallel `addOption` calls — N round-trips through
      // writeLimiter for every "Plan an event from my favorites" flow.
      const optionIds = selectedIds.size > 0
        ? [...selectedIds].map(Number).filter((n) => Number.isInteger(n) && n > 0)
        : undefined;
      const { event } = await groupsApi.createEvent(groupId, name.trim(), optionIds);

      onCreate(event);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const hasFavorites = favorites.length > 0;
  const selectedCount = selectedIds.size;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 max-h-[90vh] flex flex-col">
        <h2 className="text-lg font-bold text-gray-900 mb-4 shrink-0">New vote event</h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 min-h-0 flex-1">
          <input
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            placeholder="e.g. Friday Dinner, Movie Night…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />

          {/* Quick-add from group favorites — only rendered when the group has
              at least one favorite. The list is scrollable so a group with
              30 favorites doesn't blow up the modal. */}
          {favoritesLoading ? (
            <p className="text-xs text-gray-400">Loading group favorites…</p>
          ) : hasFavorites ? (
            <div className="border border-gray-200 rounded-lg overflow-hidden flex flex-col min-h-0">
              <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200 shrink-0">
                <p className="text-xs font-semibold text-gray-600">
                  Quick-add from group favorites
                  <span className="ml-1.5 text-gray-400">({selectedCount}/{favorites.length})</span>
                </p>
                <div className="flex gap-2 text-[11px]">
                  <button type="button" onClick={selectAll}  className="text-orange-600 hover:underline">All</button>
                  <span className="text-gray-300">·</span>
                  <button type="button" onClick={selectNone} className="text-gray-500  hover:underline">None</button>
                </div>
              </div>
              <ul className="overflow-y-auto max-h-48 divide-y divide-gray-100">
                {favorites.map((f) => (
                  <li key={f.restaurantId}>
                    <label className="flex items-center gap-2 px-3 py-2 hover:bg-orange-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(f.restaurantId)}
                        onChange={() => toggleFavorite(f.restaurantId)}
                        className="rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-800 truncate">
                          {f.restaurant?.name ?? `Restaurant #${f.restaurantId}`}
                        </p>
                        {f.restaurant?.cuisineType && (
                          <p className="text-xs text-gray-400 truncate">{f.restaurant.cuisineType}</p>
                        )}
                      </div>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2 mt-1 shrink-0">
            <button type="button" onClick={onClose}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={loading || !name.trim()}
              className="flex-1 rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-4 py-2 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 disabled:opacity-50 transition-all shadow-brand-sm">
              {loading
                ? 'Creating…'
                : selectedCount > 0
                  ? `Create + add ${selectedCount}`
                  : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Schedule picker ───────────────────────────────────────────

function SchedulePicker({ groupId, event, onUpdated }) {
  const [value, setValue] = useState(
    event.votingStartsAt ? new Date(event.votingStartsAt).toISOString().slice(0, 16) : ''
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const now = new Date().toISOString().slice(0, 16);

  const handleSave = async () => {
    setSaving(true); setError('');
    try { await groupsApi.setSchedule(groupId, event.id, value || null); onUpdated(); }
    catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };
  const handleClear = async () => {
    setValue(''); setSaving(true);
    try { await groupsApi.setSchedule(groupId, event.id, null); onUpdated(); }
    catch { /* ignore */ } finally { setSaving(false); }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h4 className="text-sm font-semibold text-gray-700 mb-1">Schedule voting</h4>
      <p className="text-xs text-gray-500 mb-3">Set a date &amp; time when options lock and voting begins automatically.</p>
      <div className="flex items-center gap-2 flex-wrap">
        <input type="datetime-local" min={now} value={value} onChange={(e) => setValue(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
        />
        <button onClick={handleSave} disabled={saving || !value}
          className="rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-orange-400 disabled:opacity-50 transition-colors">
          {saving ? 'Saving…' : 'Set'}
        </button>
        {event.votingStartsAt && (
          <button onClick={handleClear} disabled={saving}
            className="text-xs text-gray-500 hover:text-red-500 transition-colors">
            Clear
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
    </div>
  );
}

// ── Event date picker ─────────────────────────────────────────

// Host-only voting method picker. Locked once event status leaves OPEN — the
// server enforces this too. For non-hosts (or non-OPEN events) we display a
// read-only badge so everyone knows what kind of vote they're walking into.
function VoteMethodPicker({ groupId, event, isHost, onUpdated }) {
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');
  // Optimistic value: what the UI should show right NOW, regardless of
  // whether the network has caught up. Cleared once the prop comes back
  // matching it (parent refetched + state propagated), or reverted on
  // error. null means "no override, trust the prop".
  const [optimistic, setOptimistic] = useState(null);
  // Bumped on every click so racing responses from rapid back-and-forth
  // toggling only commit the LAST one. Without this, clicking SIMPLE →
  // RANKED → SIMPLE quickly could see the RANKED response land after the
  // second SIMPLE response and stick.
  const reqIdRef = useRef(0);

  const propValue   = event.voteMethod ?? 'SIMPLE';
  const displayValue = optimistic ?? propValue;

  // Clear optimistic once the parent's data flows back in matching it —
  // and also handle the "user is editing, server is lagging behind"
  // boundary: we DON'T clear if the prop still disagrees, because that
  // would snap the UI back to the stale value mid-flight.
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
      await groupsApi.setVoteMethod(groupId, event.id, next);
      if (reqIdRef.current === myReqId) onUpdated();
    } catch (err) {
      // Only the latest click owns the error/revert. Older racing
      // requests that fail should be ignored — the user already moved on.
      if (reqIdRef.current === myReqId) {
        setError(err.message);
        setOptimistic(null);
      }
    } finally {
      if (reqIdRef.current === myReqId) setSaving(false);
    }
  };

  const label  = displayValue === 'RANKED' ? 'Ranked-choice' : 'Simple Majority';
  const isOpen = event.status === 'OPEN';

  // Don't bother rendering for non-hosts on locked events — the badge appears
  // inline in the event header instead. We DO render for non-hosts on OPEN
  // events so they can see the host's choice ahead of time.
  if (!isHost && !isOpen) return null;

  return (
    // w-full forces the picker to fill its column even if an ancestor
    // ever accidentally becomes content-sized — defensive against
    // future layout drift. Without this, the description text's length
    // (RANKED is ~155 chars, SIMPLE ~66) could drive the box width.
    <div className="w-full rounded-xl border border-gray-200 bg-white p-4">
      <h4 className="text-sm font-semibold text-gray-700 mb-1">Voting method</h4>
      {/* Both descriptions live in the same grid cell (col-start-1,
          row-start-1). Only the active one is opaque; the other stays
          in the layout via opacity-0 so the cell always reserves the
          height/width of the LONGER copy. Toggling becomes a pure
          opacity flip — zero reflow, identical box size regardless of
          which method is selected. */}
      <div className="grid grid-cols-1 mb-3 text-xs text-gray-500 leading-snug">
        <p
          className={`col-start-1 row-start-1 transition-opacity ${
            displayValue === 'RANKED' ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          aria-hidden={displayValue !== 'RANKED'}
        >
          Each voter ranks every restaurant by preference. Lowest first-place vote is eliminated each round until one has a majority.
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
      {isHost && isOpen ? (
        <>
          {/* grid-cols-2 forces both buttons to identical width so the
              active highlight never jumps between two different widths
              when toggling. The old `flex` row sized each button to its
              own label, which made "Simple Majority" wider than
              "Ranked-choice" and produced the visible width shift. */}
          <div className="grid grid-cols-2 gap-2">
            {[
              { value: 'SIMPLE', label: 'Simple Majority' },
              { value: 'RANKED', label: 'Ranked-choice' },
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => handleChange(opt.value)}
                // Deliberately NOT disabled while saving — rapid
                // back-and-forth toggling should feel instant. The
                // request-id ref above guarantees only the latest
                // response commits, so race conditions are safe.
                className={[
                  'rounded-lg px-3 py-1.5 text-xs font-semibold border transition-colors',
                  displayValue === opt.value
                    ? 'bg-orange-500 border-orange-500 text-white'
                    : 'bg-white border-gray-300 text-gray-600 hover:border-orange-400',
                ].join(' ')}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {/* Saving indicator on its own row so it doesn't push button
              widths around when it appears. */}
          {saving && <p className="mt-2 text-xs text-gray-400">Saving…</p>}
        </>
      ) : (
        <p className="text-sm font-medium text-gray-800">{label}</p>
      )}
      {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
    </div>
  );
}

function EventDatePicker({ groupId, event, isHost, onUpdated }) {
  const [value, setValue] = useState(
    event.scheduledFor ? new Date(event.scheduledFor).toISOString().slice(0, 16) : ''
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    setSaving(true); setError('');
    try { await groupsApi.setEventDate(groupId, event.id, value || null); onUpdated(); }
    catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };
  const handleClear = async () => {
    setValue(''); setSaving(true);
    try { await groupsApi.setEventDate(groupId, event.id, null); onUpdated(); }
    catch { /* ignore */ } finally { setSaving(false); }
  };

  if (!isHost && !event.scheduledFor) return null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h4 className="text-sm font-semibold text-gray-700 mb-1">Event date</h4>
      <p className="text-xs text-gray-500 mb-3">When is the group going out?</p>
      {isHost ? (
        <div className="flex items-center gap-2 flex-wrap">
          <input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
          <button onClick={handleSave} disabled={saving || !value}
            className="rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-orange-400 disabled:opacity-50 transition-colors">
            {saving ? 'Saving…' : 'Set'}
          </button>
          {event.scheduledFor && (
            <button onClick={handleClear} disabled={saving}
              className="text-xs text-gray-500 hover:text-red-500 transition-colors">
              Clear
            </button>
          )}
        </div>
      ) : (
        <p className="text-sm font-medium text-gray-800">
          {new Date(event.scheduledFor).toLocaleString()}
        </p>
      )}
      {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
    </div>
  );
}

// ── Event result display ──────────────────────────────────────

function ResultDisplay({ result, scheduledFor }) {
  const dispatch = useDispatch();
  const userOptions    = useSelector((s) => s.userInfo.users[0]?.options ?? EMPTY_ARRAY);
  const customRestaurants = useSelector((s) => s.userInfo.customRestaurants ?? EMPTY_OBJECT);

  const [shared, setShared] = useState(false);
  const [localDate, setLocalDate] = useState(
    scheduledFor ? new Date(scheduledFor).toISOString().slice(0, 16) : ''
  );

  useEffect(() => {
    if (scheduledFor) setLocalDate(new Date(scheduledFor).toISOString().slice(0, 16));
  }, [scheduledFor]);

  const methodLabel = result.method === 'spin' ? '🎰 Roulette' : result.method === 'flip' ? '🪙 Coin Flip' : '🗳 Vote';
  const pool = Array.isArray(result.restaurantPool) ? result.restaurantPool : [];
  const scores = result.scores && typeof result.scores === 'object' ? result.scores : null;
  const maxVotes = scores ? Math.max(...Object.values(scores).map(Number), 1) : 1;

  const winner = pool.find((item) => item.name === result.winnerName);
  const winnerAddress = winner?.address ?? null;
  const winnerWebsite = winner?.website ?? null;

  const fmtIcs = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const buildGCalUrl = () => {
    const params = new URLSearchParams({ action: 'TEMPLATE', text: `Dinner at ${result.winnerName}` });
    if (localDate) {
      const start = new Date(localDate);
      const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
      params.set('dates', `${fmtIcs(start)}/${fmtIcs(end)}`);
    }
    if (winnerAddress) params.set('location', winnerAddress);
    const details = [winnerWebsite].filter(Boolean).join('\n');
    if (details) params.set('details', details);
    return `https://www.google.com/calendar/render?${params.toString()}`;
  };

  const handleShare = async () => {
    const lines = [
      `We're going to ${result.winnerName}!`,
      localDate ? `When: ${new Date(localDate).toLocaleString()}` : null,
      winnerAddress ? `Where: ${winnerAddress}` : null,
      winnerWebsite ?? null,
    ].filter(Boolean);
    const calUrl = buildGCalUrl();
    try {
      if (navigator.share) {
        await navigator.share({
          title: `Dinner at ${result.winnerName}`,
          text: lines.join('\n'),
          url: calUrl,
        });
      } else {
        await navigator.clipboard.writeText([...lines, calUrl].join('\n'));
        setShared(true);
        setTimeout(() => setShared(false), 2500);
      }
    } catch { /* user cancelled or not supported */ }
  };

  const isWinnerInOptions = winner ? userOptions.some((s) => String(s) === String(winner.id)) : false;

  const handleAddToOptions = () => {
    if (!winner) return;
    const id = String(winner.id);
    if (!customRestaurants[id]) {
      dispatch(addCustomRestaurant({
        id,
        data: {
          name: winner.name,
          type: winner.type ?? 'Restaurant',
          price: winner.price ?? 1,
          rating: null,
          hours: 'N/A',
          phone: 'N/A',
          website: winner.website ?? 'N/A',
          address: winner.address ?? null,
          yelp: 'N/A',
          takeout: false,
          delivery: false,
        },
      }));
    }
    dispatch(addUserOption(id));
  };

  // `noopener,noreferrer` strips window.opener so the newly opened tab can't
  // navigate this one (reverse tabnabbing). Match the pattern used in
  // ScheduleModal which has the same external-link concern.
  const handleGoogleCalendar = () => window.open(buildGCalUrl(), '_blank', 'noopener,noreferrer');

  const handleAppleCalendar = () => {
    if (!localDate) return;
    const start = new Date(localDate);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//PickYum//EN',
      'BEGIN:VEVENT',
      `DTSTART:${fmtIcs(start)}`,
      `DTEND:${fmtIcs(end)}`,
      `SUMMARY:Dinner at ${result.winnerName}`,
      winnerAddress ? `LOCATION:${winnerAddress}` : null,
      winnerWebsite ? `DESCRIPTION:${winnerWebsite}` : null,
      'END:VEVENT',
      'END:VCALENDAR',
    ].filter(Boolean).join('\r\n');
    const blob = new Blob([ics], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${result.winnerName.replace(/[^a-z0-9]/gi, '_')}.ics`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-xl border border-green-200 bg-green-50 p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="text-2xl">🏆</span>
        <div className="min-w-0">
          <p className="text-lg font-bold text-gray-900">{result.winnerName}</p>
          {winnerAddress && <p className="text-xs text-gray-500 mt-0.5">{winnerAddress}</p>}
          {winnerWebsite && normalizeUrl(winnerWebsite) && (
            <a href={normalizeUrl(winnerWebsite)}
              target="_blank" rel="noopener noreferrer"
              className="text-xs text-orange-600 hover:text-orange-500 transition-colors">
              {winnerWebsite}
            </a>
          )}
          <p className="text-xs text-gray-500 mt-0.5">
            {methodLabel} · {new Date(result.createdAt).toLocaleDateString()}
          </p>
          <p className="text-xs text-gray-500">
            {/* The host label is the historical username at result time. If
                the user has since renamed, the server stamps a currentUsername
                onto voterMeta[hostUsername] which we surface inline as
                "(now @new)" without rewriting history. */}
            Host: {result.hostUsername}
            {(() => {
              const meta = result.voterMeta && typeof result.voterMeta === 'object'
                ? result.voterMeta[result.hostUsername]
                : null;
              return meta?.currentUsername ? (
                <span className="text-gray-400"> (now <span className="font-mono">@{meta.currentUsername}</span>)</span>
              ) : null;
            })()}
            {' '}· {result.participants.length} participant{result.participants.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {result.participants.map((name) => {
          // Same rename logic as the host label — look up voterMeta entry for
          // this display name. If the user behind it has renamed since, append
          // their current username inline so the pill reads e.g.
          // "Matt 👑 → @matthew_h" at a glance.
          const meta = result.voterMeta && typeof result.voterMeta === 'object'
            ? result.voterMeta[name]
            : null;
          return (
            <span
              key={name}
              className="text-xs bg-white border border-gray-200 rounded-full px-2 py-0.5 text-gray-600"
              title={meta?.currentUsername ? `Now @${meta.currentUsername}` : ''}
            >
              {name}{name === result.hostUsername ? ' 👑' : ''}
              {meta?.currentUsername && (
                <span className="ml-1 text-gray-400">
                  → <span className="font-mono">@{meta.currentUsername}</span>
                </span>
              )}
            </span>
          );
        })}
      </div>

      {scores && pool.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Vote results</p>
          <ul className="space-y-1">
            {pool.slice().sort((a, b) => (Number(scores[b.id]) || 0) - (Number(scores[a.id]) || 0)).map((item) => {
              const votes = Number(scores[item.id]) || 0;
              const pct = maxVotes > 0 ? (votes / maxVotes) * 100 : 0;
              const isWinner = item.name === result.winnerName;
              return (
                <li key={item.id} className={`rounded-lg px-3 py-2 ${isWinner ? 'bg-green-100 border border-green-200' : 'bg-white border border-gray-100'}`}>
                  <div className="flex justify-between items-center mb-1">
                    <span className={`text-sm font-medium ${isWinner ? 'text-green-800' : 'text-gray-700'}`}>
                      {isWinner && '🏆 '}{item.name}
                    </span>
                    <span className="text-xs text-gray-500">{votes} vote{votes !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-1.5">
                    <div className={`h-1.5 rounded-full ${isWinner ? 'bg-green-500' : 'bg-gray-300'}`} style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!scores && pool.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Pool</p>
          <div className="flex flex-wrap gap-1.5">
            {pool.map((item) => (
              <span key={item.id} className={`text-xs rounded-full px-2.5 py-0.5 border ${item.name === result.winnerName ? 'bg-green-100 border-green-300 text-green-800 font-semibold' : 'bg-white border-gray-200 text-gray-600'}`}>
                {item.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Share + calendar actions */}
      <div className="flex flex-col gap-2 pt-1 border-t border-green-200">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600 shrink-0">When?</label>
          <input
            type="datetime-local"
            value={localDate}
            onChange={(e) => setLocalDate(e.target.value)}
            className="flex-1 min-w-0 border border-gray-300 rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-green-400 bg-white"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {winner && (
            <button
              onClick={handleAddToOptions}
              disabled={isWinnerInOptions}
              className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isWinnerInOptions ? '✓ In Options' : '+ Add to Options'}
            </button>
          )}
          <button onClick={handleShare}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors">
            {shared ? '✓ Copied!' : '📤 Share result'}
          </button>
          <button onClick={handleGoogleCalendar}
            className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 transition-colors">
            📅 Google Calendar
          </button>
          <button onClick={handleAppleCalendar} disabled={!localDate}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            📅 Apple Calendar
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Event card ────────────────────────────────────────────────

function EventCard({ event, group, isHost, authUserId, userOptions, allRestaurants, onRefresh, onConfirm }) {
  const [expanded, setExpanded] = useState(event.status !== 'DONE');
  const [startingVote, setStartingVote] = useState(false);
  const [voteError, setVoteError] = useState('');
  const [sessionLinkCopied, setSessionLinkCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // EventCard renders BallotDetailModal as a child so closing it doesn't
  // collapse the card. State is scoped per-event-card; only one modal can be
  // open across the page since each card has its own.
  const [ballotEventId, setBallotEventId] = useState(null);

  // Archived groups are read-only — past events still expand to show ballots
  // but mutating buttons (delete, start-voting, etc.) drop out.
  const isArchived = !!group?.archivedAt;
  const canHostAct = isHost && !isArchived;

  // Current membership set — used to detect "orphaned" options (whose
  // original adder has since left). Mirrors the server-side logic in
  // DELETE /events/:eventId/options/:restaurantId so the Remove button
  // surfaces when it'll actually succeed.
  const allMemberIds = new Set([
    group?.hostId,
    ...(group?.members ?? []).map((m) => m.userId),
  ].filter((id) => id != null));

  const [addQuery, setAddQuery] = useState('');
  const [addDbResults, setAddDbResults] = useState(null);
  const [addPlacesResults, setAddPlacesResults] = useState(null);
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState('');
  const [addingId, setAddingId] = useState(null);
  const [addingPlacesId, setAddingPlacesId] = useState(null);

  const isOpen   = event.status === 'OPEN';
  const badge    = STATUS_BADGE[event.status] ?? STATUS_BADGE.OPEN;
  const existingIds = new Set((event.options ?? []).map((s) => String(s.restaurantId)));
  const myOptionsNotInPool = userOptions.filter(
    (id) => allRestaurants[id] && !existingIds.has(String(id))
  );

  const handleStartVoting = async () => {
    setStartingVote(true); setVoteError('');
    try {
      const { sessionId } = await groupsApi.startVoting(group.id, event.id);
      // Same noopener guard as the calendar handler — the opened vote tab
      // hosts authenticated UI; we don't want it able to navigate this one.
      window.open(`/vote/${sessionId}`, '_blank', 'noopener,noreferrer');
      await onRefresh();
    } catch (err) {
      setVoteError(err.message);
    } finally {
      setStartingVote(false);
    }
  };

  const handleCancelVoting = () => {
    onConfirm({
      message: 'Cancel the active voting session? The event will return to Open so you can restart it later.',
      onConfirm: async () => {
        try { await groupsApi.cancelVoting(group.id, event.id); await onRefresh(); } catch { /* ignore */ }
      },
    });
  };

  const handleAcceptResult = () => {
    onConfirm({
      message: 'Archive this result and close the event?',
      onConfirm: async () => {
        try { await groupsApi.acceptResult(group.id, event.id); await onRefresh(); } catch { /* ignore */ }
      },
    });
  };

  const handleDeleteEvent = () => {
    onConfirm({
      message: `Delete "${event.name}"? This cannot be undone.`,
      onConfirm: async () => {
        setDeleting(true);
        try { await groupsApi.deleteEvent(group.id, event.id); await onRefresh(); } catch { /* ignore */ } finally { setDeleting(false); }
      },
    });
  };

  const handleRemoveOption = async (restaurantId) => {
    try { await groupsApi.removeOption(group.id, event.id, restaurantId); await onRefresh(); } catch { /* ignore */ }
  };

  const handleSearchAdd = async (e) => {
    e.preventDefault();
    if (!addQuery.trim()) return;
    setAddLoading(true); setAddError(''); setAddDbResults(null); setAddPlacesResults(null);
    try {
      const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
      const [dbRes, placesRes] = await Promise.allSettled([
        fetch(`${BASE}/api/restaurants?search=${encodeURIComponent(addQuery.trim())}`, { credentials: 'include' }).then((r) => r.json()),
        api.places.search(addQuery.trim()),
      ]);
      setAddDbResults(dbRes.status === 'fulfilled' ? (dbRes.value.restaurants ?? []) : []);
      setAddPlacesResults(placesRes.status === 'fulfilled' ? (placesRes.value.restaurants ?? []) : []);
    } catch (err) { setAddError(err.message); } finally { setAddLoading(false); }
  };

  const handleAddOption = async (restaurantId) => {
    setAddingId(restaurantId);
    try {
      await groupsApi.addOption(group.id, event.id, restaurantId);
      await onRefresh();
      setAddDbResults(null); setAddPlacesResults(null); setAddQuery('');
    } catch (err) { setAddError(err.message); } finally { setAddingId(null); }
  };

  const handleAddPlacesOption = async (place) => {
    setAddingPlacesId(place.googlePlaceId); setAddError('');
    try {
      const { restaurant } = await api.restaurants.create({
        name: place.name,
        googlePlaceId: place.googlePlaceId,
        cuisineType: place.cuisineType ?? undefined,
        priceLevel: place.priceLevel ?? undefined,
        googleRating: place.googleRating ?? undefined,
        address: place.address ?? undefined,
        website: place.website ?? undefined,
        takeout: place.takeout,
        delivery: place.delivery,
      });
      await groupsApi.addOption(group.id, event.id, restaurant.id);
      await onRefresh();
      setAddDbResults(null); setAddPlacesResults(null); setAddQuery('');
    } catch (err) { setAddError(err.message); } finally { setAddingPlacesId(null); }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      {/* Header — click to expand/collapse */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors text-left"
      >
        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-semibold text-gray-900 truncate">{event.name}</span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.label}</span>
            {event.status === 'OPEN' && (
              <span className="text-xs text-gray-400">
                {event.options?.length ?? 0} restaurant{(event.options?.length ?? 0) !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          {/* Attribution — present on any event created after any-member
              creation rolled out. Legacy events render this as null and the
              line collapses to nothing. */}
          {event.createdBy?.username && (
            <p className="text-xs text-gray-400 mt-0.5 text-left">
              Proposed by <span className="font-medium text-gray-500">{event.createdBy.username}</span>
            </p>
          )}
        </div>
        <svg className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 p-4 flex flex-col gap-5">

          {/* DONE — show archived result + button to inspect full ballot detail */}
          {event.status === 'DONE' && event.result && (
            <>
              <ResultDisplay result={event.result} scheduledFor={event.scheduledFor} />
              <button
                onClick={() => setBallotEventId(event.id)}
                className="self-start text-xs font-semibold text-orange-600 hover:text-orange-700 hover:underline"
              >
                View per-voter ballots →
              </button>
            </>
          )}
          {event.status === 'DONE' && !event.result && (
            <p className="text-sm text-gray-400 italic">No result recorded for this event.</p>
          )}

          {/* VOTING — show live session link + host controls */}
          {event.status === 'VOTING' && event.sessionId && (
            <div className="rounded-xl border border-orange-200 bg-orange-50 p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-orange-800">Voting is live!</p>
                  <p className="text-xs text-orange-600 mt-0.5">Share the link so anyone can join and vote — no account needed.</p>
                </div>
                <a href={`/vote/${event.sessionId}`} target="_blank" rel="noopener noreferrer"
                  className="shrink-0 rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-400 transition-colors">
                  Go to vote →
                </a>
              </div>
              <button
                onClick={async () => {
                  const url = `${window.location.origin}/vote/${event.sessionId}`;
                  try { await navigator.clipboard.writeText(url); } catch { /* ignore */ }
                  setSessionLinkCopied(true);
                  setTimeout(() => setSessionLinkCopied(false), 2500);
                }}
                className="w-full rounded-lg border border-orange-300 bg-white px-3 py-2 text-sm font-medium text-orange-600 hover:bg-orange-50 transition-colors"
              >
                {sessionLinkCopied ? '✓ Link copied!' : '📋 Copy guest invite link'}
              </button>
              {isHost && (
                <button onClick={handleCancelVoting}
                  className="w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors">
                  Cancel voting
                </button>
              )}
            </div>
          )}

          {/* OPEN — scheduled voting banner */}
          {isOpen && event.votingStartsAt && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              Voting scheduled for <strong>{new Date(event.votingStartsAt).toLocaleString()}</strong> — options lock then.
            </div>
          )}

          {/* OPEN — restaurant pool */}
          {isOpen && (
            <section>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Restaurant pool ({event.options?.length ?? 0})
              </h4>

              {/* Add panel */}
              <div className="rounded-xl border border-gray-200 bg-white p-4 mb-3">
                <p className="text-xs text-gray-500 mb-3">Add a restaurant to this event's pool</p>

                {/* Quick-add from user's own options */}
                {myOptionsNotInPool.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2">From your options</p>
                    <div className="rounded-lg border border-gray-200 divide-y divide-gray-100 overflow-hidden">
                      {myOptionsNotInPool.map((id) => {
                        const r = allRestaurants[id];
                        return (
                          <div key={id} className="flex items-center justify-between px-3 py-2.5 hover:bg-gray-50 transition-colors">
                            <div className="min-w-0">
                              <span className="text-sm font-medium text-gray-800">{r.name}</span>
                              {r.type && <span className="text-xs text-gray-400 ml-1.5">{r.type}</span>}
                            </div>
                            <button disabled={addingId === Number(id)} onClick={() => handleAddOption(Number(id))}
                              className="shrink-0 ml-3 rounded-lg bg-orange-500 px-3 py-1 text-xs font-semibold text-white hover:bg-orange-400 disabled:opacity-50 transition-colors">
                              {addingId === Number(id) ? '…' : '+ Add'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <p className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2">
                  {myOptionsNotInPool.length > 0 ? 'Or search by name' : 'Search by name'}
                </p>
                <form onSubmit={handleSearchAdd} className="flex gap-2 mb-2">
                  <input
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                    placeholder="Search restaurant name…"
                    value={addQuery}
                    onChange={(e) => setAddQuery(e.target.value)}
                  />
                  <button type="submit" disabled={addLoading}
                    className="rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-orange-400 disabled:opacity-50 transition-colors">
                    {addLoading ? 'Searching…' : 'Search'}
                  </button>
                </form>
                {addError && <p className="text-xs text-red-500 mb-2">{addError}</p>}

                {addDbResults !== null && addDbResults.length > 0 && (
                  <div className="rounded-lg border border-gray-200 divide-y divide-gray-100 overflow-hidden max-h-48 overflow-y-auto mb-3">
                    {addDbResults.map((r) => {
                      const already = existingIds.has(String(r.id));
                      return (
                        <div key={r.id} className="flex items-center justify-between px-3 py-2.5 hover:bg-gray-50 transition-colors">
                          <div className="min-w-0">
                            <span className="text-sm font-medium text-gray-800 truncate">{r.name}</span>
                            {r.cuisineType && <span className="text-xs text-gray-400 ml-1.5">{r.cuisineType}</span>}
                          </div>
                          {already ? <span className="text-xs text-gray-400 shrink-0 ml-3">Added</span>
                          : (
                            <button disabled={addingId === r.id} onClick={() => handleAddOption(r.id)}
                              className="shrink-0 ml-3 rounded-lg bg-orange-500 px-3 py-1 text-xs font-semibold text-white hover:bg-orange-400 disabled:opacity-50 transition-colors">
                              {addingId === r.id ? '…' : '+ Add'}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {addPlacesResults !== null && addPlacesResults.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">From Google Places</p>
                    <div className="rounded-lg border border-orange-100 divide-y divide-gray-100 overflow-hidden max-h-48 overflow-y-auto">
                      {addPlacesResults.map((place) => (
                        <div key={place.googlePlaceId} className="flex items-center justify-between px-3 py-2.5 hover:bg-orange-50 transition-colors">
                          <div className="min-w-0">
                            <span className="text-sm font-medium text-gray-800 truncate">{place.name}</span>
                            {place.cuisineType && <span className="text-xs text-gray-400 ml-1.5">{place.cuisineType}</span>}
                            {place.address && <p className="text-xs text-gray-400 truncate">{place.address}</p>}
                          </div>
                          <button disabled={!!addingPlacesId} onClick={() => handleAddPlacesOption(place)}
                            className="shrink-0 ml-3 rounded-lg bg-orange-500 px-3 py-1 text-xs font-semibold text-white hover:bg-orange-400 disabled:opacity-50 transition-colors">
                            {addingPlacesId === place.googlePlaceId ? '…' : '+ Add'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {addDbResults !== null && addPlacesResults !== null &&
                 addDbResults.length === 0 && addPlacesResults.length === 0 && (
                  <p className="text-xs text-gray-400 italic">No restaurants found.</p>
                )}
              </div>

              {/* Pool list */}
              {(event.options ?? []).length === 0 ? (
                <p className="text-sm text-gray-400 italic">No restaurants added yet.</p>
              ) : (
                <div className="rounded-xl border border-gray-200 bg-white overflow-hidden divide-y divide-gray-100">
                  {(event.options ?? []).map((s) => {
                    // Removable by the host, by the member who originally added
                    // it, or — if the adder has left the group — by any current
                    // member. The server enforces the same rule; the UI just
                    // mirrors it so members don't see buttons that 403.
                    const isOwnOption  = s.addedBy?.id === authUserId;
                    const adderLeftGroup  = s.addedBy?.id != null && !allMemberIds.has(s.addedBy.id);
                    const canRemove = isHost || isOwnOption || adderLeftGroup;
                    return (
                      <div key={s.id} className="flex items-center justify-between px-4 py-3 gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{s.restaurant?.name}</p>
                          <p className="text-xs text-gray-400">
                            Added by {s.addedBy?.username ?? 'a former member'}
                            {adderLeftGroup && ' (no longer in group)'}
                          </p>
                        </div>
                        {canRemove && (
                          <button onClick={() => handleRemoveOption(s.restaurantId)}
                            className="shrink-0 text-xs text-gray-400 hover:text-red-500 transition-colors">
                            Remove
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* OPEN — voting controls (host only; suppressed for archived groups) */}
          {canHostAct && isOpen && (
            <section className="flex flex-col gap-3">
              <VoteMethodPicker groupId={group.id} event={event} isHost={canHostAct} onUpdated={onRefresh} />
              <EventDatePicker groupId={group.id} event={event} isHost={isHost} onUpdated={onRefresh} />
              <SchedulePicker groupId={group.id} event={event} onUpdated={onRefresh} />
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <h4 className="text-sm font-semibold text-gray-700 mb-2">Start voting now</h4>
                <p className="text-xs text-gray-500 mb-3">Locks options immediately and opens a live voting session.</p>
                {voteError && <p className="text-xs text-red-500 mb-2">{voteError}</p>}
                <button
                  disabled={startingVote || (event.options?.length ?? 0) < 2}
                  onClick={() => onConfirm({
                    message: 'This will lock options and open a live voting session. Continue?',
                    onConfirm: () => handleStartVoting(),
                  })}
                  className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
                >
                  {startingVote ? 'Starting…' : 'Start voting now'}
                </button>
                {(event.options?.length ?? 0) < 2 && (
                  <p className="text-xs text-gray-400 mt-2">Add at least 2 restaurants to start.</p>
                )}
              </div>
            </section>
          )}

          {/* Delete event (host; any status except VOTING). Hidden on archived groups. */}
          {canHostAct && event.status !== 'VOTING' && (
            <button onClick={handleDeleteEvent} disabled={deleting}
              className="text-xs text-red-400 hover:text-red-600 transition-colors text-left disabled:opacity-50">
              Delete this event
            </button>
          )}

        </div>
      )}

      {ballotEventId === event.id && (
        <BallotDetailModal
          groupId={group.id}
          eventId={event.id}
          onClose={() => setBallotEventId(null)}
        />
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────

// ── Group favorites section ───────────────────────────────────
// Shared restaurant list for the group, separate from each member's personal
// favorites. Any member can add/remove. Loads on its own (one extra request)
// rather than expanding the group payload — keeps the existing list/detail
// endpoints small.

function GroupFavoritesSection({ groupId, isArchived, allRestaurants }) {
  const [favorites, setFavorites] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [adding, setAdding]       = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { favorites: list } = await groupsApi.listFavorites(groupId);
      setFavorites(list);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { load(); }, [load]);

  const handleRemove = async (restaurantId) => {
    try {
      await groupsApi.removeFavorite(groupId, restaurantId);
      await load();
    } catch { /* ignore */ }
  };

  // Suggestions come from the user's known restaurants (customRestaurants) —
  // restaurants the user has interacted with anywhere in the app. Filtered to
  // names that match the query and aren't already in group favorites.
  const [query, setQuery] = useState('');
  const trimmedQuery = query.trim();
  const favSet = new Set(favorites.map((f) => String(f.restaurantId)));
  const suggestions = trimmedQuery
    ? Object.entries(allRestaurants)
        .filter(([id, r]) =>
          r?.name?.toLowerCase().includes(trimmedQuery.toLowerCase()) &&
          !favSet.has(String(id))
        )
        .slice(0, 6)
    : [];

  const handleAdd = async (restaurantId) => {
    setAdding(true);
    try {
      await groupsApi.addFavorite(groupId, restaurantId);
      setQuery('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
          Group favorites {favorites.length > 0 && <span className="text-gray-400">({favorites.length})</span>}
        </h2>
      </div>

      {!isArchived && (
        <div className="relative mb-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Add a restaurant to group favorites…"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
          {suggestions.length > 0 && (
            <ul className="absolute z-20 mt-1 w-full bg-white rounded-lg shadow-lg ring-1 ring-black/5 max-h-60 overflow-y-auto">
              {suggestions.map(([id, r]) => (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => handleAdd(Number(id))}
                    disabled={adding}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-orange-50 hover:text-orange-700 flex justify-between items-center disabled:opacity-50"
                  >
                    <span>{r.name}</span>
                    {r.type && <span className="text-xs text-gray-400 ml-2 shrink-0">{r.type}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : favorites.length === 0 ? (
        <p className="text-sm text-gray-400 italic">
          No group favorites yet.{!isArchived && ' Type above to add restaurants this group ends up at.'}
        </p>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden divide-y divide-gray-100">
          {favorites.map((f) => (
            <div key={f.restaurantId} className="flex items-center justify-between px-4 py-2.5 gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{f.restaurant?.name}</p>
                <p className="text-xs text-gray-400 truncate">
                  {f.restaurant?.cuisineType ?? 'Restaurant'} · added by {f.addedBy?.username}
                </p>
              </div>
              {!isArchived && (
                <button
                  onClick={() => handleRemove(f.restaurantId)}
                  className="shrink-0 text-xs text-gray-400 hover:text-red-500 transition-colors"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Group insights panel ──────────────────────────────────────
// Aggregates over the group's completed events — most-considered, most-won,
// member appearances, decision-method breakdown. Lazy-loaded on first expand
// so groups that never look at it don't pay the API cost.

function GroupInsightsPanel({ groupId }) {
  const [open, setOpen]       = useState(false);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  // Restaurant detail modal — string id when open, null when closed. Uses
  // PublicRestaurantInfoModal (self-fetching, no Redux dep) so the panel stays
  // independent of whatever else the page has loaded.
  const [infoForId, setInfoForId] = useState(null);

  const handleToggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (data) return; // already loaded
    setLoading(true); setError('');
    try {
      setData(await groupsApi.getInsights(groupId));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const METHOD_LABELS = { vote: '🗳 Vote', flip: '🪙 Flip', spin: '🎰 Spin' };

  return (
    <section>
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between text-left rounded-xl border border-gray-200 bg-white px-4 py-3 hover:bg-gray-50 transition-colors"
      >
        <span className="text-sm font-semibold text-gray-700">📊 Group insights</span>
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
                No completed events yet. Come back after the group makes a few decisions.
              </p>
            ) : (
              <div className="flex flex-col gap-5">
                {/* Stat tiles */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <p className="text-2xl font-black text-orange-600">{data.totalEvents}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">decisions</p>
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

                {/* Top winners */}
                {data.topWinners?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Group favorites in practice</p>
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

                {/* Often considered, never chosen */}
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

                {/* Member appearances — keeps the "who's been around" view
                    minimal. Vote alignment moved to its own section below for
                    legibility. */}
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

                {/* Vote alignment — per-member rate of voting with the winner.
                    Simple votes: approved the winning restaurant. Ranked votes:
                    placed the winner as their #1 choice. Members who never
                    voted are silently filtered (picks === 0). */}
                {(() => {
                  const aligned = Object.entries(data.memberWinAccuracy ?? {})
                    .filter(([, v]) => v && v.picks > 0)
                    .sort(([, a], [, b]) => b.rate - a.rate);
                  if (aligned.length === 0) return null;
                  return (
                    <div>
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Vote alignment</p>
                      <p className="text-[11px] text-gray-400 mb-2">
                        How often each member's vote matched the group's winner.
                      </p>
                      <ul className="space-y-1.5">
                        {aligned.map(([name, v]) => {
                          const pct = Math.round(v.rate * 100);
                          // Highlight extremes: ≥80% reads as "always agrees with the group",
                          // ≤25% as "the contrarian". Middle band stays neutral gray.
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

                {/* Member cuisine fingerprint — what each member tends to
                    propose. Aggregated across all options ever added; members
                    with fewer than 3 proposals are excluded server-side. */}
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
        <PublicRestaurantInfoModal
          restaurantId={Number(infoForId)}
          onClose={() => setInfoForId(null)}
        />
      )}
    </section>
  );
}

const GroupDetailPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const authUserId        = useSelector((state) => state.auth.user?.id);
  const userOptions    = useSelector((state) => state.userInfo.users[0]?.options ?? EMPTY_ARRAY);
  const customRestaurants = useSelector((state) => state.userInfo.customRestaurants ?? EMPTY_OBJECT);

  const [group, setGroup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [showCreateEvent, setShowCreateEvent] = useState(false);
  // Host's exit dialog. If the group has members, offer to transfer
  // ownership to one of them so the group keeps running. Disband
  // (archive) is the fallback when there's nobody to hand off to — or
  // when the host explicitly wants to wind down the group.
  // NB: this MUST stay above the early returns below — moving it after
  // them violates the rules-of-hooks ("Rendered more hooks than during
  // the previous render") because the early returns fire on the first
  // render but not subsequent ones.
  const [showHostExit, setShowHostExit] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await groupsApi.get(Number(id));
      setGroup(data.group);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-center text-sm text-gray-400 py-20">Loading…</p>;
  if (error)   return <p className="text-center text-sm text-red-500 py-20">{error}</p>;
  if (!group)  return null;

  const isHost     = group.hostId === authUserId;
  const isArchived = !!group.archivedAt;
  // While archived, the page is read-only — no host actions, no event mutations.
  // We still surface every past event for ballot inspection (the user's whole reason for navigating here).
  const canHostAct = isHost && !isArchived;
  const allMemberIds = new Set([group.hostId, ...(group.members ?? []).map((m) => m.userId)]);
  const pendingInviteIds = new Set(
    (group.invites ?? []).filter((i) => i.status === 'PENDING').map((i) => i.invitedId)
  );

  const handleKick = (userId, username) => {
    setConfirm({
      message: `Remove ${username} from the group?`,
      onConfirm: async () => {
        setConfirm(null);
        try { await groupsApi.removeMember(group.id, userId); await load(); } catch { /* ignore */ }
      },
    });
  };

  const handleLeave = () => {
    setConfirm({
      message: 'Leave this group?',
      onConfirm: async () => {
        setConfirm(null);
        try { await groupsApi.removeMember(group.id, authUserId); navigate('/socials'); } catch { /* ignore */ }
      },
    });
  };

  // `showHostExit` state lives above the early returns — see the rule-of-
  // hooks note up there. This is just the trigger handler.
  const handleDisband = () => setShowHostExit(true);

  const activeEvents = (group.events ?? []).filter((e) => e.status !== 'DONE');
  const doneEvents   = (group.events ?? []).filter((e) => e.status === 'DONE');

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">

      <Link to="/socials" className="text-xs text-orange-500 hover:text-orange-400 transition-colors mb-4 inline-block">
        ← Back to socials
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{group.name}</h1>
          <p className="text-sm text-gray-500 mt-0.5">Hosted by {group.host?.username}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isArchived && (
            <span className="rounded-full px-3 py-1 text-xs font-semibold bg-gray-200 text-gray-600">
              Archived
            </span>
          )}
          {!isArchived && activeEvents.length > 0 && (
            <span className="rounded-full px-3 py-1 text-xs font-semibold bg-orange-100 text-orange-700">
              {activeEvents.length} active
            </span>
          )}
        </div>
      </div>

      {isArchived && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 mb-6">
          <p className="text-sm text-gray-700 font-medium">This group is archived</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Read-only — past votes are preserved for history. Click an event below to see ballots.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-6">

        {/* Members */}
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
            Members ({(group.members?.length ?? 0) + 1})
          </h2>
          <div className="rounded-xl border border-gray-200 bg-white overflow-hidden divide-y divide-gray-100">
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <span className="text-sm font-medium text-gray-900">{group.host?.username}</span>
                <span className="ml-2 text-xs text-gray-400">host</span>
              </div>
            </div>
            {(group.members ?? []).map((m) => (
              <div key={m.userId} className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-gray-800">{m.user?.username}</span>
                <div className="flex gap-2">
                  {isHost && (
                    <button onClick={() => handleKick(m.userId, m.user?.username)}
                      className="text-xs text-gray-400 hover:text-red-500 transition-colors">
                      Remove
                    </button>
                  )}
                  {m.userId === authUserId && !isHost && (
                    <button onClick={handleLeave}
                      className="text-xs text-gray-400 hover:text-red-500 transition-colors">
                      Leave
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Pending invites */}
        {isHost && (group.invites ?? []).some((i) => i.status === 'PENDING') && (
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Pending invites</h2>
            <div className="rounded-xl border border-gray-200 bg-white overflow-hidden divide-y divide-gray-100">
              {(group.invites ?? []).filter((i) => i.status === 'PENDING').map((i) => (
                <div key={i.id} className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-gray-800">{i.invited?.username}</span>
                  <span className="text-xs text-gray-400">Pending</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Invite panel */}
        {isHost && (
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Invite someone</h2>
            <InvitePanel
              groupId={group.id}
              existingMemberIds={allMemberIds}
              existingInviteIds={pendingInviteIds}
              onInvited={load}
            />
          </section>
        )}

        {/* Shared favorites — any member can curate the group's go-to list */}
        <GroupFavoritesSection
          groupId={group.id}
          isArchived={isArchived}
          allRestaurants={customRestaurants}
        />

        {/* Events */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
              Vote events ({(group.events ?? []).length})
            </h2>
            {/* Any group member can propose a vote — the host retains delete
                authority on individual events to clean up if anyone abuses it. */}
            {!isArchived && (
              <button onClick={() => setShowCreateEvent(true)}
                className="rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:from-orange-400 hover:to-red-400 transition-all shadow-brand-sm">
                + New event
              </button>
            )}
          </div>

          {(group.events ?? []).length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              <p className="text-2xl mb-1">🗓</p>
              <p className="text-sm font-medium text-gray-500">No events yet</p>
              {isHost && <p className="text-xs mt-1">Create one to start planning a vote.</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {/* Active events first */}
              {activeEvents.map((event) => (
                <EventCard
                  key={event.id}
                  event={event}
                  group={group}
                  isHost={isHost}
                  authUserId={authUserId}
                  userOptions={userOptions}
                  allRestaurants={customRestaurants}
                  onRefresh={load}
                  onConfirm={setConfirm}
                />
              ))}
              {/* Past events */}
              {doneEvents.length > 0 && (
                <>
                  {activeEvents.length > 0 && (
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-2">Past events</p>
                  )}
                  {doneEvents.map((event) => (
                    <EventCard
                      key={event.id}
                      event={event}
                      group={group}
                      isHost={isHost}
                      authUserId={authUserId}
                      userOptions={userOptions}
                      allRestaurants={customRestaurants}
                      onRefresh={load}
                      onConfirm={setConfirm}
                    />
                  ))}
                </>
              )}
            </div>
          )}
        </section>

        {/* Insights — collapsible. Only fetches the API on first expand. */}
        <GroupInsightsPanel groupId={group.id} />

        {/* Danger zone — archived groups have nothing left to act on. */}
        {!isArchived && (
          <section className="border-t border-gray-200 pt-6">
            {isHost ? (
              <button onClick={handleDisband} className="text-sm text-red-500 hover:text-red-700 transition-colors">
                Leave or disband group
              </button>
            ) : (
              <button onClick={handleLeave} className="text-sm text-red-500 hover:text-red-700 transition-colors">
                Leave group
              </button>
            )}
          </section>
        )}
      </div>

      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          onConfirm={() => { confirm.onConfirm(); setConfirm(null); }}
          onCancel={() => setConfirm(null)}
        />
      )}

      {showCreateEvent && (
        <CreateEventModal
          groupId={group.id}
          onClose={() => setShowCreateEvent(false)}
          onCreate={(event) => {
            setShowCreateEvent(false);
            // Optimistic insert so the event appears immediately even before
            // the refresh below resolves.
            setGroup((g) => ({ ...g, events: [event, ...(g.events ?? [])] }));
            // Refresh so any quick-added options come back attached to
            // the event — the optimistic insert above has empty options.
            load();
          }}
        />
      )}

      {showHostExit && (
        <HostExitDialog
          group={group}
          onClose={() => setShowHostExit(false)}
          onTransferred={() => { setShowHostExit(false); navigate('/socials'); }}
          onDisbanded={() => { setShowHostExit(false); navigate('/socials'); }}
        />
      )}
    </div>
  );
};

export default GroupDetailPage;
