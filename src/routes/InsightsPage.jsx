import { useEffect, useState, useCallback, useRef, Fragment } from 'react';
import { Link } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { api } from '../lib/api';
import { addCustomRestaurant } from '../redux/slices/userInfoSlice';
import RestaurantDetailModal from '../components/RestaurantDetailModal';
import BallotDetailModal from '../components/BallotDetailModal';
import { SkeletonLine, SkeletonStatGrid, SkeletonList } from '../components/Skeleton';
import UserStatsPanel from '../components/UserStatsPanel';

// Stable empty-object sentinel for the useSelector fallback — without
// this, `?? {}` minted a new {} every dispatch and forced a re-render.
const EMPTY_OBJECT = Object.freeze({});

// Pretty labels for the chooseMethod enum the API returns.
const METHOD_LABELS = {
  flip:     '🪙 Coin flip',
  spin:     '🎰 Roulette',
  vote:     '🗳 Group vote',
  // 'surprise' is the persisted chooseMethod for any pick made without
  // animation — the pre-Phase-D "Surprise Me" button used it, and the
  // Phase-D "skip the spin" + 1-option "Pick this one" affordances
  // continue to. Label kept neutral so it accurately describes what
  // the user did regardless of which UI verb produced it.
  surprise: '🎲 Quick pick',
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

// Narrative subtitle for the page header. For windows with a comparable
// prior period the phrasing leans into the comparison ("vs prior month")
// so the user reads the page as "what changed" rather than "how many."
// `all` stays declarative since there's nothing to compare against.
const WINDOW_SUBTITLE = {
  all:   'lifetime',
  year:  'this year vs prior year',
  month: 'this month vs prior month',
  week:  'this week vs prior week',
};

// Human-readable label for the sparkline window. The bucket strategy is
// chosen server-side (see sparklineWindow() in users.ts); these labels
// just describe what the user is looking at.
const SPARKLINE_LABEL = {
  all:   'picks per week over the last 12 weeks',
  year:  'picks per month over the last year',
  month: 'picks per 5-day bucket over the last 30 days',
  week:  'picks per day over the last 7 days',
};

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// `onClick` makes the tile a button; the orange focus ring + hover lift
// signal that it's an interactive drill-in target. Static when no handler.
const StatTile = ({ value, label, sub, onClick, title }) => {
  if (!onClick) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-4 text-center">
        <p className="text-3xl font-black text-orange-600">{value}</p>
        <p className="text-xs font-medium text-gray-600 mt-1">{label}</p>
        {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="rounded-xl border border-gray-200 bg-white p-4 text-center transition-colors hover:border-orange-300 hover:bg-orange-50/40 focus:outline-none focus:ring-2 focus:ring-orange-300 cursor-pointer"
    >
      <p className="text-3xl font-black text-orange-600">{value}</p>
      <p className="text-xs font-medium text-gray-600 mt-1">{label}</p>
      {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
    </button>
  );
};

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

// Empty state for a brand-new user with no recorded decisions yet. Shows
// a faded "this is what you'll see" preview so the page doesn't read as
// broken — the preview tiles use sample numbers (clearly labeled) so it's
// obvious they're not real data. CTA points the user at /choose to make
// their first decision.
// One-tap decision-regret answer. `value` is the current
// wouldPickAgain field: null = unanswered, true = thumbs-up,
// false = thumbs-down. Clicking the active answer clears it
// (back to unanswered) — onChange receives the requested new
// value; the caller decides whether to apply it or toggle off.
// stopPropagation on click so the surrounding row's open-detail
// handler doesn't fire.
const RegretToggle = ({ value, onChange }) => {
  const handle = (e, requested) => {
    e.stopPropagation();
    onChange(requested);
  };
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md bg-gray-50 border border-gray-200 p-0.5">
      <button
        type="button"
        aria-label="Would pick this again"
        title="Would pick this again"
        onClick={(e) => handle(e, true)}
        className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
          value === true
            ? 'bg-emerald-500 text-white'
            : 'text-gray-400 hover:bg-emerald-50 hover:text-emerald-600'
        }`}
      >
        👍
      </button>
      <button
        type="button"
        aria-label="Would not pick this again"
        title="Would not pick this again"
        onClick={(e) => handle(e, false)}
        className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
          value === false
            ? 'bg-red-500 text-white'
            : 'text-gray-400 hover:bg-red-50 hover:text-red-600'
        }`}
      >
        👎
      </button>
    </div>
  );
};

const EmptyState = () => (
  <div className="py-8">
    <div className="text-center mb-6">
      <p className="text-5xl mb-3">📊</p>
      <p className="font-semibold text-gray-700 mb-2">No decisions yet</p>
      <p className="text-sm text-gray-500 max-w-xs mx-auto mb-5">
        Once you flip, spin, vote, or pick a restaurant, insights about your decision patterns will show up here.
      </p>
      <Link to="/choose" className="inline-block rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-5 py-2.5 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 transition-all shadow-brand-sm">
        Make a decision →
      </Link>
    </div>

    {/* Preview strip — desaturated sample tiles so the user sees the
        shape of the page they'll get. `aria-hidden` so screen readers
        skip the placeholder numbers. */}
    <div className="opacity-50 pointer-events-none select-none" aria-hidden="true">
      <p className="text-xs uppercase tracking-wider text-gray-400 text-center mb-3">
        Here's what you'll see
      </p>
      <div className="grid grid-cols-3 gap-3 mb-4">
        {[
          { value: 24, label: 'Total decisions', sub: '+18% vs prior period' },
          { value: 17, label: 'Different restaurants', sub: 'variety 71%' },
          { value: '🪙', label: 'Most-used method', sub: 'Coin flip · 12 times' },
        ].map((t) => (
          <div key={t.label} className="rounded-lg border border-gray-200 bg-white p-3 text-center">
            <p className="text-2xl font-bold text-orange-400">{t.value}</p>
            <p className="text-[11px] font-medium text-gray-500 mt-1">{t.label}</p>
            <p className="text-[10px] text-gray-400 mt-0.5">{t.sub}</p>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-gray-200 bg-white p-3">
        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Cuisine trends</p>
        {['Italian', 'Japanese', 'Mexican'].map((c, i) => (
          <div key={c} className="flex items-center justify-between gap-3 py-1 text-xs">
            <span className="text-gray-600">{c}</span>
            <svg width="80" height="14" viewBox="0 0 80 14" className="text-orange-300">
              <polyline
                fill="none" stroke="currentColor" strokeWidth="1.5"
                points={i === 0 ? '0,10 20,7 40,4 60,5 80,2' : i === 1 ? '0,8 20,9 40,6 60,4 80,5' : '0,4 20,6 40,8 60,10 80,9'}
              />
            </svg>
            <span className="text-gray-500 tabular-nums w-8 text-right">{8 - i * 2}</span>
          </div>
        ))}
      </div>
    </div>
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

  // Drill-in state: the stat tiles + "Most-used method" pill let users
  // jump to the Recent Decisions list and filter by method. Filter is
  // cleared by an explicit "× clear" affordance on the section header.
  const recentSectionRef = useRef(null);
  const [methodFilter, setMethodFilter] = useState(null);

  // Per-row expansion for the cuisine-trends table. Clicking a row's
  // trend cell swaps the inline sparkline for a larger chart with axis
  // values below the row. Only one cuisine can be expanded at a time so
  // the table doesn't grow unbounded.
  const [expandedCuisine, setExpandedCuisine] = useState(null);

  // Friend comparison — fetched lazily once on mount. Independent of
  // the `since` selector because the comparison endpoint uses its own
  // fixed one-year window. Empty array means "no friends yet"; an
  // unset value means "still loading."
  const [friendInsights, setFriendInsights] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.users.getFriendInsights()
      .then((r) => { if (!cancelled) setFriendInsights(r.friends); })
      .catch(() => { if (!cancelled) setFriendInsights([]); });
    return () => { cancelled = true; };
  }, []);
  const scrollToRecent = useCallback(() => {
    recentSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

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
        <div className="flex flex-col gap-6">
          <SkeletonStatGrid tiles={3} />
          <div className="flex flex-col gap-3">
            <SkeletonLine width="w-32" height="h-3" />
            <SkeletonList count={3} />
          </div>
          <div className="flex flex-col gap-3">
            <SkeletonLine width="w-40" height="h-3" />
            <SkeletonList count={2} />
          </div>
        </div>
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
          onClick={data.recent.length > 0 ? () => { setMethodFilter(null); scrollToRecent(); } : undefined}
          title="See your recent decisions"
        />
        <StatTile
          value={data.distinctChosen}
          label="Different restaurants"
          sub={data.varietyScore > 0 ? `variety ${data.varietyScore.toFixed(1)}/10` : "you've ended up at"}
          onClick={data.recent.length > 0 ? () => { setMethodFilter(null); scrollToRecent(); } : undefined}
          title="See your recent decisions"
        />
        <StatTile
          value={topMethodLabel}
          label="Most-used method"
          // Click filters the Recent Decisions list to this method and scrolls
          // there. Lets users verify the headline metric against the source rows.
          onClick={topMethod && data.recent.length > 0
            ? () => { setMethodFilter(topMethod[0]); scrollToRecent(); }
            : undefined}
          title={topMethod ? `Filter recent decisions to ${METHOD_LABELS[topMethod[0]] ?? topMethod[0]}` : undefined}
        />
      </div>

      {/* Regret-rate tile — surfaces the share of acceptances the user
          has flagged as "wouldn't pick again." Hidden until they've
          answered the prompt on at least 3 acceptances (small-sample
          floor enforced server-side via regretRate=null). The "—" + CTA
          variant covers the gap before that threshold so the prompt
          actually gets discovered. */}
      <div className="mb-8">
        {data.regretRate != null ? (
          <div className={`rounded-xl border p-4 flex items-center justify-between gap-3 ${
            data.regretRate >= 30
              ? 'border-red-200 bg-red-50'
              : data.regretRate >= 15
                ? 'border-amber-200 bg-amber-50'
                : 'border-emerald-200 bg-emerald-50'
          }`}>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-600 mb-0.5">Regret rate</p>
              <p className="text-2xl font-bold text-gray-900">
                {data.regretRate}<span className="text-base font-medium text-gray-500">%</span>
              </p>
              <p className="text-[11px] text-gray-500 mt-0.5">
                of {data.regretAnswered} answered acceptances you'd skip next time
              </p>
            </div>
            <button
              type="button"
              onClick={scrollToRecent}
              className="text-xs font-medium text-orange-600 hover:text-orange-700"
            >
              Review picks →
            </button>
          </div>
        ) : data.recent.length > 0 ? (
          <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-3 flex items-center justify-between gap-3">
            <p className="text-xs text-gray-500">
              Tag a few recent picks with 👍 or 👎 to start tracking regret.
            </p>
            <button
              type="button"
              onClick={scrollToRecent}
              className="text-xs font-medium text-orange-600 hover:text-orange-700"
            >
              Jump to recent →
            </button>
          </div>
        ) : null}
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
                  {/* Tooltip exposes the underlying ratio so a 100% win-rate
                      from "1 of 1" is distinguishable from a 100% "8 of 8" at
                      a glance. Same for low-sample 0%s. */}
                  <span
                    className={`font-mono ${r.winRate >= 0.5 ? 'text-green-600' : 'text-gray-400'}`}
                    title={`${r.wins} of ${r.considered} considerations`}
                  >
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
            What you think about vs. what you actually pick. The trend line shows{' '}
            {SPARKLINE_LABEL[since] ?? 'picks over the selected window'}.
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
                  const isExpanded = expandedCuisine === r.cuisine;
                  const seriesMax  = series ? Math.max(1, ...series) : 0;
                  return (
                    <Fragment key={r.cuisine}>
                      <tr className={`border-b border-gray-50 last:border-b-0 ${isExpanded ? 'bg-orange-50/40' : ''}`}>
                        <td className="px-4 py-2 font-medium text-gray-700">{r.cuisine}</td>
                        <td className="px-4 py-2 text-right font-mono text-gray-500">{r.considered}</td>
                        <td className="px-4 py-2 text-right font-mono text-orange-600 font-semibold">{r.chosen}</td>
                        <td className="px-4 py-2 text-right">
                          {series ? (
                            <button
                              type="button"
                              onClick={() => setExpandedCuisine(isExpanded ? null : r.cuisine)}
                              className="inline-flex items-center gap-1 rounded px-1 -mx-1 hover:bg-orange-100 transition-colors"
                              title={isExpanded ? 'Hide chart' : 'Expand chart'}
                            >
                              <Sparkline values={series} />
                              <span className="text-gray-400 text-[10px] leading-none">{isExpanded ? '▾' : '▸'}</span>
                            </button>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && series && (
                        <tr className="bg-orange-50/40 border-b border-gray-50">
                          <td colSpan={4} className="px-4 pt-1 pb-3">
                            {/* Expanded chart — taller SVG with bar marks + value
                                labels under each bucket so the user can read the
                                actual count rather than relative shape only.
                                Buckets are whatever the server chose (see
                                SPARKLINE_LABEL). */}
                            <p className="text-[11px] text-gray-500 mb-2">
                              {r.cuisine} · {SPARKLINE_LABEL[since] ?? 'picks over the selected window'}
                            </p>
                            <div className="flex items-end gap-1 h-20">
                              {series.map((v, i) => (
                                <div key={i} className="flex-1 flex flex-col items-center justify-end">
                                  <div
                                    className="w-full rounded-t bg-gradient-to-t from-orange-400 to-orange-300"
                                    style={{ height: `${(v / seriesMax) * 100}%`, minHeight: v > 0 ? 2 : 0 }}
                                    title={`${v} pick${v === 1 ? '' : 's'}`}
                                  />
                                  <span className="text-[9px] text-gray-400 mt-0.5">{v}</span>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
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
          its own keyboard handler.

          methodFilter (set by clicking the "Most-used method" tile above)
          narrows the list to rows where chooseMethod matches. A pill in
          the section header reflects the active filter and clears it.  */}
      {data.recent.length > 0 && (() => {
        const filteredRecent = methodFilter
          ? data.recent.filter((r) => (r.chooseMethod ?? 'unknown') === methodFilter)
          : data.recent;
        return (
        <section className="mb-4" ref={recentSectionRef}>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">Recent decisions</h2>
            {methodFilter && (
              <button
                type="button"
                onClick={() => setMethodFilter(null)}
                className="inline-flex items-center gap-1 rounded-full bg-orange-50 border border-orange-200 px-2 py-0.5 text-[11px] font-medium text-orange-700 hover:bg-orange-100"
              >
                <span>{METHOD_LABELS[methodFilter] ?? methodFilter}</span>
                <span aria-hidden="true">×</span>
                <span className="sr-only">Clear filter</span>
              </button>
            )}
          </div>
          {filteredRecent.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No recent decisions match this filter.</p>
          ) : (
          <ul className="space-y-2">
            {filteredRecent.map((r, idx) => {
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
                      <div className="flex items-center gap-2 shrink-0">
                        {/* Regret toggle. Two buttons rather than one
                            because users want to differentiate "I haven't
                            answered" from "I tried answering and clicked
                            no." Clicking the active answer again clears
                            it (back to unanswered). */}
                        <RegretToggle
                          value={r.wouldPickAgain}
                          onChange={async (next) => {
                            // Optimistic — flip locally first, refetch
                            // insights on success to pick up the new
                            // regret-rate stat.
                            const optimistic = next === r.wouldPickAgain ? null : next;
                            setData((prev) => prev && ({
                              ...prev,
                              recent: prev.recent.map((row) => row.id === r.id ? { ...row, wouldPickAgain: optimistic } : row),
                            }));
                            try {
                              await api.users.setAcceptedRegret(r.id, optimistic);
                              // Refetch only when the answer transitioned
                              // through the small-sample threshold so the
                              // headline tile re-renders. Cheap GET; cache
                              // already invalidated by the PATCH.
                              const fresh = await api.users.getInsights(since);
                              setData(fresh);
                            } catch {
                              // Roll back on failure.
                              setData((prev) => prev && ({
                                ...prev,
                                recent: prev.recent.map((row) => row.id === r.id ? { ...row, wouldPickAgain: r.wouldPickAgain } : row),
                              }));
                            }
                          }}
                        />
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
                            className="text-xs font-medium text-emerald-700 hover:text-emerald-800 underline-offset-2 hover:underline"
                          >
                            View ballot →
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          )}
        </section>
        );
      })()}

      {/* Friend comparison — only renders for users with at least one
          friend who shares cuisine history. The endpoint uses a fixed
          one-year window (separate from this page's `since` selector)
          so the comparison stays stable as the user toggles windows. */}
      {Array.isArray(friendInsights) && friendInsights.length > 0 && (
        <section className="mt-10 pt-10 border-t border-gray-200">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-1">
            Friend comparison
          </h2>
          <p className="text-xs text-gray-500 mb-4">
            Cuisine overlap with friends, based on the last 365 days.
          </p>
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 overflow-hidden bg-white">
            {friendInsights.map((f) => (
              <li key={f.id} className="flex items-start gap-3 px-4 py-3">
                <div className="h-9 w-9 rounded-full overflow-hidden bg-gradient-to-br from-orange-400 to-red-400 flex items-center justify-center text-white font-bold text-sm shrink-0">
                  {f.avatarUrl
                    ? <img src={f.avatarUrl} alt="" className="h-full w-full object-cover" />
                    : (f.username?.[0]?.toUpperCase() ?? '?')}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900">{f.username}</p>
                  {f.topShared ? (
                    <p className="text-xs text-gray-600 mt-0.5">
                      You both pick <span className="font-semibold text-orange-600">{f.topShared.cuisine}</span>
                      {' · '}
                      <span className="text-gray-500">
                        you {f.topShared.mineCount}× / them {f.topShared.theirCount}×
                        {' · '}
                        {Math.round(f.topShared.alignment * 100)}% aligned
                      </span>
                    </p>
                  ) : (
                    <p className="text-xs text-gray-400 italic mt-0.5">
                      No cuisine overlap in the last year.
                    </p>
                  )}
                  {f.theirFavorite && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      They lean into <span className="font-medium text-gray-700">{f.theirFavorite.cuisine}</span>
                      {' '}({f.theirFavorite.theirCount}× vs your {f.theirFavorite.mineCount}×)
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Top picks + indecision stats. Lives here (not Settings) because
          it's all derived from history, matching the analytics framing of
          the rest of the page. */}
      <div className="mt-10 pt-10 border-t border-gray-200">
        <UserStatsPanel />
      </div>

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
