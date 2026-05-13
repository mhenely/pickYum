import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { addUserSelection, addCustomRestaurant } from '../redux/slices/userInfoSlice';
import { groupsApi } from '../lib/groupsApi';
import { socialApi } from '../lib/socialApi';
import { api } from '../lib/api';

const STATUS_BADGE = {
  OPEN:   { label: 'Open',             cls: 'bg-green-100 text-green-700' },
  VOTING: { label: 'Voting in progress', cls: 'bg-orange-100 text-orange-700' },
  DONE:   { label: 'Done',             cls: 'bg-gray-100 text-gray-500' },
};

// ── Shared sub-components ─────────────────────────────────────

function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-xs p-6 flex flex-col gap-4">
        <p className="text-sm text-gray-700">{message}</p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
          <button onClick={onConfirm} className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 transition-colors">Confirm</button>
        </div>
      </div>
    </div>
  );
}

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

// ── Create event modal ────────────────────────────────────────

function CreateEventModal({ groupId, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true); setError('');
    try { const { event } = await groupsApi.createEvent(groupId, name.trim()); onCreate(event); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
        <h2 className="text-lg font-bold text-gray-900 mb-4">New vote event</h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            placeholder="e.g. Friday Dinner, Movie Night…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2 mt-1">
            <button type="button" onClick={onClose}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={loading || !name.trim()}
              className="flex-1 rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-4 py-2 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 disabled:opacity-50 transition-all shadow-brand-sm">
              {loading ? 'Creating…' : 'Create'}
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
      <p className="text-xs text-gray-500 mb-3">Set a date &amp; time when selections lock and voting begins automatically.</p>
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
  const userSelections    = useSelector((s) => s.userInfo.users[0]?.selections ?? []);
  const customRestaurants = useSelector((s) => s.userInfo.customRestaurants ?? {});

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

  const isWinnerInSelections = winner ? userSelections.some((s) => String(s) === String(winner.id)) : false;

  const handleAddToSelections = () => {
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
    dispatch(addUserSelection(id));
  };

  const handleGoogleCalendar = () => window.open(buildGCalUrl(), '_blank');

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
          {winnerWebsite && (
            <a href={/^https?:\/\//i.test(winnerWebsite) ? winnerWebsite : `https://${winnerWebsite}`}
              target="_blank" rel="noopener noreferrer"
              className="text-xs text-orange-600 hover:text-orange-500 transition-colors">
              {winnerWebsite}
            </a>
          )}
          <p className="text-xs text-gray-500 mt-0.5">
            {methodLabel} · {new Date(result.createdAt).toLocaleDateString()}
          </p>
          <p className="text-xs text-gray-500">
            Host: {result.hostUsername} · {result.participants.length} participant{result.participants.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {result.participants.map((name) => (
          <span key={name} className="text-xs bg-white border border-gray-200 rounded-full px-2 py-0.5 text-gray-600">
            {name}{name === result.hostUsername ? ' 👑' : ''}
          </span>
        ))}
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
              onClick={handleAddToSelections}
              disabled={isWinnerInSelections}
              className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isWinnerInSelections ? '✓ In Selections' : '+ Add to Selections'}
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

function EventCard({ event, group, isHost, authUserId, userSelections, allRestaurants, onRefresh, onConfirm }) {
  const [expanded, setExpanded] = useState(event.status !== 'DONE');
  const [startingVote, setStartingVote] = useState(false);
  const [voteError, setVoteError] = useState('');
  const [sessionLinkCopied, setSessionLinkCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [addQuery, setAddQuery] = useState('');
  const [addDbResults, setAddDbResults] = useState(null);
  const [addPlacesResults, setAddPlacesResults] = useState(null);
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState('');
  const [addingId, setAddingId] = useState(null);
  const [addingPlacesId, setAddingPlacesId] = useState(null);

  const isOpen   = event.status === 'OPEN';
  const badge    = STATUS_BADGE[event.status] ?? STATUS_BADGE.OPEN;
  const existingIds = new Set((event.selections ?? []).map((s) => String(s.restaurantId)));
  const mySelectionsNotInPool = userSelections.filter(
    (id) => allRestaurants[id] && !existingIds.has(String(id))
  );

  const handleStartVoting = async () => {
    setStartingVote(true); setVoteError('');
    try {
      const { sessionId } = await groupsApi.startVoting(group.id, event.id);
      window.open(`/vote/${sessionId}`, '_blank');
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

  const handleRemoveSelection = async (restaurantId) => {
    try { await groupsApi.removeSelection(group.id, event.id, restaurantId); await onRefresh(); } catch { /* ignore */ }
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

  const handleAddSelection = async (restaurantId) => {
    setAddingId(restaurantId);
    try {
      await groupsApi.addSelection(group.id, event.id, restaurantId);
      await onRefresh();
      setAddDbResults(null); setAddPlacesResults(null); setAddQuery('');
    } catch (err) { setAddError(err.message); } finally { setAddingId(null); }
  };

  const handleAddPlacesSelection = async (place) => {
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
      await groupsApi.addSelection(group.id, event.id, restaurant.id);
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
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-gray-900 truncate">{event.name}</span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.label}</span>
          {event.status === 'OPEN' && (
            <span className="text-xs text-gray-400">
              {event.selections?.length ?? 0} restaurant{(event.selections?.length ?? 0) !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <svg className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 p-4 flex flex-col gap-5">

          {/* DONE — show archived result */}
          {event.status === 'DONE' && event.result && <ResultDisplay result={event.result} scheduledFor={event.scheduledFor} />}
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
              Voting scheduled for <strong>{new Date(event.votingStartsAt).toLocaleString()}</strong> — selections lock then.
            </div>
          )}

          {/* OPEN — restaurant pool */}
          {isOpen && (
            <section>
              <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Restaurant pool ({event.selections?.length ?? 0})
              </h4>

              {/* Add panel */}
              <div className="rounded-xl border border-gray-200 bg-white p-4 mb-3">
                <p className="text-xs text-gray-500 mb-3">Add a restaurant to this event's pool</p>

                {/* Quick-add from user's own selections */}
                {mySelectionsNotInPool.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2">From your selections</p>
                    <div className="rounded-lg border border-gray-200 divide-y divide-gray-100 overflow-hidden">
                      {mySelectionsNotInPool.map((id) => {
                        const r = allRestaurants[id];
                        return (
                          <div key={id} className="flex items-center justify-between px-3 py-2.5 hover:bg-gray-50 transition-colors">
                            <div className="min-w-0">
                              <span className="text-sm font-medium text-gray-800">{r.name}</span>
                              {r.type && <span className="text-xs text-gray-400 ml-1.5">{r.type}</span>}
                            </div>
                            <button disabled={addingId === Number(id)} onClick={() => handleAddSelection(Number(id))}
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
                  {mySelectionsNotInPool.length > 0 ? 'Or search by name' : 'Search by name'}
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
                            <button disabled={addingId === r.id} onClick={() => handleAddSelection(r.id)}
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
                          <button disabled={!!addingPlacesId} onClick={() => handleAddPlacesSelection(place)}
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
              {(event.selections ?? []).length === 0 ? (
                <p className="text-sm text-gray-400 italic">No restaurants added yet.</p>
              ) : (
                <div className="rounded-xl border border-gray-200 bg-white overflow-hidden divide-y divide-gray-100">
                  {(event.selections ?? []).map((s) => (
                    <div key={s.id} className="flex items-center justify-between px-4 py-3 gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{s.restaurant?.name}</p>
                        <p className="text-xs text-gray-400">Added by {s.addedBy?.username}</p>
                      </div>
                      {isHost && (
                        <button onClick={() => handleRemoveSelection(s.restaurantId)}
                          className="shrink-0 text-xs text-gray-400 hover:text-red-500 transition-colors">
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* OPEN — voting controls (host only) */}
          {isHost && isOpen && (
            <section className="flex flex-col gap-3">
              <EventDatePicker groupId={group.id} event={event} isHost={isHost} onUpdated={onRefresh} />
              <SchedulePicker groupId={group.id} event={event} onUpdated={onRefresh} />
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <h4 className="text-sm font-semibold text-gray-700 mb-2">Start voting now</h4>
                <p className="text-xs text-gray-500 mb-3">Locks selections immediately and opens a live voting session.</p>
                {voteError && <p className="text-xs text-red-500 mb-2">{voteError}</p>}
                <button
                  disabled={startingVote || (event.selections?.length ?? 0) < 2}
                  onClick={() => onConfirm({
                    message: 'This will lock selections and open a live voting session. Continue?',
                    onConfirm: () => handleStartVoting(),
                  })}
                  className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
                >
                  {startingVote ? 'Starting…' : 'Start voting now'}
                </button>
                {(event.selections?.length ?? 0) < 2 && (
                  <p className="text-xs text-gray-400 mt-2">Add at least 2 restaurants to start.</p>
                )}
              </div>
            </section>
          )}

          {/* Delete event (host; any status except VOTING) */}
          {isHost && event.status !== 'VOTING' && (
            <button onClick={handleDeleteEvent} disabled={deleting}
              className="text-xs text-red-400 hover:text-red-600 transition-colors text-left disabled:opacity-50">
              Delete this event
            </button>
          )}

        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────

const GroupDetailPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const authUserId        = useSelector((state) => state.auth.user?.id);
  const userSelections    = useSelector((state) => state.userInfo.users[0]?.selections ?? []);
  const customRestaurants = useSelector((state) => state.userInfo.customRestaurants ?? {});

  const [group, setGroup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [showCreateEvent, setShowCreateEvent] = useState(false);

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

  const isHost = group.hostId === authUserId;
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

  const handleDisband = () => {
    setConfirm({
      message: 'Disband this group? All events and results will be deleted. This cannot be undone.',
      onConfirm: async () => {
        setConfirm(null);
        try { await groupsApi.disband(group.id); navigate('/socials'); } catch { /* ignore */ }
      },
    });
  };

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
          {activeEvents.length > 0 && (
            <span className="rounded-full px-3 py-1 text-xs font-semibold bg-orange-100 text-orange-700">
              {activeEvents.length} active
            </span>
          )}
        </div>
      </div>

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

        {/* Events */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
              Vote events ({(group.events ?? []).length})
            </h2>
            {isHost && (
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
                  userSelections={userSelections}
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
                      userSelections={userSelections}
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

        {/* Danger zone */}
        <section className="border-t border-gray-200 pt-6">
          {isHost ? (
            <button onClick={handleDisband} className="text-sm text-red-500 hover:text-red-700 transition-colors">
              Disband group
            </button>
          ) : (
            <button onClick={handleLeave} className="text-sm text-red-500 hover:text-red-700 transition-colors">
              Leave group
            </button>
          )}
        </section>
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
            setGroup((g) => ({ ...g, events: [event, ...(g.events ?? [])] }));
          }}
        />
      )}
    </div>
  );
};

export default GroupDetailPage;
