import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import HistoryPage from './HistoryPage';
import InsightsPage from './InsightsPage';
import UserInfoPage from './UserInfoPage';

// Personal hub: Timeline (history), Insights (analytics), Settings
// (profile + dietary + push + address book + sign out + danger zone).
//
// The existing pages each read state from `useCurrentUser()` rather
// than route params, so embedding them inside this shell needs no
// adapter. Their outer max-w wrappers nest inside the YouPage shell
// without visual breakage — the inner constraint just narrows further.
//
// Imports are eager rather than lazy here because lazy() at module
// top-level inside a component file is a known React Fast Refresh foot-
// gun: each HMR tick reconstructs the lazy wrappers and the Suspense
// boundary above never resolves, leaving the page stuck on "Loading…".
// /you is already lazy-loaded from main.tsx, so the entry-chunk cost
// is unchanged — these embedded pages just join /you's chunk.

const TABS = [
  { id: 'timeline',    label: 'Timeline',    icon: '📊' },
  { id: 'insights',    label: 'Insights',    icon: '📈' },
  { id: 'preferences',     label: 'Preferences',     icon: '👤' },
  { id: 'account', label: 'Account', icon: '⚙️' },
];

const VALID_TAB_IDS = new Set(TABS.map((t) => t.id));

export default function YouPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = VALID_TAB_IDS.has(searchParams.get('tab')) ? searchParams.get('tab') : 'timeline';
  const [activeTab, setActiveTab] = useState(initialTab);

  // Mirrors the SocialsPage tab-sync pattern: preserve any other query
  // params (e.g. HistoryPage's fav=1 / archives=1 filters) while we update
  // the tab. `replace: true` keeps each tab switch from polluting browser
  // history.
  const onTabChange = (tabId) => {
    setActiveTab(tabId);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tabId === 'timeline') next.delete('tab');
      else                       next.set('tab', tabId);
      return next;
    }, { replace: true });
  };

  return (
    <div>
      <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6 lg:px-8">
        {/* Header + tab bar share one row so the page title "You" sits
            inline-left of the tab strip instead of stacked above it.
            items-end aligns the h1 baseline with the tabs' bottom edge
            so the page-level border-b underline tracks across both.
            flex-wrap lets the tabs drop to a second line on narrow
            screens. sticky top-16 keeps the whole bar pinned just below
            the navbar; the negative margins + matching px extend the
            bg-orange-50 + border-b edge-to-edge so the sticky band
            reads as a single strip rather than a constrained pill. */}
        <div className="flex items-end flex-wrap gap-x-6 gap-y-1 border-b border-gray-200 sticky top-16 bg-orange-50 z-20 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <h1 className="text-2xl font-bold text-gray-900 py-2">You</h1>
          <div className="flex gap-1 overflow-x-auto">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'border-orange-500 text-orange-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <span aria-hidden="true">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab content. UserInfoPage takes a `view` prop that selects which
          subset of sections to render so Account and Preferences share the
          page's state + handlers without duplication. Each embedded page
          brings its own outer max-w wrapper, so we don't re-wrap here. */}
      {activeTab === 'timeline'    && <HistoryPage />}
      {activeTab === 'insights'    && <InsightsPage />}
      {activeTab === 'account'     && <UserInfoPage view="account" />}
      {activeTab === 'preferences' && <UserInfoPage view="preferences" />}
    </div>
  );
}
