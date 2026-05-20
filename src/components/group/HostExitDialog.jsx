// Shown when the current host clicks "Disband group". Offers two paths:
//   1. Transfer ownership to another member (group keeps running)
//   2. Archive the group entirely (read-only history preserved)
// Auto-collapses to option 2 when there are no other members to hand off to.

import { useState } from 'react';
import { groupsApi } from '../../lib/groupsApi';

export default function HostExitDialog({ group, onClose, onTransferred, onDisbanded }) {
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
