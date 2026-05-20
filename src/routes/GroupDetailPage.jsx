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
import EventCard from '../components/group/EventCard';
import DietaryTagChips from '../components/DietaryTagChips';

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
