import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

// Trips list — every trip the user hosts OR is a member of, plus an
// inline form to create a new one. Mirrors the SocialsPage / Groups
// pattern: simple top-of-page form + list of cards below. Archived
// trips render in a muted section at the bottom so they don't clutter
// the active set.

function formatDateRange(startDate, endDate) {
  if (!startDate && !endDate) return 'No dates set';
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  const start = startDate ? new Date(startDate).toLocaleDateString(undefined, opts) : null;
  const end   = endDate   ? new Date(endDate).toLocaleDateString(undefined, opts)   : null;
  if (start && end) return `${start} – ${end}`;
  return start ?? end;
}

const TripCard = ({ trip }) => (
  <Link
    to={`/trips/${trip.id}`}
    className={`block rounded-xl border bg-white shadow-sm p-4 hover:border-orange-300 hover:shadow-md transition-all ${
      trip.archivedAt ? 'opacity-70' : ''
    }`}
  >
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-gray-900 truncate">{trip.name}</p>
        <p className="text-sm text-gray-500 truncate">{trip.destination}</p>
        <p className="text-xs text-gray-400 mt-1">
          {formatDateRange(trip.startDate, trip.endDate)}
        </p>
      </div>
      {trip.archivedAt && (
        <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 shrink-0">
          Archived
        </span>
      )}
    </div>
    <div className="flex items-center gap-2 mt-3 text-xs text-gray-500">
      <span>👤 {trip.host.username}</span>
      <span>·</span>
      {/* List endpoint now returns `_count` instead of full member arrays
          (saves O(trips × members × …) payload on every Trips page load).
          See ApiTripListEntry in api.ts. */}
      <span>{trip._count.members} member{trip._count.members === 1 ? '' : 's'}</span>
    </div>
  </Link>
);

export default function TripsPage() {
  const navigate = useNavigate();
  const [trips,   setTrips]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  // Create-trip form state. Kept inline (not a modal) since the form is
  // tiny and modals add friction for a primary action.
  const [showCreate,  setShowCreate]  = useState(false);
  const [newName,     setNewName]     = useState('');
  const [newDest,     setNewDest]     = useState('');
  const [newStart,    setNewStart]    = useState('');
  const [newEnd,      setNewEnd]      = useState('');
  const [createError, setCreateError] = useState('');
  const [creating,    setCreating]    = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { trips: list } = await api.trips.list();
      setTrips(list);
    } catch (err) {
      setError(err.message ?? 'Could not load your trips.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim() || !newDest.trim()) return;
    setCreateError('');
    setCreating(true);
    try {
      const { trip } = await api.trips.create({
        name: newName.trim(),
        destination: newDest.trim(),
        // HTML date inputs emit YYYY-MM-DD; passing through as-is since
        // the server parses with new Date() which handles this format.
        startDate: newStart || null,
        endDate:   newEnd   || null,
      });
      // Reset form + jump straight to the detail page where the user
      // will add members + anchors next.
      setNewName('');
      setNewDest('');
      setNewStart('');
      setNewEnd('');
      setShowCreate(false);
      navigate(`/trips/${trip.id}`);
    } catch (err) {
      setCreateError(err.message ?? 'Could not create trip.');
    } finally {
      setCreating(false);
    }
  };

  // Split into upcoming/past sections — past trips that aren't yet
  // archived still show in the active list (the host may not have hit
  // archive yet), but visually we separate by archive status.
  const active   = trips.filter((t) => !t.archivedAt);
  const archived = trips.filter((t) => t.archivedAt);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Trips</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Plan a multi-meal trip with friends — vote on each meal as you go.
          </p>
        </div>
        {!showCreate && (
          <button
            onClick={() => setShowCreate(true)}
            className="rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-4 py-2 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 transition-all shadow-brand-sm"
          >
            + New trip
          </button>
        )}
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="rounded-xl border border-orange-100 bg-orange-50/40 p-4 mb-6">
          <p className="text-xs font-semibold text-orange-500 uppercase tracking-wider mb-3">
            ✈️ New trip
          </p>
          <div className="flex flex-col gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => { setNewName(e.target.value); setCreateError(''); }}
              placeholder="Trip name (e.g. Italy 2026)"
              maxLength={80}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <input
              type="text"
              value={newDest}
              onChange={(e) => { setNewDest(e.target.value); setCreateError(''); }}
              placeholder="Destination (e.g. Rome, Italy)"
              maxLength={200}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-xs text-gray-500 mb-0.5 block">Start (optional)</label>
                <input
                  type="date"
                  value={newStart}
                  onChange={(e) => setNewStart(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
              <div className="flex-1">
                <label className="text-xs text-gray-500 mb-0.5 block">End (optional)</label>
                <input
                  type="date"
                  value={newEnd}
                  onChange={(e) => setNewEnd(e.target.value)}
                  min={newStart || undefined}
                  className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
            </div>
            {createError && <p className="text-xs text-red-500">{createError}</p>}
            <div className="flex items-center gap-2 mt-1">
              <button
                type="submit"
                disabled={!newName.trim() || !newDest.trim() || creating}
                className="rounded-md bg-orange-500 px-4 py-1.5 text-sm font-semibold text-white hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {creating ? 'Creating…' : 'Create trip'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCreate(false);
                  setCreateError('');
                  setNewName(''); setNewDest(''); setNewStart(''); setNewEnd('');
                }}
                className="text-sm font-medium text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
            </div>
          </div>
        </form>
      )}

      {loading && <p className="text-center text-sm text-gray-400 py-20">Loading your trips…</p>}
      {error   && <p className="text-center text-sm text-red-500 py-20">{error}</p>}

      {!loading && !error && (
        <>
          {active.length === 0 && archived.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-gray-200 bg-gray-50/40 p-10 text-center">
              <p className="text-4xl mb-3" aria-hidden="true">✈️</p>
              <p className="text-sm font-medium text-gray-700 mb-1">No trips yet</p>
              <p className="text-xs text-gray-500">
                Create your first trip to plan meals at a destination with friends.
              </p>
            </div>
          ) : (
            <>
              {active.length > 0 && (
                <div className="flex flex-col gap-3">
                  {active.map((trip) => <TripCard key={trip.id} trip={trip} />)}
                </div>
              )}
              {archived.length > 0 && (
                <div className="mt-8">
                  <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                    Archived
                  </h2>
                  <div className="flex flex-col gap-3">
                    {archived.map((trip) => <TripCard key={trip.id} trip={trip} />)}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
