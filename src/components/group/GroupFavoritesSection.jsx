// Shared restaurant list for the group, separate from each member's personal
// favorites. Any member can add/remove. Loads on its own (one extra request)
// rather than expanding the group payload — keeps the existing list/detail
// endpoints small.

import { useState, useEffect, useCallback } from 'react';
import { groupsApi } from '../../lib/groupsApi';

export default function GroupFavoritesSection({ groupId, isArchived, allRestaurants }) {
  const [favorites, setFavorites] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [adding, setAdding]       = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { favorites: list } = await groupsApi.listFavorites(groupId);
      setFavorites(list);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { load(); }, [load]);

  const handleRemove = async (restaurantId) => {
    try {
      await groupsApi.removeFavorite(groupId, restaurantId);
      await load();
    } catch { /* ignore */ }
  };

  // Suggestions come from the user's known restaurants (customRestaurants) —
  // restaurants the user has interacted with anywhere in the app. Filtered to
  // names that match the query and aren't already in group favorites.
  const [query, setQuery] = useState('');
  const trimmedQuery = query.trim();
  const favSet = new Set(favorites.map((f) => String(f.restaurantId)));
  const suggestions = trimmedQuery
    ? Object.entries(allRestaurants)
        .filter(([id, r]) =>
          r?.name?.toLowerCase().includes(trimmedQuery.toLowerCase()) &&
          !favSet.has(String(id))
        )
        .slice(0, 6)
    : [];

  const handleAdd = async (restaurantId) => {
    setAdding(true);
    try {
      await groupsApi.addFavorite(groupId, restaurantId);
      setQuery('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
          Group favorites {favorites.length > 0 && <span className="text-gray-400">({favorites.length})</span>}
        </h2>
      </div>

      {!isArchived && (
        <div className="relative mb-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Add a restaurant to group favorites…"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
          {suggestions.length > 0 && (
            <ul className="absolute z-20 mt-1 w-full bg-white rounded-lg shadow-lg ring-1 ring-black/5 max-h-60 overflow-y-auto">
              {suggestions.map(([id, r]) => (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => handleAdd(Number(id))}
                    disabled={adding}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-orange-50 hover:text-orange-700 flex justify-between items-center disabled:opacity-50"
                  >
                    <span>{r.name}</span>
                    {r.type && <span className="text-xs text-gray-400 ml-2 shrink-0">{r.type}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : favorites.length === 0 ? (
        <p className="text-sm text-gray-400 italic">
          No group favorites yet.{!isArchived && ' Type above to add restaurants this group ends up at.'}
        </p>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden divide-y divide-gray-100">
          {favorites.map((f) => (
            <div key={f.restaurantId} className="flex items-center justify-between px-4 py-2.5 gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{f.restaurant?.name}</p>
                <p className="text-xs text-gray-400 truncate">
                  {f.restaurant?.cuisineType ?? 'Restaurant'} · added by {f.addedBy?.username}
                </p>
              </div>
              {!isArchived && (
                <button
                  onClick={() => handleRemove(f.restaurantId)}
                  className="shrink-0 text-xs text-gray-400 hover:text-red-500 transition-colors"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
