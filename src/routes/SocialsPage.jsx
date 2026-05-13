import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { socialApi } from '../lib/socialApi';
import { groupsApi } from '../lib/groupsApi';
import RestaurantDetailModal from '../components/RestaurantDetailModal';

// ── Shared helpers ────────────────────────────────────────────

const StatCard = ({ label, value, sub }) => (
  <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm text-center">
    <p className="text-2xl font-bold text-orange-600">{value}</p>
    <p className="text-xs font-medium text-gray-600 mt-0.5">{label}</p>
    {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
  </div>
);

function SectionEmpty({ icon, title, subtitle }) {
  return (
    <div className="text-center py-10 text-gray-400">
      <p className="text-3xl mb-2">{icon}</p>
      <p className="font-medium text-gray-600 text-sm">{title}</p>
      {subtitle && <p className="text-xs mt-1">{subtitle}</p>}
    </div>
  );
}

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
        <h2 className="text-lg font-bold text-gray-900 mb-4">Create a group</h2>
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
            <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={loading || !name.trim()} className="flex-1 rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-4 py-2 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 disabled:opacity-50 transition-all shadow-brand-sm">
              {loading ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function GroupCard({ group }) {
  const events       = group.events ?? [];
  const votingEvent  = events.find((e) => e.status === 'VOTING');
  const activeCount  = events.filter((e) => e.status === 'OPEN' || e.status === 'VOTING').length;
  // List endpoint returns _count.members (members excluding host). +1 for the host.
  const memberCount  = (group._count?.members ?? 0) + 1;

  return (
    <Link to={`/groups/${group.id}`} className="block rounded-xl border border-gray-200 bg-white p-4 shadow-sm hover:shadow-md hover:border-orange-200 transition-all">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 truncate">{group.name}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {group.role === 'host' ? 'You are the host' : `Hosted by ${group.host?.username ?? '—'}`}
          </p>
        </div>
        {votingEvent && (
          <span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-700">
            Voting active
          </span>
        )}
      </div>
      <div className="mt-3 flex items-center gap-4 text-xs text-gray-500">
        <span>{memberCount} member{memberCount !== 1 ? 's' : ''}</span>
        <span>{events.length} event{events.length !== 1 ? 's' : ''}</span>
        {activeCount > 0 && (
          <span className="text-orange-600 font-medium">{activeCount} active</span>
        )}
        {votingEvent && (
          <span className="text-orange-600 font-medium">Voting in progress →</span>
        )}
      </div>
    </Link>
  );
}

function GroupsTab() {
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
    } catch { /* ignore */ } finally {
      setRespondingId(null);
    }
  };

  const handleCreated = (group) => {
    setShowCreate(false);
    setGroups((prev) => [{ ...group, role: 'host' }, ...prev]);
  };

  const hostedGroups = groups.filter((g) => g.role === 'host');
  const memberGroups = groups.filter((g) => g.role === 'member');

  if (loading) return <p className="text-center text-sm text-gray-400 py-12">Loading…</p>;
  if (error)   return <p className="text-center text-sm text-red-500 py-12">{error}</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <p className="text-sm text-gray-500">Manage dinner groups and vote with friends.</p>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-4 py-2 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 transition-all shadow-brand-sm"
        >
          + New group
        </button>
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
                {archivedGroups.map((g) => (
                  <div key={g.id} className="rounded-xl border border-gray-200 bg-gray-50 p-4 opacity-70">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-600 truncate">{g.name}</p>
                        <p className="text-xs text-gray-400 mt-0.5">Archived</p>
                      </div>
                    </div>
                    {g.events?.filter((e) => e.status === 'DONE').map((e) => (
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
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {showCreate && <CreateGroupModal onClose={() => setShowCreate(false)} onCreate={handleCreated} />}
    </div>
  );
}

// ── Friends tab ───────────────────────────────────────────────

function FriendsTab() {
  const [friends, setFriends]         = useState([]);
  const [incoming, setIncoming]       = useState([]);
  const [friendPicks, setFriendPicks] = useState([]);
  const [searchQ, setSearchQ]         = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching]     = useState(false);
  const [searchError, setSearchError] = useState('');
  const [loading, setLoading]         = useState(true);
  const [actionId, setActionId]       = useState(null);

  const load = useCallback(async () => {
    try {
      const [{ friends: f }, { requests }, picks] = await Promise.all([
        socialApi.getFriends(),
        socialApi.getIncoming(),
        socialApi.getFriendRecentPicks(),
      ]);
      setFriends(f ?? []);
      setIncoming(requests ?? []);
      setFriendPicks(picks.picks ?? []);
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
    try {
      if (isFollowing) await socialApi.unfollow(userId);
      else             await socialApi.follow(userId);
      await Promise.all([load(), refreshSearch()]);
    } catch { /* ignore */ }
  };

  const handleFriendAction = async (userId, friendStatus, requestId) => {
    setActionId(userId);
    try {
      if      (friendStatus === 'none')              await socialApi.sendRequest(userId);
      else if (friendStatus === 'pending_sent')      await socialApi.cancelRequest(userId);
      else if (friendStatus === 'pending_received' && requestId) await socialApi.respondRequest(requestId, 'accept');
      else if (friendStatus === 'friends')           await socialApi.unfriend(userId);
      await Promise.all([load(), refreshSearch()]);
    } catch { /* ignore */ } finally {
      setActionId(null);
    }
  };

  const handleRespond = async (requestId, action) => {
    setActionId(requestId);
    try { await socialApi.respondRequest(requestId, action); await load(); } catch { /* ignore */ } finally { setActionId(null); }
  };

  const handleUnfriend = async (userId) => {
    setActionId(userId);
    try { await socialApi.unfriend(userId); setFriends((f) => f.filter((u) => u.id !== userId)); } catch { /* ignore */ } finally { setActionId(null); }
  };

  if (loading) return <p className="text-center text-sm text-gray-400 py-12">Loading…</p>;

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

      {/* Friends' recent picks */}
      {friendPicks.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Friends' recent picks</h3>
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 overflow-hidden">
            {friendPicks.map((pick) => (
              <li key={pick.id} className="flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-8 w-8 rounded-full bg-orange-100 flex items-center justify-center text-orange-600 font-bold text-sm shrink-0">
                    {pick.user.username[0].toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{pick.restaurant.name}</p>
                    <p className="text-xs text-gray-400">{pick.user.username} · {new Date(pick.acceptedAt).toLocaleDateString()}</p>
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
      )}
    </div>
  );
}

// ── Followers tab ─────────────────────────────────────────────

function FollowersTab() {
  const [following, setFollowing] = useState([]);
  const [followers, setFollowers] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [actionId, setActionId]   = useState(null);
  const [subTab, setSubTab]       = useState('following');

  const load = useCallback(async () => {
    try {
      const [{ following: fg }, { followers: fw }] = await Promise.all([
        socialApi.getFollowing(),
        socialApi.getFollowers(),
      ]);
      setFollowing(fg ?? []);
      setFollowers(fw ?? []);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleUnfollow = async (userId) => {
    setActionId(userId);
    try { await socialApi.unfollow(userId); setFollowing((f) => f.filter((u) => u.id !== userId)); } catch { /* ignore */ } finally { setActionId(null); }
  };

  const handleFollow = async (userId) => {
    setActionId(userId);
    try { await socialApi.follow(userId); await load(); } catch { /* ignore */ } finally { setActionId(null); }
  };

  if (loading) return <p className="text-center text-sm text-gray-400 py-12">Loading…</p>;

  const list = subTab === 'following' ? following : followers;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex rounded-lg bg-gray-100 p-1 w-fit">
        {['following', 'followers'].map((t) => (
          <button key={t} onClick={() => setSubTab(t)} className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${subTab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
            {t === 'following' ? `Following (${following.length})` : `Followers (${followers.length})`}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <SectionEmpty
          icon={subTab === 'following' ? '🔭' : '👋'}
          title={subTab === 'following' ? "You're not following anyone yet" : "No followers yet"}
          subtitle={subTab === 'following' ? 'Use the Friends tab to find and follow people.' : 'Share your profile to get followers.'}
        />
      ) : (
        <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 overflow-hidden">
          {list.map((u) => (
            <li key={u.id} className="flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-8 w-8 rounded-full bg-gradient-to-br from-orange-400 to-red-400 flex items-center justify-center text-white font-bold text-sm shrink-0">
                  {u.username?.[0]?.toUpperCase() ?? '?'}
                </div>
                <span className="font-medium text-sm text-gray-900 truncate">{u.username}</span>
              </div>
              {subTab === 'following' ? (
                <button disabled={actionId === u.id} onClick={() => handleUnfollow(u.id)} className="text-xs text-gray-400 hover:text-red-500 transition-colors disabled:opacity-50">
                  Unfollow
                </button>
              ) : (
                !following.some((f) => f.id === u.id) && (
                  <button disabled={actionId === u.id} onClick={() => handleFollow(u.id)} className="text-xs font-semibold text-orange-600 border border-orange-300 bg-white hover:bg-orange-50 px-2.5 py-1 rounded-full transition-colors disabled:opacity-50">
                    Follow back
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Recommendations tab ───────────────────────────────────────

function RecommendationsTab() {
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
    } catch { /* ignore */ } finally {
      setRemovingId(null);
    }
  };

  const handleModalClose = () => {
    setModalId(null);
    load();
  };

  if (loading) return <p className="text-center text-sm text-gray-400 py-12">Loading…</p>;

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
                <p className="font-medium text-sm text-gray-900">{rec.restaurant?.name ?? `Restaurant ${rec.restaurantId}`}</p>
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
  { id: 'friends',         label: 'Friends',         icon: '🤝' },
  { id: 'followers',       label: 'Followers',       icon: '📡' },
  { id: 'recommendations', label: 'Recommendations', icon: '⭐' },
];

const SocialsPage = () => {
  const [activeTab, setActiveTab] = useState('groups');
  const [socialStats, setSocialStats] = useState(null);

  useEffect(() => {
    socialApi.getMe()
      .then((stats) => setSocialStats(stats))
      .catch(() => {});
  }, []);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-5">Socials</h1>

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
            onClick={() => setActiveTab(tab.id)}
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
      {activeTab === 'friends'         && <FriendsTab />}
      {activeTab === 'followers'       && <FollowersTab />}
      {activeTab === 'recommendations' && <RecommendationsTab />}
    </div>
  );
};

export default SocialsPage;
