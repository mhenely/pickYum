// "New vote event" modal for a group. Pre-populates the option pool with
// the group's existing favorites — common case is "yes, all the usual
// spots are candidates again." User unchecks anything they want to
// exclude this round. One round-trip (createEvent + seed options in the
// same transaction) avoids the N follow-up addOption writes the older
// flow needed.

import { useState, useEffect } from 'react';
import { groupsApi } from '../../lib/groupsApi';

export default function CreateEventModal({ groupId, onClose, onCreate }) {
  const [name, setName]       = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  // Group favorites pulled in for the quick-add panel. Loaded once on mount.
  // Pre-selecting all of them is the "quick" affordance — common case is
  // "yes, all the usual spots are candidates again." User unchecks anything
  // they want to exclude this round.
  const [favorites, setFavorites]             = useState([]);
  const [favoritesLoading, setFavoritesLoading] = useState(true);
  const [selectedIds, setSelectedIds]         = useState(() => new Set());

  useEffect(() => {
    let cancelled = false;
    groupsApi.listFavorites(groupId)
      .then(({ favorites: list }) => {
        if (cancelled) return;
        setFavorites(list);
        setSelectedIds(new Set(list.map((f) => f.restaurantId)));
      })
      .catch(() => { /* favorites are optional — silent fail keeps the modal usable */ })
      .finally(() => { if (!cancelled) setFavoritesLoading(false); });
    return () => { cancelled = true; };
  }, [groupId]);

  const toggleFavorite = (restaurantId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(restaurantId)) next.delete(restaurantId);
      else next.add(restaurantId);
      return next;
    });
  };
  const selectAll  = () => setSelectedIds(new Set(favorites.map((f) => f.restaurantId)));
  const selectNone = () => setSelectedIds(new Set());

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true); setError('');
    try {
      // Single round-trip: server seeds the checked-favorite options in the
      // same transaction as the event create. Was previously
      // `createEvent` + N parallel `addOption` calls — N round-trips through
      // writeLimiter for every "Plan an event from my favorites" flow.
      const optionIds = selectedIds.size > 0
        ? [...selectedIds].map(Number).filter((n) => Number.isInteger(n) && n > 0)
        : undefined;
      const { event } = await groupsApi.createEvent(groupId, name.trim(), optionIds);

      onCreate(event);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const hasFavorites = favorites.length > 0;
  const selectedCount = selectedIds.size;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 max-h-[90vh] flex flex-col">
        <h2 className="text-lg font-bold text-gray-900 mb-4 shrink-0">New vote event</h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 min-h-0 flex-1">
          <input
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            placeholder="e.g. Friday Dinner, Movie Night…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />

          {/* Quick-add from group favorites — only rendered when the group has
              at least one favorite. The list is scrollable so a group with
              30 favorites doesn't blow up the modal. */}
          {favoritesLoading ? (
            <p className="text-xs text-gray-400">Loading group favorites…</p>
          ) : hasFavorites ? (
            <div className="border border-gray-200 rounded-lg overflow-hidden flex flex-col min-h-0">
              <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200 shrink-0">
                <p className="text-xs font-semibold text-gray-600">
                  Quick-add from group favorites
                  <span className="ml-1.5 text-gray-400">({selectedCount}/{favorites.length})</span>
                </p>
                <div className="flex gap-2 text-[11px]">
                  <button type="button" onClick={selectAll}  className="text-orange-600 hover:underline">All</button>
                  <span className="text-gray-300">·</span>
                  <button type="button" onClick={selectNone} className="text-gray-500  hover:underline">None</button>
                </div>
              </div>
              <ul className="overflow-y-auto max-h-48 divide-y divide-gray-100">
                {favorites.map((f) => (
                  <li key={f.restaurantId}>
                    <label className="flex items-center gap-2 px-3 py-2 hover:bg-orange-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(f.restaurantId)}
                        onChange={() => toggleFavorite(f.restaurantId)}
                        className="rounded border-gray-300 text-orange-500 focus:ring-orange-500"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-800 truncate">
                          {f.restaurant?.name ?? `Restaurant #${f.restaurantId}`}
                        </p>
                        {f.restaurant?.cuisineType && (
                          <p className="text-xs text-gray-400 truncate">{f.restaurant.cuisineType}</p>
                        )}
                      </div>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2 mt-1 shrink-0">
            <button type="button" onClick={onClose}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={loading || !name.trim()}
              className="flex-1 rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-4 py-2 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 disabled:opacity-50 transition-all shadow-brand-sm">
              {loading
                ? 'Creating…'
                : selectedCount > 0
                  ? `Create + add ${selectedCount}`
                  : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
