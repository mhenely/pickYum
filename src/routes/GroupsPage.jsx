import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { groupsApi } from '../lib/groupsApi';

const STATUS_BADGE = {
  OPEN:   { label: 'Open',   cls: 'bg-green-100 text-green-700' },
  VOTING: { label: 'Voting', cls: 'bg-orange-100 text-orange-700' },
  DONE:   { label: 'Done',   cls: 'bg-gray-100 text-gray-500' },
};

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
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim()}
              className="flex-1 rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-500 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function GroupCard({ group }) {
  const badge = STATUS_BADGE[group.status] ?? STATUS_BADGE.OPEN;
  // List endpoint returns _count.members (members excluding host). +1 for the host.
  const memberCount = (group._count?.members ?? 0) + 1;
  const selectionCount = group.selections?.length ?? 0;

  return (
    <Link
      to={`/groups/${group.id}`}
      className="block rounded-xl border border-gray-200 bg-white p-4 shadow-sm hover:shadow-md hover:border-orange-200 transition-all"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 truncate">{group.name}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {group.role === 'host' ? 'You are the host' : `Hosted by ${group.host?.username ?? '—'}`}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>
          {badge.label}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-4 text-xs text-gray-500">
        <span>{memberCount} member{memberCount !== 1 ? 's' : ''}</span>
        {group.status !== 'DONE' && <span>{selectionCount} selection{selectionCount !== 1 ? 's' : ''}</span>}
        {group.status === 'VOTING' && group.sessionId && (
          <span className="text-orange-600 font-medium">Voting in progress →</span>
        )}
        {group.status === 'DONE' && group.result?.winnerName && (
          <span className="text-green-700 font-medium">🏆 {group.result.winnerName}</span>
        )}
      </div>
    </Link>
  );
}

const GroupsPage = () => {
  const [groups, setGroups] = useState([]);
  const [pendingInvites, setPendingInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [respondingId, setRespondingId] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await groupsApi.list();
      setGroups(data.groups ?? []);
      setPendingInvites(data.pendingInvites ?? []);
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

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Groups</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-500 transition-colors"
        >
          + New group
        </button>
      </div>

      {loading && (
        <p className="text-center text-sm text-gray-400 py-12">Loading…</p>
      )}
      {error && (
        <p className="text-center text-sm text-red-500 py-12">{error}</p>
      )}

      {!loading && !error && (
        <div className="flex flex-col gap-8">

          {/* Pending invites */}
          {pendingInvites.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
                Pending invites
                <span className="ml-2 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold">{pendingInvites.length}</span>
              </h2>
              <div className="flex flex-col gap-3">
                {pendingInvites.map((inv) => (
                  <div key={inv.id} className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 truncate">{inv.group.name}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Invited by {inv.invitedBy.username}
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        disabled={respondingId === inv.id}
                        onClick={() => handleRespond(inv, 'accept')}
                        className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-50 transition-colors"
                      >
                        Accept
                      </button>
                      <button
                        disabled={respondingId === inv.id}
                        onClick={() => handleRespond(inv, 'decline')}
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Groups I host */}
          {hostedGroups.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
                Groups you host
              </h2>
              <div className="flex flex-col gap-3">
                {hostedGroups.map((g) => <GroupCard key={g.id} group={g} />)}
              </div>
            </section>
          )}

          {/* Groups I'm a member of */}
          {memberGroups.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
                Groups you've joined
              </h2>
              <div className="flex flex-col gap-3">
                {memberGroups.map((g) => <GroupCard key={g.id} group={g} />)}
              </div>
            </section>
          )}

          {groups.length === 0 && pendingInvites.length === 0 && (
            <div className="text-center py-16 text-gray-400">
              <p className="text-4xl mb-3">👥</p>
              <p className="font-medium text-gray-600">No groups yet</p>
              <p className="text-sm mt-1">Create one and invite friends to vote together.</p>
            </div>
          )}
        </div>
      )}

      {showCreate && (
        <CreateGroupModal onClose={() => setShowCreate(false)} onCreate={handleCreated} />
      )}
    </div>
  );
};

export default GroupsPage;
