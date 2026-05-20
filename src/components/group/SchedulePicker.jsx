// Host-only "auto-start voting at this time" picker. Setting a non-null
// value asks the server to flip the event into VOTING automatically once
// `votingStartsAt` is reached (via the on-read sweeper in GET /:id).
// Clearing returns the event to manual-start mode.

import { useState } from 'react';
import { groupsApi } from '../../lib/groupsApi';

export default function SchedulePicker({ groupId, event, onUpdated }) {
  const [value, setValue] = useState(
    event.votingStartsAt ? new Date(event.votingStartsAt).toISOString().slice(0, 16) : ''
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const now = new Date().toISOString().slice(0, 16);

  const handleSave = async () => {
    setSaving(true); setError('');
    try {
      const next = value || null;
      const { votingStartsAt } = await groupsApi.setSchedule(groupId, event.id, next);
      // Pass the server's normalized value through so the parent applies it
      // locally instead of refetching the whole group.
      onUpdated(votingStartsAt ?? next);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };
  const handleClear = async () => {
    setValue(''); setSaving(true);
    try { await groupsApi.setSchedule(groupId, event.id, null); onUpdated(null); }
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
