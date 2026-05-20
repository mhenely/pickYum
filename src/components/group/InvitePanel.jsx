// User-search + invite affordance for a group. Hosts use it to search the
// directory by username/email and send a pending invite. The search hits
// the social directory (socialApi.search); the invite write is groupsApi.

import { useState } from 'react';
import { socialApi } from '../../lib/socialApi';
import { groupsApi } from '../../lib/groupsApi';

export default function InvitePanel({ groupId, existingMemberIds, existingInviteIds, onInvited }) {
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
