// Admin-only operational dashboard for Google Places API spend.
// Surfaces the data captured by server/src/lib/apiUsage.ts so we can
// answer "what did this cost us, who's driving it, is the cache
// working?" without leaving the app.
//
// Auth: page is reachable to anyone via /admin/usage, but the
// underlying endpoints return 403 for non-admins. We surface the 403
// as a friendly "not authorized" message rather than a router-level
// gate so the admin role can be toggled in the DB without forcing
// a redeploy of frontend route guards.
//
// No chart libraries — the daily timeline is rendered as inline SVG
// bars so the admin page doesn't pull a 50KB recharts/visx dep into
// the rest of the bundle. Aesthetic is "Stripe dashboard" minimal,
// not "executive infographic."

import { useEffect, useState, useCallback } from 'react';
import { SkeletonLine } from '../components/Skeleton';

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

const LOOKBACKS = [
  { value:   7, label: 'Last 7 days'   },
  { value:  30, label: 'Last 30 days'  },
  { value:  90, label: 'Last 90 days'  },
  { value: 365, label: 'Last 365 days' },
];

// Cents → display $. We use 4 decimals only when total < 100¢ so a
// "tonight's bill" of 12.45¢ doesn't read as "$0.12" rounded down.
function formatDollars(cents) {
  const dollars = cents / 100;
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(4)}`;
}

function formatPercent(fraction) {
  return `${(fraction * 100).toFixed(1)}%`;
}

function formatNumber(n) {
  return n.toLocaleString();
}

// Small inline SVG bar chart for the daily timeline. Bar height
// proportional to that day's cost (relative to the max across the
// window). Days with zero usage render as a 1px floor so the user
// can still see the day exists.
function TimelineBars({ data }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(1, ...data.map((d) => d.estCostCents));
  const W = 600, H = 100, barW = Math.max(2, Math.floor(W / data.length) - 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-24" aria-label="Daily cost timeline">
      {data.map((d, i) => {
        const h = Math.max(1, Math.round((d.estCostCents / max) * (H - 4)));
        return (
          <rect
            key={d.date}
            x={i * (barW + 1)}
            y={H - h}
            width={barW}
            height={h}
            className="fill-orange-500"
          >
            <title>{`${d.date}: ${formatDollars(d.estCostCents)} (${formatNumber(d.callCount)} calls)`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

// ── Section primitives ────────────────────────────────────────────

function StatCard({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────

export default function AdminUsagePage() {
  const [lookbackDays, setLookbackDays] = useState(30);
  const [summary, setSummary] = useState(null);
  const [top, setTop] = useState([]);
  const [timeline, setTimeline] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setForbidden(false);
    try {
      const [summaryRes, topRes, dailyRes] = await Promise.all([
        fetch(`${BASE}/api/admin/usage?days=${lookbackDays}`,        { credentials: 'include' }),
        fetch(`${BASE}/api/admin/usage/top?days=${lookbackDays}`,    { credentials: 'include' }),
        fetch(`${BASE}/api/admin/usage/daily?days=${lookbackDays}`,  { credentials: 'include' }),
      ]);

      // Surface 403 specifically so the "you're not authorized" empty
      // state doesn't masquerade as a generic error.
      if (summaryRes.status === 403) {
        setForbidden(true);
        return;
      }
      if (!summaryRes.ok || !topRes.ok || !dailyRes.ok) {
        throw new Error('Failed to load usage data');
      }

      const summaryJson = await summaryRes.json();
      const topJson     = await topRes.json();
      const dailyJson   = await dailyRes.json();
      setSummary(summaryJson.summary);
      setTop(topJson.topSpenders);
      setTimeline(dailyJson.timeline);
    } catch (err) {
      setError(err.message ?? 'Could not load usage data');
    } finally {
      setLoading(false);
    }
  }, [lookbackDays]);

  useEffect(() => { load(); }, [load]);

  if (forbidden) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12 text-center">
        <p className="text-4xl mb-3" aria-hidden="true">🔒</p>
        <h1 className="text-xl font-bold text-gray-900 mb-2">Admin access required</h1>
        <p className="text-sm text-gray-500">
          This page is restricted to users with the admin role. Sign in with an admin account, or contact your ops lead if you think you should have access.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex items-start justify-between gap-3 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Google Places spend</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Operational view of API call volume, cost, and cache hit rate.
          </p>
        </div>
        <select
          value={lookbackDays}
          onChange={(e) => setLookbackDays(Number(e.target.value))}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
        >
          {LOOKBACKS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 mb-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ── Headline stat cards ───────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {loading ? (
          [0, 1, 2].map((i) => (
            <div key={i} className="rounded-xl border border-gray-200 bg-white px-5 py-4 flex flex-col gap-2">
              <SkeletonLine width="w-24" height="h-3" />
              <SkeletonLine width="w-20" height="h-6" />
            </div>
          ))
        ) : summary ? (
          <>
            <StatCard
              label="Estimated spend"
              value={formatDollars(summary.totalCostCents)}
              sub={`${summary.startDate} → ${summary.endDate}`}
            />
            <StatCard
              label="Billable calls"
              value={formatNumber(summary.totalCallCount)}
              sub={`+ ${formatNumber(summary.totalCacheHits)} served from cache`}
            />
            <StatCard
              label="Cache hit rate"
              value={formatPercent(summary.cacheHitRate)}
              sub={summary.cacheHitRate > 0.5
                ? 'cache is doing the heavy lifting'
                : 'most requests still reach Google'}
            />
          </>
        ) : null}
      </div>

      {/* ── Timeline ──────────────────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-5 mb-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Daily cost</h2>
        {loading ? (
          <div className="h-24 bg-gray-50 rounded animate-pulse" />
        ) : (
          <TimelineBars data={timeline} />
        )}
      </section>

      {/* ── Per-endpoint breakdown ────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-5 mb-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">By endpoint</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              <th className="text-left py-2">Endpoint</th>
              <th className="text-right py-2">Calls</th>
              <th className="text-right py-2">Cache hits</th>
              <th className="text-right py-2">Hit rate</th>
              <th className="text-right py-2">Cost</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              [0, 1, 2, 3, 4].map((i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="py-2" colSpan={5}><SkeletonLine height="h-3" /></td>
                </tr>
              ))
            ) : summary?.byEndpoint.map((row) => (
              <tr key={row.endpoint} className="border-t border-gray-100">
                <td className="py-2 font-medium text-gray-700">{row.endpoint}</td>
                <td className="text-right tabular-nums text-gray-700">{formatNumber(row.callCount)}</td>
                <td className="text-right tabular-nums text-gray-500">{formatNumber(row.cacheHits)}</td>
                <td className="text-right tabular-nums text-gray-500">{formatPercent(row.cacheHitRate)}</td>
                <td className="text-right tabular-nums font-semibold text-gray-900">{formatDollars(row.estCostCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ── Top spenders ──────────────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Top spenders</h2>
        {loading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3].map((i) => <SkeletonLine key={i} height="h-3" />)}
          </div>
        ) : top.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No usage recorded in this window.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                <th className="text-left py-2">User</th>
                <th className="text-right py-2">Calls</th>
                <th className="text-right py-2">Cache hits</th>
                <th className="text-right py-2">Cost</th>
              </tr>
            </thead>
            <tbody>
              {top.map((row) => (
                <tr key={row.userId} className="border-t border-gray-100">
                  <td className="py-2">
                    {row.userId === 0 ? (
                      <span className="text-gray-500 italic">anonymous (photo proxy)</span>
                    ) : row.username ? (
                      <span>
                        <span className="font-medium text-gray-700">{row.username}</span>
                        <span className="text-xs text-gray-400 ml-2">#{row.userId}</span>
                      </span>
                    ) : (
                      <span className="text-gray-500 italic">user #{row.userId} (deleted)</span>
                    )}
                  </td>
                  <td className="text-right tabular-nums text-gray-700">{formatNumber(row.callCount)}</td>
                  <td className="text-right tabular-nums text-gray-500">{formatNumber(row.cacheHits)}</td>
                  <td className="text-right tabular-nums font-semibold text-gray-900">{formatDollars(row.estCostCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
