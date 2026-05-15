import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { api } from '../lib/api';
import { addCustomRestaurant } from '../redux/slices/userInfoSlice';
import RestaurantDetailModal from '../components/RestaurantDetailModal';
import BallotDetailModal from '../components/BallotDetailModal';

// Stable empty-object sentinel for the useSelector fallback — without
// this, `?? {}` minted a new {} every dispatch and forced a re-render.
const EMPTY_OBJECT = Object.freeze({});

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

// Window dropdown options. Labels are user-facing; values match the server's
// accepted `since` param.
const WINDOW_OPTIONS = [
  { value: 'all',   label: 'All time' },
  { value: 'year',  label: 'Last 365 days' },
  { value: 'month', label: 'Last 30 days' },
  { value: 'week',  label: 'Last 7 days' },
];

const WINDOW_SUBTITLE = {
  all:   'lifetime',
  year:  'in the last 365 days',
  month: 'in the last 30 days',
  week:  'in the last 7 days',
};

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const StatTile = ({ value, label, sub }) => (
  <div className="rounded-xl border border-gray-200 bg-white p-4 text-center">
    <p className="text-3xl font-black text-orange-600">{value}</p>
    <p className="text-xs font-medium text-gray-600 mt-1">{label}</p>
    {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
  </div>
);

// Reusable clickable list row used for every "restaurant in this insight" item.
// The hover + focus styling is what tells the user the row is interactive — the
// old rows looked identical to static text.
const InsightRow = ({ onClick, className = '', children }) => (
  <li>
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-xl border bg-white px-4 py-2.5 flex items-center justify-between transition-colors hover:border-orange-300 hover:bg-orange-50/40 focus:outline-none focus:ring-2 focus:ring-orange-300 ${className}`}
    >
      {children}
    </button>
  </li>
);

// 7-bar weekday distribution. Sundays-first to match getUTCDay(). The tallest
// bar gets a deeper orange so the user's "most active day" reads at a glance.
const WeekdayChart = ({ counts }) => {
  const max = Math.max(...counts, 1); // avoid divide-by-zero on empty
  const peak = counts.indexOf(max);
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-end justify-between gap-2 h-28">
        {counts.map((n, i) => {
          const heightPct = max > 0 ? (n / max) * 100 : 0;
          const isPeak = n > 0 && i === peak;
          return (
            <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1.5 h-full">
              <span className={`text-[10px] font-mono ${isPeak ? 'text-orange-600 font-semibold' : 'text-gray-400'}`}>
                {n}
              </span>
              <div
                className={`w-full rounded-t ${isPeak ? 'bg-orange-500' : 'bg-orange-200'}`}
                style={{ height: `${heightPct}%`, minHeight: n > 0 ? '4px' : '1px' }}
                aria-label={`${WEEKDAY_LABELS[i]}: ${n}`}
              />
              <span className={`text-[10px] ${isPeak ? 'text-orange-700 font-semibold' : 'text-gray-500'}`}>
                {WEEKDAY_LABELS[i]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// Tiny inline SVG sparkline. Used inside the cuisine trends table to show the
// shape of usage over the last 12 weeks at a glance. Falls back to a flat baseline
// when all values are zero to avoid a degenerate divide-by-zero in the y-scale.
const Sparkline = ({ values, width = 64, height = 18 }) => {
  if (!values || values.length === 0) return null;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => `${i * step},${height - (v / max) * (height - 2) - 1}`)
    .join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="text-orange-500">
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={points} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

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
  const dispatch = useDispatch();
  const customRestaurants = useSelector((s) => s.userInfo.customRestaurants ?? EMPTY_OBJECT);

  const [since, setSince]     = useState('all');
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  // null = closed; a string restaurantId opens RestaurantDetailModal.
  const [detailId, setDetailId] = useState(null);
  // null = closed; { groupId, eventId } opens the BallotDetailModal for a
  // past group vote referenced from the "Recent decisions" list.
  const [ballotEvent, setBallotEvent] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    api.users.getInsights(since)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err.message ?? 'Failed to load insights'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [since]);

  // Open detail modal for any restaurant row. If we don't already have the
  // restaurant in Redux (the user never favorited / optioned / accepted it —
  // possible for "considered but never chosen" entries with sparse history),
  // fetch it and seed `customRestaurants` so RestaurantDetailModal can render.
  const handleOpenDetail = useCallback(async (id) => {
    const sid = String(id);
    if (!customRestaurants[sid]) {
      try {
        const { restaurant } = await api.restaurants.get(Number(id));
        dispatch(addCustomRestaurant({
          id: sid,
          data: {
            name: restaurant.name,
            type: restaurant.cuisineType ?? 'Custom',
            price: restaurant.priceLevel ?? 1,
            rating: restaurant.googleRating != null ? Number(restaurant.googleRating) : null,
            hours:   restaurant.hours    ?? 'N/A',
            phone:   restaurant.phone    ?? 'N/A',
            website: restaurant.website  ?? 'N/A',
            yelp:    restaurant.yelpUrl  ?? 'N/A',
            takeout:  restaurant.takeout  ?? false,
            delivery: restaurant.delivery ?? false,
            googlePlaceId: restaurant.googlePlaceId ?? null,
          },
        }));
      } catch {
        // 404 / private — skip silently. Most realistic cause is that the
        // record was deleted; either way, no modal to render.
        return;
      }
    }
    setDetailId(sid);
  }, [customRestaurants, dispatch]);

  // The header + window dropdown render on every state — pulled out so the
  // loading / error / empty / populated branches stay readable.
  const WindowSelect = (
    <select
      value={since}
      onChange={(e) => setSince(e.target.value)}
      className="rounded-md border border-gray-300 bg-white pl-2.5 pr-8 py-1 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-orange-500"
    >
      {WINDOW_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );

  const PageHeader = (
    <div className="mb-6 flex items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Decision insights</h1>
        <p className="text-sm text-gray-500 mt-0.5">How you actually choose where to eat — {WINDOW_SUBTITLE[since]}.</p>
      </div>
      {WindowSelect}
    </div>
  );

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        {PageHeader}
        <p className="text-center text-sm text-gray-400 py-20">Loading your decision history…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        {PageHeader}
        <p className="text-center text-sm text-red-500 py-20">{error}</p>
      </div>
    );
  }
  if (!data || data.totalDecisions === 0) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        {PageHeader}
        {since === 'all'
          ? <EmptyState />
          : (
            <div className="text-center py-12">
              <p className="text-3xl mb-2">🕊️</p>
              <p className="text-sm text-gray-500">No decisions in this window. Try a longer one.</p>
            </div>
          )}
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

  // Weekday peak callout — small "You eat out most on Fridays" header above
  // the chart. Only meaningful if there's actually a peak (≥ 1 acceptance).
  const weekdayMax  = Math.max(...(data.weekdayCounts ?? [0]));
  const weekdayPeak = weekdayMax > 0
    ? WEEKDAY_LABELS[(data.weekdayCounts ?? []).indexOf(weekdayMax)]
    : null;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      {PageHeader}

      {/* Stat tiles. Variety is shown as a sub-label on the "Different
          restaurants" tile rather than its own tile — they're two views of
          the same underlying ratio and stacking them keeps the row compact.
          The "Total decisions" tile gains a delta sub-line when there's a
          comparable prior period (anything except `since=all`). */}
      <div className="grid grid-cols-3 gap-3 mb-8">
        <StatTile
          value={data.totalDecisions}
          label="Total decisions"
          sub={(() => {
            if (data.previousPeriodCount == null) return undefined;
            const prev = data.previousPeriodCount;
            const cur  = data.totalDecisions;
            const diff = cur - prev;
            // Symmetric copy: explicit "+/-" sign + a percentage when prior > 0,
            // and a "vs prior period" phrase that works for any window. When
            // prior was zero we just report the raw delta — percentages of zero
            // are meaningless and reading "+∞%" is a worse experience.
            if (prev === 0 && cur === 0) return 'no change vs prior period';
            if (prev === 0) return `+${cur} vs prior period`;
            const pct = Math.round((diff / prev) * 100);
            const sign = diff >= 0 ? '+' : '';
            return `${sign}${pct}% vs prior period`;
          })()}
        />
        <StatTile
          value={data.distinctChosen}
          label="Different restaurants"
          sub={data.varietyScore > 0 ? `variety ${data.varietyScore.toFixed(1)}/10` : "you've ended up at"}
        />
        <StatTile value={topMethodLabel} label="Most-used method" />
      </div>

      {/* Weekday pattern */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-1">When you decide</h2>
        <p className="text-xs text-gray-400 mb-3">
          {weekdayPeak
            ? <>You pick a restaurant most often on <strong className="text-orange-600">{weekdayPeak}</strong>.</>
            : 'Not enough data yet to spot a weekly pattern.'}
        </p>
        <WeekdayChart counts={data.weekdayCounts ?? [0, 0, 0, 0, 0, 0, 0]} />
      </section>

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
            The restaurants you most often have in the running. Click any row to see its details. Win rate = times chosen / times considered.
          </p>
          <ul className="space-y-2">
            {data.topConsidered.map((r) => (
              <InsightRow key={r.restaurantId} onClick={() => handleOpenDetail(r.restaurantId)} className="border-gray-200">
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
              </InsightRow>
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
            Restaurants you keep putting in the running but never actually pick. Tap a row to open its details and decide whether to keep it around.
          </p>
          <ul className="space-y-2">
            {data.oftenSkipped.map((r) => (
              <InsightRow
                key={r.restaurantId}
                onClick={() => handleOpenDetail(r.restaurantId)}
                className="border-amber-200 bg-amber-50 hover:bg-amber-100/60 hover:border-amber-300"
              >
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-amber-900 truncate">{r.name}</p>
                  {r.cuisineType && <p className="text-xs text-amber-600">{r.cuisineType}</p>}
                </div>
                <span className="text-xs text-amber-700 shrink-0">
                  considered {r.considered} times · 0 wins
                </span>
              </InsightRow>
            ))}
          </ul>
        </section>
      )}

      {/* Neglected favorites — favorited restaurants the user hasn't picked
          in a long while (60+ days) or ever. This list intentionally ignores
          the `since` window: "haven't been there in a while" loses meaning
          if you cap the lookback. */}
      {(data.neglectedFavorites ?? []).length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
            Remember these?
          </h2>
          <p className="text-xs text-gray-400 mb-3">
            Restaurants you favorited but haven't been to in a while. Maybe it's time again.
          </p>
          <ul className="space-y-2">
            {data.neglectedFavorites.map((r) => (
              <InsightRow
                key={r.restaurantId}
                onClick={() => handleOpenDetail(r.restaurantId)}
                className="border-rose-200 bg-rose-50 hover:bg-rose-100/60 hover:border-rose-300"
              >
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-rose-900 truncate">❤ {r.name}</p>
                  {r.cuisineType && <p className="text-xs text-rose-600">{r.cuisineType}</p>}
                </div>
                <span className="text-xs text-rose-700 shrink-0">
                  {r.lastChosenAt
                    ? `last chosen ${fmtDate(r.lastChosenAt)}`
                    : 'never chosen'}
                </span>
              </InsightRow>
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
            What you think about vs. what you actually pick. The trend line shows
            picks per week over the last 12 weeks (fixed, ignores the window above).
          </p>
          <div className="rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-400 uppercase tracking-wider border-b border-gray-100">
                  <th className="text-left px-4 py-2 font-medium">Cuisine</th>
                  <th className="text-right px-4 py-2 font-medium">Considered</th>
                  <th className="text-right px-4 py-2 font-medium">Chosen</th>
                  <th className="text-right px-4 py-2 font-medium">Trend</th>
                </tr>
              </thead>
              <tbody>
                {cuisineRows.map((r) => {
                  // Pull this cuisine's 12-week series, if any. Cuisines with no
                  // acceptances in the trend window won't have a series — render
                  // a low-key em dash so the column stays aligned.
                  const series = data.cuisineWeeklyCounts?.[r.cuisine];
                  return (
                    <tr key={r.cuisine} className="border-b border-gray-50 last:border-b-0">
                      <td className="px-4 py-2 font-medium text-gray-700">{r.cuisine}</td>
                      <td className="px-4 py-2 text-right font-mono text-gray-500">{r.considered}</td>
                      <td className="px-4 py-2 text-right font-mono text-orange-600 font-semibold">{r.chosen}</td>
                      <td className="px-4 py-2 text-right">
                        {series ? (
                          <div className="inline-flex" title={`${series.reduce((a, b) => a + b, 0)} in last 12 weeks`}>
                            <Sparkline values={series} />
                          </div>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Recent decisions.
          The outer row acts as a button (click opens the restaurant detail)
          but a "View ballot" affordance lives inside for rows that originated
          from a group vote. Since nesting a real <button> inside another
          <button> is invalid HTML, the outer is a <div role="button"> with
          its own keyboard handler. */}
      {data.recent.length > 0 && (
        <section className="mb-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">Recent decisions</h2>
          <ul className="space-y-2">
            {data.recent.map((r, idx) => {
              const hasBallot = r.chooseMethod === 'vote' && r.eventId != null && r.groupId != null;
              const openDetail = () => handleOpenDetail(r.restaurantId);
              return (
                <li key={`${r.acceptedAt}-${idx}`}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={openDetail}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(); }
                    }}
                    className="w-full text-left rounded-xl border border-gray-100 bg-white px-4 py-2.5 transition-colors hover:border-orange-300 hover:bg-orange-50/40 focus:outline-none focus:ring-2 focus:ring-orange-300 cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <p className="font-semibold text-sm text-gray-900 truncate">{r.name}</p>
                      <p className="text-xs text-gray-400 shrink-0">{fmtDate(r.acceptedAt)}</p>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-gray-500">
                        {METHOD_LABELS[r.chooseMethod ?? 'unknown']}
                        {r.competing.length > 0 && ` · beat ${r.competing.slice(0, 3).join(', ')}${r.competing.length > 3 ? ` +${r.competing.length - 3}` : ''}`}
                      </p>
                      {hasBallot && (
                        <button
                          type="button"
                          onClick={(e) => {
                            // Don't also open the restaurant detail — these
                            // two actions are mutually exclusive paths from
                            // the same row.
                            e.stopPropagation();
                            setBallotEvent({ groupId: r.groupId, eventId: r.eventId });
                          }}
                          className="shrink-0 text-xs font-medium text-emerald-700 hover:text-emerald-800 underline-offset-2 hover:underline"
                        >
                          View ballot →
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {detailId && (
        <RestaurantDetailModal
          restaurantId={detailId}
          restaurantMap={customRestaurants}
          onClose={() => setDetailId(null)}
        />
      )}

      {ballotEvent && (
        <BallotDetailModal
          groupId={ballotEvent.groupId}
          eventId={ballotEvent.eventId}
          onClose={() => setBallotEvent(null)}
        />
      )}
    </div>
  );
};

export default InsightsPage;
