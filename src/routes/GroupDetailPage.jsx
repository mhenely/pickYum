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
import RestaurantDetailModal from '../components/RestaurantDetailModal';
import ResultDisplay from '../components/group/ResultDisplay';
import GroupInsightsPanel from '../components/group/GroupInsightsPanel';
import GroupFavoritesSection from '../components/group/GroupFavoritesSection';
import EventDatePicker from '../components/group/EventDatePicker';
import VoteMethodPicker from '../components/group/VoteMethodPicker';
import SchedulePicker from '../components/group/SchedulePicker';
import CreateEventModal from '../components/group/CreateEventModal';
import HostExitDialog from '../components/group/HostExitDialog';
import InvitePanel from '../components/group/InvitePanel';
import DietaryTagChips from '../components/DietaryTagChips';

const STATUS_BADGE = {
  OPEN:   { label: 'Open',             cls: 'bg-green-100 text-green-700' },
  VOTING: { label: 'Voting in progress', cls: 'bg-orange-100 text-orange-700' },
  DONE:   { label: 'Done',             cls: 'bg-gray-100 text-gray-500' },
};
// ── Event card ────────────────────────────────────────────────

function EventCard({ event, group, isHost, authUserId, userOptions, allRestaurants, onRefresh, onConfirm, updateEvent, removeEvent }) {
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
      // Optimistic: server flipped status to VOTING and stored the
      // sessionId. The "Resume voting" button now wires up automatically
      // without paying a full refetch.
      updateEvent(event.id, (e) => ({ ...e, status: 'VOTING', sessionId }));
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
        try {
          await groupsApi.cancelVoting(group.id, event.id);
          // Optimistic: reset locally to OPEN (server clears sessionId too).
          updateEvent(event.id, (e) => ({ ...e, status: 'OPEN', sessionId: null }));
        } catch { /* ignore */ }
      },
    });
  };

  const handleAcceptResult = () => {
    onConfirm({
      message: 'Archive this result and close the event?',
      onConfirm: async () => {
        // Accept-result's response is `{ message }` — we don't have the
        // freshly-persisted GroupEventResult row to apply locally, so we
        // refetch. Rare action (once per voting event), so the refetch
        // cost is acceptable.
        try { await groupsApi.acceptResult(group.id, event.id); await onRefresh(); } catch { /* ignore */ }
      },
    });
  };

  const handleDeleteEvent = () => {
    onConfirm({
      message: `Delete "${event.name}"? This cannot be undone.`,
      onConfirm: async () => {
        setDeleting(true);
        try {
          await groupsApi.deleteEvent(group.id, event.id);
          removeEvent(event.id);
        } catch { /* ignore */ } finally { setDeleting(false); }
      },
    });
  };

  const handleRemoveOption = async (restaurantId) => {
    try {
      await groupsApi.removeOption(group.id, event.id, restaurantId);
      updateEvent(event.id, (e) => ({
        ...e,
        options: (e.options ?? []).filter((o) => String(o.restaurantId) !== String(restaurantId)),
      }));
    } catch { /* ignore */ }
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
      const { option } = await groupsApi.addOption(group.id, event.id, restaurantId);
      // Optimistic: append the server-returned option (dedup-safe — the
      // route uses upsert, so re-adding an existing option returns it).
      updateEvent(event.id, (e) => ({
        ...e,
        options: (e.options ?? []).some((o) => o.restaurantId === option.restaurantId)
          ? e.options
          : [...(e.options ?? []), option],
      }));
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
      const { option } = await groupsApi.addOption(group.id, event.id, restaurant.id);
      updateEvent(event.id, (e) => ({
        ...e,
        options: (e.options ?? []).some((o) => o.restaurantId === option.restaurantId)
          ? e.options
          : [...(e.options ?? []), option],
      }));
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
              {/* Pickers now pass the new value through onUpdated(value) so
                  we can apply it locally instead of refetching the entire
                  group. Falls back to onRefresh when onUpdated() is called
                  with no value (defensive). */}
              <VoteMethodPicker
                groupId={group.id}
                event={event}
                isHost={canHostAct}
                onUpdated={(v) => v != null ? updateEvent(event.id, (e) => ({ ...e, voteMethod: v })) : onRefresh()}
              />
              <EventDatePicker
                groupId={group.id}
                event={event}
                isHost={isHost}
                onUpdated={(v) => updateEvent(event.id, (e) => ({ ...e, scheduledFor: v ?? null }))}
              />
              <SchedulePicker
                groupId={group.id}
                event={event}
                onUpdated={(v) => updateEvent(event.id, (e) => ({ ...e, votingStartsAt: v ?? null }))}
              />
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

const GroupDetailPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const authUserId        = useSelector((state) => state.auth.user?.id);
  const userOptions    = useSelector((state) => state.userInfo.user?.options ?? EMPTY_ARRAY);
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

  // Optimistic-update helpers — apply a local change to a single event (or
  // remove it entirely) without refetching the whole group. Every per-event
  // mutation routes through these so clicks land instantly instead of
  // waiting on a full /api/groups/:id refetch (which re-pulls every event
  // with options + result + voterMeta + members).
  const updateEvent = useCallback((eventId, updater) => {
    setGroup((prev) => prev ? {
      ...prev,
      events: (prev.events ?? []).map((e) => (e.id === eventId ? updater(e) : e)),
    } : prev);
  }, []);

  const removeEvent = useCallback((eventId) => {
    setGroup((prev) => prev ? {
      ...prev,
      events: (prev.events ?? []).filter((e) => e.id !== eventId),
    } : prev);
  }, []);

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
              <div className="min-w-0 flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-gray-900">{group.host?.username}</span>
                <span className="text-xs text-gray-400">host</span>
                <DietaryTagChips tags={group.host?.dietaryTags} />
              </div>
            </div>
            {(group.members ?? []).map((m) => (
              <div key={m.userId} className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0 flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-gray-800">{m.user?.username}</span>
                  <DietaryTagChips tags={m.user?.dietaryTags} />
                </div>
                <div className="flex gap-2 shrink-0">
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
                  updateEvent={updateEvent}
                  removeEvent={removeEvent}
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
