// Collapsible insights panel for a group — stat tiles, top winners,
// "always added never chosen" list, member appearances + vote alignment +
// cuisine fingerprint. Extracted from GroupDetailPage so the route file
// isn't carrying 240 lines of insights presentation.
//
// Lazily fetches data on first expand to keep page mount cheap for
// groups the user doesn't open the panel on.

import { useState } from 'react';
import { groupsApi } from '../../lib/groupsApi';
import RestaurantDetailModal from '../RestaurantDetailModal';

const METHOD_LABELS = { vote: '🗳 Vote', flip: '🪙 Flip', spin: '🎰 Spin' };

export default function GroupInsightsPanel({ groupId }) {
  const [open, setOpen]       = useState(false);
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  // Restaurant detail modal — string id when open, null when closed.
  // Uses RestaurantDetailModal in readOnly + actions={null} mode so it
  // auto-fetches from /api/restaurants/:id and stays a pure viewer
  // (no Add-to-Options / Favorite implicit in this context).
  const [infoForId, setInfoForId] = useState(null);

  const handleToggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (data) return; // already loaded
    setLoading(true); setError('');
    try {
      setData(await groupsApi.getInsights(groupId));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section>
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-between text-left rounded-xl border border-gray-200 bg-white px-4 py-3 hover:bg-gray-50 transition-colors"
      >
        <span className="text-sm font-semibold text-gray-700">📊 Group insights</span>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="mt-2 rounded-xl border border-gray-200 bg-white p-4">
          {loading && <p className="text-sm text-gray-400">Loading insights…</p>}
          {error && <p className="text-sm text-red-500">{error}</p>}
          {data && !loading && !error && (
            data.totalEvents === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">
                No completed events yet. Come back after the group makes a few decisions.
              </p>
            ) : (
              <div className="flex flex-col gap-5">
                {/* Stat tiles */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <p className="text-2xl font-black text-orange-600">{data.totalEvents}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">decisions</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <p className="text-2xl font-black text-orange-600">{data.distinctWinners}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">different winners</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <p className="text-2xl font-black text-orange-600">{Object.keys(data.memberAppearances ?? {}).length}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">members participated</p>
                  </div>
                </div>

                {/* Method breakdown */}
                {Object.keys(data.methodCounts ?? {}).length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">How decisions are made</p>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(data.methodCounts).map(([m, c]) => (
                        <span key={m} className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
                          {METHOD_LABELS[m] ?? m} · <span className="font-semibold">{c}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Top winners */}
                {data.topWinners?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Group favorites in practice</p>
                    <ul className="space-y-1.5">
                      {data.topWinners.map((r) => (
                        <li key={r.restaurantId}>
                          <button
                            type="button"
                            onClick={() => setInfoForId(r.restaurantId)}
                            className="w-full flex items-center justify-between rounded-lg bg-green-50 border border-green-100 px-3 py-1.5 transition-colors hover:bg-green-100 hover:border-green-200 focus:outline-none focus:ring-2 focus:ring-green-400 text-left"
                          >
                            <span className="text-sm font-medium text-green-800 truncate">🏆 {r.name}</span>
                            <span className="text-xs text-green-700 shrink-0">
                              won {r.wins}× · {Math.round(r.winRate * 100)}%
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Often considered, never chosen */}
                {data.oftenSkipped?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Always added, never chosen</p>
                    <ul className="space-y-1.5">
                      {data.oftenSkipped.map((r) => (
                        <li key={r.restaurantId}>
                          <button
                            type="button"
                            onClick={() => setInfoForId(r.restaurantId)}
                            className="w-full flex items-center justify-between rounded-lg bg-amber-50 border border-amber-100 px-3 py-1.5 transition-colors hover:bg-amber-100 hover:border-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-400 text-left"
                          >
                            <span className="text-sm font-medium text-amber-900 truncate">{r.name}</span>
                            <span className="text-xs text-amber-700 shrink-0">
                              considered {r.considered}× · 0 wins
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Member appearances — keeps the "who's been around" view
                    minimal. Vote alignment moved to its own section below for
                    legibility. */}
                {Object.keys(data.memberAppearances ?? {}).length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Who shows up</p>
                    <ul className="space-y-1.5">
                      {Object.entries(data.memberAppearances)
                        .sort(([, a], [, b]) => b - a)
                        .slice(0, 8)
                        .map(([name, count]) => (
                          <li key={name} className="flex items-center justify-between text-sm">
                            <span className="text-gray-700">{name}</span>
                            <span className="text-xs text-gray-500">
                              {count} of {data.totalEvents}
                            </span>
                          </li>
                        ))}
                    </ul>
                  </div>
                )}

                {/* Vote alignment — per-member rate of voting with the winner.
                    Simple votes: approved the winning restaurant. Ranked votes:
                    placed the winner as their #1 choice. Members who never
                    voted are silently filtered (picks === 0). */}
                {(() => {
                  const aligned = Object.entries(data.memberWinAccuracy ?? {})
                    .filter(([, v]) => v && v.picks > 0)
                    .sort(([, a], [, b]) => b.rate - a.rate);
                  if (aligned.length === 0) return null;
                  return (
                    <div>
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Vote alignment</p>
                      <p className="text-[11px] text-gray-400 mb-2">
                        How often each member's vote matched the group's winner.
                      </p>
                      <ul className="space-y-1.5">
                        {aligned.map(([name, v]) => {
                          const pct = Math.round(v.rate * 100);
                          // Highlight extremes: ≥80% reads as "always agrees with the group",
                          // ≤25% as "the contrarian". Middle band stays neutral gray.
                          const tone = pct >= 80 ? 'text-emerald-700 bg-emerald-50 border-emerald-100'
                                     : pct <= 25 ? 'text-purple-700 bg-purple-50 border-purple-100'
                                     :             'text-gray-700 bg-gray-50 border-gray-100';
                          return (
                            <li key={name} className={`flex items-center gap-3 rounded-lg border px-3 py-1.5 ${tone}`}>
                              <span className="text-sm font-medium flex-shrink-0 truncate min-w-0 flex-1">{name}</span>
                              <div className="w-24 h-1.5 bg-white/60 rounded-full overflow-hidden flex-shrink-0">
                                <div
                                  className={pct >= 80 ? 'bg-emerald-500 h-full' : pct <= 25 ? 'bg-purple-500 h-full' : 'bg-gray-400 h-full'}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="text-xs font-mono w-16 text-right flex-shrink-0">
                                {pct}% · {v.wins}/{v.picks}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })()}

                {/* Member cuisine fingerprint — what each member tends to
                    propose. Aggregated across all options ever added; members
                    with fewer than 3 proposals are excluded server-side. */}
                {Object.keys(data.memberCuisines ?? {}).length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">What each member proposes</p>
                    <ul className="space-y-1.5">
                      {Object.entries(data.memberCuisines).map(([name, cuisines]) => (
                        <li key={name} className="flex items-center gap-2 text-sm">
                          <span className="text-gray-700 font-medium min-w-0 truncate" style={{ flex: '0 0 6rem' }}>{name}</span>
                          <div className="flex gap-1.5 flex-wrap min-w-0">
                            {cuisines.map((c) => (
                              <span
                                key={c.cuisine}
                                className="rounded-full bg-orange-50 border border-orange-100 text-orange-700 text-[11px] px-2 py-0.5"
                              >
                                {c.cuisine} <span className="font-semibold">·{c.count}</span>
                              </span>
                            ))}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )
          )}
        </div>
      )}

      {infoForId && (
        <RestaurantDetailModal
          restaurantId={Number(infoForId)}
          // Group members viewing a candidate or ballot result —
          // they have an auth session but the read-only experience
          // matches voter expectations (no Add-to-Options / Favorite
          // implicit in this context). Modal auto-fetches the row
          // from /api/restaurants/:id, no restaurantMap needed.
          readOnly
          actions={null}
          onClose={() => setInfoForId(null)}
        />
      )}
    </section>
  );
}
