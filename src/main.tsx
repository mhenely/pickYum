/* eslint-disable react-refresh/only-export-components */
import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider, Navigate, useSearchParams } from 'react-router-dom';
import { Provider } from 'react-redux';
import store from './redux/store';
import ProtectedRoute from './components/ProtectedRoute';

import './index.css';

import App from './App.tsx';
import ErrorPage from './routes/ErrorPage';

const AuthenticationPage  = lazy(() => import('./routes/AuthenticationPage'));
const ForgotPasswordPage  = lazy(() => import('./routes/ForgotPasswordPage'));
const ResetPasswordPage   = lazy(() => import('./routes/ResetPasswordPage'));
const VerifyEmailPage     = lazy(() => import('./routes/VerifyEmailPage'));
const HelpMeChoosePage    = lazy(() => import('./routes/HelpMeChoosePage'));
const RestaurantPage      = lazy(() => import('./routes/RestaurantPage'));
// HomePage is the `/` dispatcher: renders LandingPage for guests and
// SearchPage for signed-in users. It lazy-loads its own children, so
// this entry chunk doesn't pull in either before the user arrives.
const HomePage            = lazy(() => import('./routes/HomePage'));
const OAuthCallbackPage   = lazy(() => import('./routes/OAuthCallbackPage'));
const AboutPage           = lazy(() => import('./routes/AboutPage'));
const GroupSessionPage    = lazy(() => import('./routes/GroupSessionPage'));
const GroupDetailPage     = lazy(() => import('./routes/GroupDetailPage'));
const SocialsPage         = lazy(() => import('./routes/SocialsPage'));
const TripDetailPage      = lazy(() => import('./routes/TripDetailPage'));
const TripJoinPage        = lazy(() => import('./routes/TripJoinPage'));
const YouPage             = lazy(() => import('./routes/YouPage.jsx'));
const PrivacyPage         = lazy(() => import('./routes/PrivacyPage'));
const TermsPage           = lazy(() => import('./routes/TermsPage'));
// Admin dashboard for ops-level visibility into Google Places spend.
// Backend gates on the `role='admin'` user column; frontend route is
// open and surfaces a "not authorized" empty state when the API
// returns 403, so the role can be toggled in the DB without redeploys.
const AdminUsagePage      = lazy(() => import('./routes/AdminUsagePage'));

const PageFallback = <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>;

// Redirect helper that forwards existing query params while injecting/replacing
// a `tab` value. Used to map the legacy per-feature routes onto the new
// consolidated /you and /socials tabbed pages without dropping user filter
// state (e.g. /History/123?fav=1 → /you?tab=timeline&fav=1).
function RedirectToTab({ to, tab }: { to: string; tab: string }) {
  const [params] = useSearchParams();
  const next = new URLSearchParams(params);
  next.set('tab', tab);
  return <Navigate to={`${to}?${next.toString()}`} replace />;
}

const router = createBrowserRouter([
  // Auth page — standalone, no navbar
  {
    path: '/authentication',
    element: <Suspense fallback={PageFallback}><AuthenticationPage /></Suspense>,
  },
  // Password reset request form
  {
    path: '/forgot-password',
    element: <Suspense fallback={PageFallback}><ForgotPasswordPage /></Suspense>,
  },
  // Password reset — landed from email link with ?token=…
  {
    path: '/reset-password',
    element: <Suspense fallback={PageFallback}><ResetPasswordPage /></Suspense>,
  },
  // Email verification — landed from email link with ?token=…
  {
    path: '/verify-email',
    element: <Suspense fallback={PageFallback}><VerifyEmailPage /></Suspense>,
  },
  // Group session — standalone, no navbar, no auth required
  {
    path: '/vote/:sessionId',
    element: <Suspense fallback={PageFallback}><GroupSessionPage /></Suspense>,
  },
  // Supabase OAuth redirect lands here
  {
    path: '/auth/callback',
    element: <Suspense fallback={PageFallback}><OAuthCallbackPage /></Suspense>,
  },
  // All other routes — wrapped in the navbar layout
  {
    path: '/',
    element: <App />,
    errorElement: <ErrorPage />,
    children: [
      { path: 'about', element: <Suspense fallback={PageFallback}><AboutPage /></Suspense> },
      { path: 'privacy', element: <Suspense fallback={PageFallback}><PrivacyPage /></Suspense> },
      { path: 'terms', element: <Suspense fallback={PageFallback}><TermsPage /></Suspense> },
      {
        element: <ProtectedRoute />,
        children: [
          // HomePage picks between LandingPage (guests) and SearchPage
          // (signed-in). Keeping it inside ProtectedRoute leaves the
          // shared "auth-resolving" skeleton in one place.
          { index: true, element: <Suspense fallback={PageFallback}><HomePage /></Suspense> },
          { path: 'choose/*', element: <Suspense fallback={PageFallback}><HelpMeChoosePage /></Suspense> },
          // Consolidated personal hub. The three legacy routes below
          // (History, userInfo, insights) redirect into the matching
          // tab here so old bookmarks and shared links still land somewhere
          // sensible. Filter query params (HistoryPage's fav/archives/method)
          // ride through via RedirectToTab.
          { path: 'you', element: <Suspense fallback={PageFallback}><YouPage /></Suspense> },
          { path: 'History/:userId',  element: <RedirectToTab to="/you"      tab="timeline" /> },
          { path: 'userInfo/:userId', element: <RedirectToTab to="/you"      tab="account" /> },
          { path: 'insights',         element: <RedirectToTab to="/you"      tab="insights" /> },
          { path: 'restaurant/:restaurantId?', element: <Suspense fallback={PageFallback}><RestaurantPage /></Suspense> },
          { path: 'socials', element: <Suspense fallback={PageFallback}><SocialsPage /></Suspense> },
          { path: 'groups/:id', element: <Suspense fallback={PageFallback}><GroupDetailPage /></Suspense> },
          // /trips redirects into the Social page's Trips tab; the
          // per-trip detail + join routes below stay standalone.
          { path: 'trips',           element: <RedirectToTab to="/socials" tab="trips" /> },
          // Order matters — `:id` is greedy, so the more specific
          // `trips/join/:token` must come first or it gets shadowed.
          { path: 'trips/join/:token', element: <Suspense fallback={PageFallback}><TripJoinPage /></Suspense> },
          { path: 'trips/:id',       element: <Suspense fallback={PageFallback}><TripDetailPage /></Suspense> },
          // Admin-only dashboards. The route itself is unconditionally
          // mounted; the page handles 403 from the backend by rendering
          // a friendly "not authorized" state, so non-admins navigating
          // here don't crash, they just see a closed-door message.
          { path: 'admin/usage',     element: <Suspense fallback={PageFallback}><AdminUsagePage /></Suspense> },
        ],
      },
    ],
  },
], {
  // Opt into React Router v7's upcoming router-level behaviors early.
  // Eliminates "Future Flag Warning" dev-console noise + smooths the
  // eventual v7 upgrade.
  //
  // In react-router-dom 6.x the flags are split between two
  // components: the router-creation function takes the @remix-run/router
  // flags (below), and <RouterProvider future={...}> takes the
  // framework-level flags like `v7_startTransition`. Both are needed
  // to silence all the warnings.
  //
  //   v7_relativeSplatPath: tightens relative path resolution inside
  //     splat routes. We don't use splat routes today, so this is
  //     a no-op now and a safe pre-opt.
  future: {
    v7_relativeSplatPath: true,
  },
});

// Framework-level future flags — the type lives on RouterProviderProps,
// distinct from the router-creation options above. `v7_startTransition`
// wraps internal state updates in React.startTransition so navigations
// don't block urgent renders. Behavior-compatible for our pages — no
// synchronous patterns rely on the legacy semantics.
const ROUTER_FUTURE_FLAGS = { v7_startTransition: true } as const;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <RouterProvider router={router} future={ROUTER_FUTURE_FLAGS} />
    </Provider>
  </React.StrictMode>
);

// Lazy-load and initialize Sentry AFTER the first render. The Sentry SDK
// is ~30-50 KB gzipped and was previously eager-imported in this entry
// chunk, blocking first paint. Pre-mount errors during the brief window
// before init lands will still surface via the browser's default
// onerror/onunhandledrejection — Sentry just won't tag them with replay
// context. That's an acceptable trade for a snappier load.
//
// requestIdleCallback runs when the browser is idle; setTimeout is the
// fallback (Safari/iOS have lagging rIC support as of mid-2026).
const initObservability = () => {
  import('./lib/sentry').then((m) => m.initSentry()).catch(() => {
    // Non-fatal — app still works without observability.
  });
};
if (typeof window !== 'undefined') {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(initObservability, { timeout: 2000 });
  } else {
    setTimeout(initObservability, 100);
  }
}
