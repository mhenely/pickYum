// Host-only "when are we going out" date picker for a group event.
// Non-hosts see the picked date inline (when set); hidden entirely when
// no date is set and the viewer isn't the host. Mirrors the schedule
// picker shape but writes scheduledFor on the event rather than the
// votingStartsAt auto-start.

import { useState } from 'react';
import { groupsApi } from '../../lib/groupsApi';
import Button from '../ui/Button';

export default function EventDatePicker({ groupId, event, isHost, onUpdated }) {
  const [value, setValue] = useState(
    event.scheduledFor ? new Date(event.scheduledFor).toISOString().slice(0, 16) : ''
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    setSaving(true); setError('');
    try {
      const next = value || null;
      const { scheduledFor } = await groupsApi.setEventDate(groupId, event.id, next);
      onUpdated(scheduledFor ?? next);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };
  const handleClear = async () => {
    setValue(''); setSaving(true);
    try { await groupsApi.setEventDate(groupId, event.id, null); onUpdated(null); }
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
          <Button onClick={handleSave} size="sm" loading={saving} disabled={!value}>
            Set
          </Button>
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
