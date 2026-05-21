import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { socialApi } from '../lib/socialApi';
import { groupsApi } from '../lib/groupsApi';
import { pushToast } from '../redux/slices/toastSlice';
import RestaurantDetailModal from '../components/RestaurantDetailModal';
import SectionEmpty from '../components/SectionEmpty';
import { SkeletonSection, SkeletonList } from '../components/Skeleton';
import Button from '../components/ui/Button';
import { TripsTab } from './TripsPage';

// Toast helper: each mutation pushes a one-shot success/error so silent
// catches don't leave the user wondering "did that work?" Centralized
// here so the SocialsPage tabs all use a single id-naming convention.
function toastOk(dispatch, label) {
  dispatch(pushToast({
    id: `social-ok-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    status: 'success',
    label,
  }));
}
function toastErr(dispatch, label, err) {
  dispatch(pushToast({
    id: `social-err-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    status: 'error',
    label,
    detail: err?.message,
  }));
}

// ── Shared helpers ────────────────────────────────────────────

const StatCard = ({ label, value, sub }) => (
  <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm text-center">
    <p className="text-2xl font-bold text-orange-600">{value}</p>
    <p className="text-xs font-medium text-gray-600 mt-0.5">{label}</p>
    {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
  </div>
);

// SectionEmpty was inlined here originally; it moved to a shared component
// when other pages started reaching for the same empty-state shape (History,
// Trips, Groups). The import at the top now satisfies callers below.

// ── Groups tab ────────────────────────────────────────────────

function CreateGroupModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError('');
    try {
      const { group } = await groupsApi.create(name.trim());
      onCreate(group);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open onClose={loading ? () => {} : onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/50" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center px-4">
        <DialogPanel className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
        <DialogTitle className="text-lg font-bold text-gray-900 mb-4">Create a group</DialogTitle>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            placeholder="Group name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2 mt-1">
            <Button variant="secondary" fullWidth onClick={onClose}>Cancel</Button>
            <Button type="submit" fullWidth disabled={loading || !name.trim()}>
              {loading ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </form>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

function GroupCard({ group }) {
  const navigate = useNavigate();
  const events       = group.events ?? [];
  const votingEvent  = events.find((e) => e.status === 'VOTING');
  const activeCount  = events.filter((e) => e.status === 'OPEN' || e.status === 'VOTING').length;
  // List endpoint returns _count.members (members excluding host). +1 for the host.
  const memberCount  = (group._count?.members ?? 0) + 1;

  // Outer is a div role=button (not a Link) because the voting badge below
  // is itself a Link to /vote/:sessionId — nested anchors are invalid HTML.
  // The card body still navigates to the group detail via the keyboard /
  // click handlers here.
  const openGroup = () => navigate(`/groups/${group.id}`);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={openGroup}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGroup(); } }}
      className="block rounded-xl border border-gray-200 bg-white p-4 shadow-sm hover:shadow-md hover:border-orange-200 focus:outline-none focus:ring-2 focus:ring-orange-300 transition-all cursor-pointer"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 truncate">{group.name}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {group.role === 'host' ? 'You are the host' : `Hosted by ${group.host?.username ?? '—'}`}
          </p>
        </div>
        {votingEvent && votingEvent.sessionId && (
          <Link
            to={`/vote/${votingEvent.sessionId}`}
            // stopPropagation so the outer card-click doesn't also fire and
            // bounce the user through the group detail page first.
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-700 hover:bg-orange-200 transition-colors"
            title="Open the active vote"
          >
            Voting active →
          </Link>
        )}
      </div>
      <div className="mt-3 flex items-center gap-4 text-xs text-gray-500">
        <span>{memberCount} member{memberCount !== 1 ? 's' : ''}</span>
        <span>{events.length} event{events.length !== 1 ? 's' : ''}</span>
        {activeCount > 0 && (
          <span className="text-orange-600 font-medium">{activeCount} active</span>
        )}
      </div>
    </div>
  );
}

function GroupsTab() {
  const dispatch = useDispatch();
  const [groups, setGroups] = useState([]);
  const [pendingInvites, setPendingInvites] = useState([]);
  const [archivedGroups, setArchivedGroups] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [respondingId, setRespondingId] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await groupsApi.list();
      setGroups(data.groups ?? []);
      setPendingInvites(data.pendingInvites ?? []);
      setArchivedGroups(data.archivedGroups ?? []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRespond = async (invite, action) => {
    setRespondingId(invite.id);
    try {
      await groupsApi.respondInvite(invite.group.id, invite.id, action);
      await load();
      toastOk(dispatch, action === 'accept' ? `Joined ${invite.group.name}` : `Declined invite to ${invite.group.name}`);
    } catch (err) {
      toastErr(dispatch, action === 'accept' ? 'Could not accept invite' : 'Could not decline invite', err);
    } finally {
      setRespondingId(null);
    }
  };

  const handleCreated = (group) => {
    setShowCreate(false);
    setGroups((prev) => [{ ...group, role: 'host' }, ...prev]);
    toastOk(dispatch, `Group "${group.name}" created`);
  };

  const hostedGroups = groups.filter((g) => g.role === 'host');
  const memberGroups = groups.filter((g) => g.role === 'member');

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <SkeletonSection count={2} />
        <SkeletonSection count={2} />
      </div>
    );
  }
  if (error)   return <p className="text-center text-sm text-red-500 py-12">{error}</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <p className="text-sm text-gray-500">Manage dinner groups and vote with friends.</p>
        <Button onClick={() => setShowCreate(true)}>+ New group</Button>
      </div>

      <div className="flex flex-col gap-8">
        {pendingInvites.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Pending invites
              <span className="ml-2 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">{pendingInvites.length}</span>
            </h3>
            <div className="flex flex-col gap-3">
              {pendingInvites.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 truncate">{inv.group.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">Invited by {inv.invitedBy.username}</p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button disabled={respondingId === inv.id} onClick={() => handleRespond(inv, 'accept')} className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-400 disabled:opacity-50 transition-colors">Accept</button>
                    <button disabled={respondingId === inv.id} onClick={() => handleRespond(inv, 'decline')} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors">Decline</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {hostedGroups.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Groups you host</h3>
            <div className="flex flex-col gap-3">
              {hostedGroups.map((g) => <GroupCard key={g.id} group={g} />)}
            </div>
          </section>
        )}

        {memberGroups.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Groups you've joined</h3>
            <div className="flex flex-col gap-3">
              {memberGroups.map((g) => <GroupCard key={g.id} group={g} />)}
            </div>
          </section>
        )}

        {groups.length === 0 && pendingInvites.length === 0 && (
          <SectionEmpty icon="👥" title="No groups yet" subtitle="Create one and invite friends to vote together." />
        )}

        {archivedGroups.length > 0 && (
          <section>
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3 hover:text-gray-500 transition-colors"
            >
              {showArchived ? '▾' : '▸'} Archived groups ({archivedGroups.length})
            </button>
            {showArchived && (
              <div className="flex flex-col gap-3">
                {archivedGroups.map((g) => {
                  const doneEvents = (g.events ?? []).filter((e) => e.status === 'DONE');
                  return (
                    // Wraps in a Link so the entire card navigates to the group
                    // detail page (which shows full event history + ballot detail).
                    <Link
                      key={g.id}
                      to={`/groups/${g.id}`}
                      className="block rounded-xl border border-gray-200 bg-gray-50 p-4 opacity-80 hover:opacity-100 hover:border-orange-200 hover:bg-white transition-all"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-gray-600 truncate">{g.name}</p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            Archived · {doneEvents.length} past vote{doneEvents.length !== 1 ? 's' : ''} · tap to view
                          </p>
                        </div>
                      </div>
                      {doneEvents.slice(0, 3).map((e) => (
                        <div key={e.id} className="mt-2 rounded-lg bg-white border border-gray-100 px-3 py-2">
                          <p className="text-xs font-medium text-gray-700">{e.name}</p>
                          {e.result && (
                            <p className="text-xs text-gray-500 mt-0.5">
                              Winner: <span className="font-semibold text-green-700">{e.result.winnerName}</span>
                              {e.scheduledFor && ` · ${new Date(e.scheduledFor).toLocaleDateString()}`}
                            </p>
                          )}
                        </div>
                      ))}
                      {doneEvents.length > 3 && (
                        <p className="text-xs text-gray-400 mt-2 italic">+ {doneEvents.length - 3} more inside</p>
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>

      {showCreate && <CreateGroupModal onClose={() => setShowCreate(false)} onCreate={handleCreated} />}
    </div>
  );
}

// ── People tab ────────────────────────────────────────────────
// Friends + Following + Followers unified. The split into separate Friends
// / Followers tabs was always a leak of the underlying data model — users
// think of it as "people I'm connected to," not "people with relationship
// type X." Per-row buttons handle the relationship-specific actions.

function PeopleTab() {
  const dispatch = useDispatch();
  const [friends, setFriends]         = useState([]);
  const [following, setFollowing]     = useState([]);
  const [followers, setFollowers]     = useState([]);
  const [incoming, setIncoming]       = useState([]);
  const [friendPicks, setFriendPicks] = useState([]);
  // Drill-in filter for the picks feed — click a friend's avatar/username
  // to narrow the list to just their picks. Null = show all friends.
  const [pickFilterUserId, setPickFilterUserId] = useState(null);
  const [searchQ, setSearchQ]         = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching]     = useState(false);
  const [searchError, setSearchError] = useState('');
  const [loading, setLoading]         = useState(true);
  const [actionId, setActionId]       = useState(null);
  // Sub-tab selector for the secondary "Following" / "Followers" list.
  // Defaults to 'following' to match the previous Followers tab.
  const [subTab, setSubTab]           = useState('following');

  const load = useCallback(async () => {
    try {
      const [{ friends: f }, { requests }, picks, { following: fg }, { followers: fw }] = await Promise.all([
        socialApi.getFriends(),
        socialApi.getIncoming(),
        socialApi.getFriendRecentPicks(),
        socialApi.getFollowing(),
        socialApi.getFollowers(),
      ]);
      setFriends(f ?? []);
      setIncoming(requests ?? []);
      setFriendPicks(picks.picks ?? []);
      setFollowing(fg ?? []);
      setFollowers(fw ?? []);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSearch = async (e) => {
    e.preventDefault();
    const q = searchQ.trim();
    if (!q) return;
    setSearching(true);
    setSearchError('');
    try {
      const { users } = await socialApi.search(q);
      setSearchResults(users ?? []);
    } catch (err) {
      setSearchError(err.message);
    } finally {
      setSearching(false);
    }
  };

  const refreshSearch = useCallback(async () => {
    if (!searchQ.trim() || searchResults === null) return;
    try {
      const { users } = await socialApi.search(searchQ.trim());
      setSearchResults(users ?? []);
    } catch { /* ignore */ }
  }, [searchQ, searchResults]);

  const handleFollow = async (userId, isFollowing) => {
    // Optimistic — toggle the row's isFollowing locally so the button
    // flips instantly. Follow/unfollow doesn't affect friends or
    // incoming requests, so we can skip the load()+refreshSearch()
    // refetch entirely. Was firing 4 requests per click (1 follow +
    // 3 unrelated reads); now just 1.
    setSearchResults((prev) =>
      prev?.map((u) => (u.id === userId ? { ...u, isFollowing: !isFollowing } : u)) ?? prev
    );
    try {
      if (isFollowing) await socialApi.unfollow(userId);
      else             await socialApi.follow(userId);
      toastOk(dispatch, isFollowing ? 'Unfollowed' : 'Following');
    } catch (err) {
      // Rollback — the server rejected the change, so put isFollowing back.
      setSearchResults((prev) =>
        prev?.map((u) => (u.id === userId ? { ...u, isFollowing } : u)) ?? prev
      );
      toastErr(dispatch, isFollowing ? 'Could not unfollow' : 'Could not follow', err);
    }
  };

  const handleFriendAction = async (userId, friendStatus, requestId) => {
    setActionId(userId);
    try {
      let okMsg = '';
      if      (friendStatus === 'none')              { await socialApi.sendRequest(userId);   okMsg = 'Friend request sent'; }
      else if (friendStatus === 'pending_sent')      { await socialApi.cancelRequest(userId); okMsg = 'Friend request canceled'; }
      else if (friendStatus === 'pending_received' && requestId) { await socialApi.respondRequest(requestId, 'accept'); okMsg = 'Friend request accepted'; }
      else if (friendStatus === 'friends')           { await socialApi.unfriend(userId);      okMsg = 'Unfriended'; }
      await Promise.all([load(), refreshSearch()]);
      if (okMsg) toastOk(dispatch, okMsg);
    } catch (err) {
      toastErr(dispatch, 'Could not update friend status', err);
    } finally {
      setActionId(null);
    }
  };

  const handleRespond = async (requestId, action) => {
    setActionId(requestId);
    try {
      await socialApi.respondRequest(requestId, action);
      await load();
      toastOk(dispatch, action === 'accept' ? 'Friend request accepted' : 'Friend request declined');
    } catch (err) {
      toastErr(dispatch, 'Could not respond to friend request', err);
    } finally {
      setActionId(null);
    }
  };

  const handleUnfriend = async (userId) => {
    setActionId(userId);
    try {
      await socialApi.unfriend(userId);
      setFriends((f) => f.filter((u) => u.id !== userId));
      toastOk(dispatch, 'Unfriended');
    } catch (err) {
      toastErr(dispatch, 'Could not unfriend', err);
    } finally {
      setActionId(null);
    }
  };

  // Following/Followers list mutations — distinct from the search-results
  // follow toggle above because they operate on already-loaded rows and
  // optimistically prune the local list instead of reloading.
  const handleListUnfollow = async (userId) => {
    setActionId(userId);
    try {
      await socialApi.unfollow(userId);
      setFollowing((f) => f.filter((u) => u.id !== userId));
      toastOk(dispatch, 'Unfollowed');
    } catch (err) {
      toastErr(dispatch, 'Could not unfollow', err);
    } finally { setActionId(null); }
  };

  const handleListFollow = async (userId) => {
    setActionId(userId);
    try {
      await socialApi.follow(userId);
      await load();
      toastOk(dispatch, 'Following');
    } catch (err) {
      toastErr(dispatch, 'Could not follow', err);
    } finally { setActionId(null); }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <SkeletonSection count={3} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">

      {/* Search */}
      <section>
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Find people</h3>
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={searchQ}
            onChange={(e) => { setSearchQ(e.target.value); setSearchResults(null); setSearchError(''); }}
            placeholder="Search by username or email…"
            className="flex-1 rounded-lg border-0 py-2 px-3 text-sm text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-orange-500"
          />
          <button
            type="submit"
            disabled={searching || !searchQ.trim()}
            className="rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-4 py-2 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 disabled:opacity-50 transition-all shadow-brand-sm"
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </form>
        {searchError && <p className="text-sm text-red-500 mt-2">{searchError}</p>}

        {searchResults !== null && (
          <div className="mt-3">
            {searchResults.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No users found.</p>
            ) : (
              <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 overflow-hidden">
                {searchResults.map((u) => (
                  <li key={u.id} className="flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-8 w-8 rounded-full bg-orange-100 flex items-center justify-center text-orange-600 font-bold text-sm shrink-0">
                        {u.username[0].toUpperCase()}
                      </div>
                      <span className="font-medium text-sm text-gray-900 truncate">{u.username}</span>
                      {u.friendStatus === 'friends' && (
                        <span className="text-xs text-green-600 font-medium bg-green-50 px-1.5 py-0.5 rounded-full shrink-0">Friends</span>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => handleFollow(u.id, u.isFollowing)}
                        className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors border ${
                          u.isFollowing
                            ? 'border-gray-300 text-gray-500 hover:border-red-300 hover:text-red-500'
                            : 'border-orange-300 text-orange-600 hover:bg-orange-50'
                        }`}
                      >
                        {u.isFollowing ? 'Unfollow' : 'Follow'}
                      </button>
                      <button
                        disabled={actionId === u.id}
                        onClick={() => handleFriendAction(u.id, u.friendStatus, u.pendingRequestId)}
                        className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                          u.friendStatus === 'friends'           ? 'bg-gray-100 text-gray-500 hover:bg-red-50 hover:text-red-500'
                          : u.friendStatus === 'pending_sent'   ? 'bg-gray-100 text-gray-500 hover:bg-red-50 hover:text-red-500'
                          : u.friendStatus === 'pending_received' ? 'bg-green-600 text-white hover:bg-green-500'
                          : 'bg-orange-500 text-white hover:bg-orange-400'
                        }`}
                      >
                        {u.friendStatus === 'friends'           ? 'Unfriend'
                         : u.friendStatus === 'pending_sent'    ? 'Cancel request'
                         : u.friendStatus === 'pending_received' ? 'Accept'
                         : 'Add friend'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* Incoming friend requests */}
      {incoming.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Friend requests
            <span className="ml-2 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">{incoming.length}</span>
          </h3>
          <div className="flex flex-col gap-2">
            {incoming.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
                <p className="font-medium text-gray-900 text-sm">{r.sender.username}</p>
                <div className="flex gap-2 shrink-0">
                  <button disabled={actionId === r.id} onClick={() => handleRespond(r.id, 'accept')} className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-400 disabled:opacity-50 transition-colors">Accept</button>
                  <button disabled={actionId === r.id} onClick={() => handleRespond(r.id, 'reject')} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors">Decline</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Friends list */}
      <section>
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Your friends <span className="font-normal normal-case text-gray-400">({friends.length})</span>
        </h3>
        {friends.length === 0 ? (
          <SectionEmpty icon="🤝" title="No friends yet" subtitle="Search for people above to send a friend request." />
        ) : (
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 overflow-hidden">
            {friends.map((u) => (
              <li key={u.id} className="flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-8 w-8 rounded-full bg-gradient-to-br from-orange-400 to-red-400 flex items-center justify-center text-white font-bold text-sm shrink-0">
                    {u.username[0].toUpperCase()}
                  </div>
                  <span className="font-medium text-sm text-gray-900 truncate">{u.username}</span>
                </div>
                <button disabled={actionId === u.id} onClick={() => handleUnfriend(u.id)} className="text-xs text-gray-400 hover:text-red-500 transition-colors disabled:opacity-50">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Following / Followers — one-way relationships. Kept as a sub-tabbed
          section so the page doesn't grow two separate lists in parallel;
          the counts in each chip make it obvious which side has activity. */}
      <section>
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Following &amp; followers</h3>
        <div className="flex rounded-lg bg-gray-100 p-1 w-fit mb-3">
          {['following', 'followers'].map((t) => (
            <button
              key={t}
              onClick={() => setSubTab(t)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                subTab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t === 'following' ? `Following (${following.length})` : `Followers (${followers.length})`}
            </button>
          ))}
        </div>
        {(subTab === 'following' ? following : followers).length === 0 ? (
          <SectionEmpty
            icon={subTab === 'following' ? '🔭' : '👋'}
            title={subTab === 'following' ? "You're not following anyone yet" : 'No followers yet'}
            subtitle={subTab === 'following' ? 'Search for people above and tap Follow.' : 'Share your profile to get followers.'}
          />
        ) : (
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 overflow-hidden">
            {(subTab === 'following' ? following : followers).map((u) => (
              <li key={u.id} className="flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-8 w-8 rounded-full bg-gradient-to-br from-orange-400 to-red-400 flex items-center justify-center text-white font-bold text-sm shrink-0">
                    {u.username?.[0]?.toUpperCase() ?? '?'}
                  </div>
                  <span className="font-medium text-sm text-gray-900 truncate">{u.username}</span>
                </div>
                {subTab === 'following' ? (
                  <button disabled={actionId === u.id} onClick={() => handleListUnfollow(u.id)} className="text-xs text-gray-400 hover:text-red-500 transition-colors disabled:opacity-50">
                    Unfollow
                  </button>
                ) : (
                  !following.some((f) => f.id === u.id) && (
                    <button disabled={actionId === u.id} onClick={() => handleListFollow(u.id)} className="text-xs font-semibold text-orange-600 border border-orange-300 bg-white hover:bg-orange-50 px-2.5 py-1 rounded-full transition-colors disabled:opacity-50">
                      Follow back
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Friends' recent picks */}
      {friendPicks.length > 0 && (() => {
        const filteredPicks = pickFilterUserId
          ? friendPicks.filter((p) => p.user.id === pickFilterUserId)
          : friendPicks;
        const filterName = pickFilterUserId
          ? friendPicks.find((p) => p.user.id === pickFilterUserId)?.user?.username
          : null;
        return (
        <section>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Friends' recent picks</h3>
            {filterName && (
              <button
                type="button"
                onClick={() => setPickFilterUserId(null)}
                className="inline-flex items-center gap-1 rounded-full bg-orange-50 border border-orange-200 px-2 py-0.5 text-[11px] font-medium text-orange-700 hover:bg-orange-100"
              >
                <span>{filterName}</span>
                <span aria-hidden="true">×</span>
                <span className="sr-only">Clear filter</span>
              </button>
            )}
          </div>
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 overflow-hidden">
            {filteredPicks.map((pick) => (
              <li key={pick.id} className="flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={() => setPickFilterUserId(pick.user.id)}
                    title={`Show only ${pick.user.username}'s picks`}
                    className="h-8 w-8 rounded-full bg-orange-100 hover:bg-orange-200 transition-colors flex items-center justify-center text-orange-600 font-bold text-sm shrink-0"
                  >
                    {pick.user.username[0].toUpperCase()}
                  </button>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{pick.restaurant.name}</p>
                    <p className="text-xs text-gray-400">
                      <button
                        type="button"
                        onClick={() => setPickFilterUserId(pick.user.id)}
                        className="hover:text-orange-600 underline-offset-2 hover:underline"
                      >
                        {pick.user.username}
                      </button>
                      {' · '}
                      {new Date(pick.acceptedAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                {pick.restaurant.cuisineType && (
                  <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-orange-50 text-orange-600 font-medium">
                    {pick.restaurant.cuisineType}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
        );
      })()}
    </div>
  );
}

// ── Recommendations tab ───────────────────────────────────────

function RecommendationsTab() {
  const dispatch = useDispatch();
  const [recs, setRecs]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [removingId, setRemovingId] = useState(null);
  const [modalId, setModalId]   = useState(null);

  const load = useCallback(async () => {
    try {
      const { recommendations } = await socialApi.getMyRecommendations();
      setRecs(recommendations ?? []);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    window.addEventListener('pickyum:recommendation-changed', load);
    return () => window.removeEventListener('pickyum:recommendation-changed', load);
  }, [load]);

  const restaurantMap = useMemo(() => {
    const map = {};
    for (const rec of recs) {
      if (!rec.restaurant) continue;
      const r = rec.restaurant;
      map[String(rec.restaurantId)] = {
        name:     r.name,
        type:     r.cuisineType  ?? null,
        price:    r.priceLevel   ?? null,
        rating:   r.googleRating != null ? Number(r.googleRating) : null,
        takeout:  r.takeout,
        delivery: r.delivery,
        website:  r.website  ?? null,
        phone:    r.phone    ?? null,
        hours:    r.hours    ?? null,
        yelp:     r.yelpUrl  ?? null,
      };
    }
    return map;
  }, [recs]);

  const handleRemove = async (restaurantId) => {
    setRemovingId(restaurantId);
    try {
      await socialApi.unrecommend(restaurantId);
      setRecs((prev) => prev.filter((r) => r.restaurantId !== restaurantId));
      toastOk(dispatch, 'Recommendation removed');
    } catch (err) {
      toastErr(dispatch, 'Could not remove recommendation', err);
    } finally {
      setRemovingId(null);
    }
  };

  const handleModalClose = () => {
    setModalId(null);
    // No load() here — recommendation changes inside the modal already
    // dispatch `pickyum:recommendation-changed`, which the listener
    // above picks up. Calling load() unconditionally was a wasteful
    // refetch every time the user just peeked at a card without
    // changing anything.
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <SkeletonList count={3} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-gray-500">Restaurants you've recommended to your network.</p>

      {recs.length === 0 ? (
        <SectionEmpty icon="⭐" title="No recommendations yet" subtitle='Open a restaurant card and hit "Recommend to your network."' />
      ) : (
        <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 overflow-hidden">
          {recs.map((rec) => (
            <li
              key={rec.id}
              className="flex items-start justify-between px-4 py-3 bg-white hover:bg-orange-50 gap-3 cursor-pointer transition-colors"
              onClick={() => setModalId(String(rec.restaurantId))}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium text-sm text-gray-900">{rec.restaurant?.name ?? `Restaurant ${rec.restaurantId}`}</p>
                  {/* Social proof — count of friends/follows that ALSO
                      recommend this restaurant. Helps the user see which
                      of their recommendations are community favorites. */}
                  {rec.friendCount > 0 && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700">
                      Also recommended by {rec.friendCount} {rec.friendCount === 1 ? 'friend' : 'friends'}
                    </span>
                  )}
                </div>
                {rec.tip
                  ? <p className="text-xs text-gray-500 italic mt-0.5">"{rec.tip}"</p>
                  : <p className="text-xs text-gray-400 mt-0.5">No tip added</p>
                }
              </div>
              <button
                disabled={removingId === rec.restaurantId}
                onClick={(e) => { e.stopPropagation(); handleRemove(rec.restaurantId); }}
                className="text-xs text-gray-400 hover:text-red-500 transition-colors shrink-0 mt-0.5 disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {modalId && (
        <RestaurantDetailModal
          restaurantId={modalId}
          restaurantMap={restaurantMap}
          onClose={handleModalClose}
        />
      )}
    </div>
  );
}

// ── Page shell ────────────────────────────────────────────────

const TABS = [
  { id: 'groups',          label: 'Groups',          icon: '👥' },
  { id: 'trips',           label: 'Trips',           icon: '🧳' },
  { id: 'people',          label: 'People',          icon: '🤝' },
  { id: 'recommendations', label: 'Recs',            icon: '⭐' },
];

// Subset of tab ids that may be set via `?tab=…` on the URL. Keeps the
// query parser strict: any unrecognized value falls back to the default.
const VALID_TAB_IDS = new Set(TABS.map((t) => t.id));

const SocialsPage = () => {
  // Allow deep-linking into a specific tab via ?tab=trips etc. Falls
  // back to 'groups' (the most-active surface for return visits) when
  // no/unknown tab is requested.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = VALID_TAB_IDS.has(searchParams.get('tab')) ? searchParams.get('tab') : 'groups';
  const [activeTab, setActiveTab] = useState(initialTab);
  const [socialStats, setSocialStats] = useState(null);

  // Keep the URL in sync as the user clicks between tabs so refreshes
  // and bookmarks land in the same place. `replace: true` avoids
  // polluting browser history with one entry per tab switch.
  const onTabChange = (tabId) => {
    setActiveTab(tabId);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tabId === 'groups') next.delete('tab');
      else                    next.set('tab', tabId);
      return next;
    }, { replace: true });
  };

  useEffect(() => {
    socialApi.getMe()
      .then((stats) => setSocialStats(stats))
      .catch(() => {});
  }, []);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-5">Social</h1>

      {/* Always-visible social stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Friends"   value={socialStats?.friendsCount ?? '—'} />
        <StatCard label="Following" value={socialStats?.followingCount ?? '—'} />
        <StatCard label="Followers" value={socialStats?.followersCount ?? '—'} />
        <StatCard label="Pending"   value={socialStats?.pendingRequestsCount ?? '—'} sub="friend requests" />
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-200 mb-6 gap-1 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap ${
              activeTab === tab.id
                ? 'border-orange-500 text-orange-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <span>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'groups'          && <GroupsTab />}
      {activeTab === 'trips'           && <TripsTab />}
      {activeTab === 'people'          && <PeopleTab />}
      {activeTab === 'recommendations' && <RecommendationsTab />}
    </div>
  );
};

export default SocialsPage;
