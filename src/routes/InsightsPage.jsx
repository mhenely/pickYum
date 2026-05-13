import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

// Pretty labels for the chooseMethod enum the API returns.
const METHOD_LABELS = {
  flip:     '🪙 Coin flip',
  spin:     '🎰 Roulette',
  vote:     '🗳 Group vote',
  surprise: '🎲 Surprise me',
  direct:   '👉 Direct pick',
  unknown:  '— Legacy',
};

const METHOD_COLORS = {
  flip:     'bg-orange-400',
  spin:     'bg-amber-400',
  vote:     'bg-emerald-400',
  surprise: 'bg-purple-400',
  direct:   'bg-sky-400',
  unknown:  'bg-gray-300',
};

const fmtDate = (s) => new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const StatTile = ({ value, label, sub }) => (
  <div className="rounded-xl border border-gray-200 bg-white p-4 text-center">
    <p className="text-3xl font-black text-orange-600">{value}</p>
    <p className="text-xs font-medium text-gray-600 mt-1">{label}</p>
    {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
  </div>
);

const EmptyState = () => (
  <div className="text-center py-16">
    <p className="text-5xl mb-3">📊</p>
    <p className="font-semibold text-gray-700 mb-2">No decisions yet</p>
    <p className="text-sm text-gray-500 max-w-xs mx-auto mb-6">
      Once you flip, spin, vote, or pick a restaurant, insights about your decision patterns will show up here.
    </p>
    <Link to="/choose" className="inline-block rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-5 py-2.5 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 transition-all shadow-brand-sm">
      Make a decision →
    </Link>
  </div>
);

const InsightsPage = () => {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  useEffect(() => {
    let cancelled = false;
    api.users.getInsights()
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err.message ?? 'Failed to load insights'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <p className="text-center text-sm text-gray-400 py-20">Loading your decision history…</p>;
  }
  if (error) {
    return <p className="text-center text-sm text-red-500 py-20">{error}</p>;
  }
  if (!data || data.totalDecisions === 0) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Decision insights</h1>
        <EmptyState />
      </div>
    );
  }

  // Most-used method drives one of the stat tiles. Compute it once here.
  const topMethod = Object.entries(data.methodCounts ?? {})
    .sort(([, a], [, b]) => b - a)[0];
  const topMethodLabel = topMethod
    ? (METHOD_LABELS[topMethod[0]] ?? topMethod[0]).replace(/^\W+\s*/, '')
    : '—';

  // Method-bar totals (used to scale bar widths). Avoids divide-by-zero
  // when the user has zero acceptances of any single method.
  const methodTotal = Object.values(data.methodCounts ?? {}).reduce((a, b) => a + b, 0);

  const cuisineRows = (() => {
    // Merge cuisineConsidered + cuisineChosen into a unified list. Sorted by
    // total consideration so the user's "go-to" cuisines surface first.
    const all = new Set([
      ...Object.keys(data.cuisineConsidered ?? {}),
      ...Object.keys(data.cuisineChosen ?? {}),
    ]);
    return [...all]
      .map((c) => ({
        cuisine: c,
        considered: data.cuisineConsidered[c] ?? 0,
        chosen: data.cuisineChosen[c] ?? 0,
      }))
      .sort((a, b) => b.considered + b.chosen - (a.considered + a.chosen))
      .slice(0, 5);
  })();

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Decision insights</h1>
        <p className="text-sm text-gray-500 mt-0.5">How you actually choose where to eat.</p>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-3 gap-3 mb-8">
        <StatTile value={data.totalDecisions} label="Total decisions" />
        <StatTile value={data.distinctChosen} label="Different restaurants" sub="you've ended up at" />
        <StatTile value={topMethodLabel} label="Most-used method" />
      </div>

      {/* Method breakdown */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">How you decide</h2>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          {Object.entries(data.methodCounts ?? {})
            .sort(([, a], [, b]) => b - a)
            .map(([method, count]) => {
              const pct = methodTotal > 0 ? (count / methodTotal) * 100 : 0;
              return (
                <div key={method} className="flex items-center gap-3 py-1.5">
                  <span className="text-xs font-medium text-gray-700 w-32 shrink-0">
                    {METHOD_LABELS[method] ?? method}
                  </span>
                  <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                    <div
                      className={`h-2 rounded-full ${METHOD_COLORS[method] ?? 'bg-gray-300'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono text-gray-500 w-12 text-right">{count}</span>
                </div>
              );
            })}
        </div>
      </section>

      {/* Top considered */}
      {data.topConsidered.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
            Most considered
          </h2>
          <p className="text-xs text-gray-400 mb-3">
            The restaurants you most often have in the running. Win rate = times chosen / times considered.
          </p>
          <ul className="space-y-2">
            {data.topConsidered.map((r) => (
              <li key={r.restaurantId} className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 flex items-center justify-between">
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-gray-900 truncate">{r.name}</p>
                  {r.cuisineType && <p className="text-xs text-gray-400">{r.cuisineType}</p>}
                </div>
                <div className="flex items-center gap-4 shrink-0 text-xs">
                  <span className="text-gray-500">{r.considered} considered</span>
                  <span className="text-orange-600 font-semibold">{r.wins} {r.wins === 1 ? 'win' : 'wins'}</span>
                  <span className={`font-mono ${r.winRate >= 0.5 ? 'text-green-600' : 'text-gray-400'}`}>
                    {Math.round(r.winRate * 100)}%
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Often considered, never chosen */}
      {data.oftenSkipped.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
            Always added, never chosen
          </h2>
          <p className="text-xs text-gray-400 mb-3">
            Restaurants you keep putting in the running but never actually pick. Maybe time to remove them?
          </p>
          <ul className="space-y-2">
            {data.oftenSkipped.map((r) => (
              <li key={r.restaurantId} className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 flex items-center justify-between">
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-amber-900 truncate">{r.name}</p>
                  {r.cuisineType && <p className="text-xs text-amber-600">{r.cuisineType}</p>}
                </div>
                <span className="text-xs text-amber-700 shrink-0">
                  considered {r.considered} times · 0 wins
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Cuisine trends */}
      {cuisineRows.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
            Cuisine trends
          </h2>
          <p className="text-xs text-gray-400 mb-3">
            What you think about vs. what you actually pick. Gap = you talk a big game about that cuisine.
          </p>
          <div className="rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-400 uppercase tracking-wider border-b border-gray-100">
                  <th className="text-left px-4 py-2 font-medium">Cuisine</th>
                  <th className="text-right px-4 py-2 font-medium">Considered</th>
                  <th className="text-right px-4 py-2 font-medium">Chosen</th>
                </tr>
              </thead>
              <tbody>
                {cuisineRows.map((r) => (
                  <tr key={r.cuisine} className="border-b border-gray-50 last:border-b-0">
                    <td className="px-4 py-2 font-medium text-gray-700">{r.cuisine}</td>
                    <td className="px-4 py-2 text-right font-mono text-gray-500">{r.considered}</td>
                    <td className="px-4 py-2 text-right font-mono text-orange-600 font-semibold">{r.chosen}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Recent decisions */}
      {data.recent.length > 0 && (
        <section className="mb-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">Recent decisions</h2>
          <ul className="space-y-2">
            {data.recent.map((r, idx) => (
              <li key={`${r.acceptedAt}-${idx}`} className="rounded-xl border border-gray-100 bg-white px-4 py-2.5">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <p className="font-semibold text-sm text-gray-900 truncate">{r.name}</p>
                  <p className="text-xs text-gray-400 shrink-0">{fmtDate(r.acceptedAt)}</p>
                </div>
                <p className="text-xs text-gray-500">
                  {METHOD_LABELS[r.chooseMethod ?? 'unknown']}
                  {r.competing.length > 0 && ` · beat ${r.competing.slice(0, 3).join(', ')}${r.competing.length > 3 ? ` +${r.competing.length - 3}` : ''}`}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

export default InsightsPage;
