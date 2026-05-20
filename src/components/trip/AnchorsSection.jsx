// Trip anchors panel — locations like the hotel or conference center
// used as the default search center when adding restaurants to meal
// events. Host can add up to 10, mark one primary, and delete; members
// see the list read-only.

import { useState } from 'react';
import { api } from '../../lib/api';

export default function AnchorsSection({ trip, canHostAct, onRefresh }) {
  const [showAdd,    setShowAdd]    = useState(false);
  const [newLabel,   setNewLabel]   = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [addError,   setAddError]   = useState('');
  const [saving,     setSaving]     = useState(false);
  // editing/promoting/deleting tracked by anchor id so each row's button
  // can render its own loading state without conflating with siblings.
  const [actioningId, setActioningId] = useState(null);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!newLabel.trim() || !newAddress.trim()) return;
    setAddError('');
    setSaving(true);
    try {
      await api.trips.addAnchor(trip.id, { label: newLabel.trim(), address: newAddress.trim() });
      setNewLabel(''); setNewAddress('');
      setShowAdd(false);
      onRefresh();
    } catch (err) {
      setAddError(err.message ?? 'Could not add anchor.');
    } finally {
      setSaving(false);
    }
  };

  const handleSetPrimary = async (anchor) => {
    if (anchor.isPrimary) return;
    setActioningId(anchor.id);
    try {
      await api.trips.updateAnchor(trip.id, anchor.id, { isPrimary: true });
      onRefresh();
    } catch { /* non-fatal */ }
    finally { setActioningId(null); }
  };

  const handleDelete = async (anchor) => {
    setActioningId(anchor.id);
    try {
      await api.trips.deleteAnchor(trip.id, anchor.id);
      onRefresh();
    } catch { /* non-fatal */ }
    finally { setActioningId(null); }
  };

  return (
    <section id="trip-anchors" className="rounded-xl border border-gray-200 bg-white p-4 scroll-mt-4">
      <h2 className="text-sm font-semibold text-gray-700 mb-3">
        Anchors <span className="text-gray-400 font-normal">({trip.anchors.length})</span>
      </h2>
      <p className="text-xs text-gray-500 mb-3">
        Locations like your hotel or conference center — used as the default search center when adding restaurants to meal events.
      </p>

      {trip.anchors.length === 0 ? (
        <p className="text-xs text-gray-400 italic mb-3">No anchors yet.</p>
      ) : (
        <ul className="flex flex-col gap-2 mb-3">
          {trip.anchors.map((a) => (
            <li
              key={a.id}
              className={`rounded-lg border p-3 ${a.isPrimary ? 'border-orange-300 bg-orange-50/40' : 'border-gray-200'}`}
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-gray-900 truncate">{a.label}</p>
                    {a.isPrimary && (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-orange-200 text-orange-800">
                        Primary
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 truncate">{a.address}</p>
                </div>
                {canHostAct && (
                  <div className="flex items-center gap-1 shrink-0">
                    {!a.isPrimary && (
                      <button
                        onClick={() => handleSetPrimary(a)}
                        disabled={actioningId === a.id}
                        className="rounded px-2 py-1 text-xs font-medium text-orange-600 hover:bg-orange-100 disabled:opacity-40"
                      >
                        Set primary
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(a)}
                      disabled={actioningId === a.id}
                      className="rounded px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-50 disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {canHostAct && (
        trip.anchors.length < 10 ? (
          !showAdd ? (
            <button
              onClick={() => setShowAdd(true)}
              className="text-xs font-medium text-orange-600 hover:text-orange-800"
            >
              + Add an anchor
            </button>
          ) : (
            <form onSubmit={handleAdd} className="flex flex-col gap-2">
              <input
                type="text"
                value={newLabel}
                onChange={(e) => { setNewLabel(e.target.value); setAddError(''); }}
                placeholder="Label (e.g. Hotel)"
                maxLength={64}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              <input
                type="text"
                value={newAddress}
                onChange={(e) => { setNewAddress(e.target.value); setAddError(''); }}
                placeholder="Address"
                autoComplete="street-address"
                maxLength={256}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              {addError && <p className="text-xs text-red-500">{addError}</p>}
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={!newLabel.trim() || !newAddress.trim() || saving}
                  className="rounded-md bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-400 disabled:opacity-40"
                >
                  {saving ? 'Saving…' : 'Add anchor'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowAdd(false); setAddError(''); setNewLabel(''); setNewAddress(''); }}
                  className="text-xs font-medium text-gray-500 hover:text-gray-700"
                >
                  Cancel
                </button>
              </div>
            </form>
          )
        ) : (
          <p className="text-xs text-gray-400 italic">Anchor limit reached (10).</p>
        )
      )}
    </section>
  );
}
