/* eslint-disable react-refresh/only-export-components */
import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Provider } from 'react-redux';
import store from './redux/store';
import ProtectedRoute from './components/ProtectedRoute';
import { initSentry } from './lib/sentry';

import './index.css';

// Initialise observability before the app renders so early errors get captured.
initSentry();

import App from './App.tsx';
import ErrorPage from './routes/ErrorPage';

const AuthenticationPage  = lazy(() => import('./routes/AuthenticationPage'));
const ForgotPasswordPage  = lazy(() => import('./routes/ForgotPasswordPage'));
const ResetPasswordPage   = lazy(() => import('./routes/ResetPasswordPage'));
const VerifyEmailPage     = lazy(() => import('./routes/VerifyEmailPage'));
const HelpMeChoosePage    = lazy(() => import('./routes/HelpMeChoosePage'));
const HistoryPage         = lazy(() => import('./routes/HistoryPage.jsx'));
const UserInfoPage        = lazy(() => import('./routes/UserInfoPage'));
const RestaurantPage      = lazy(() => import('./routes/RestaurantPage'));
const SearchPage          = lazy(() => import('./routes/SearchPage.jsx'));
const OAuthCallbackPage   = lazy(() => import('./routes/OAuthCallbackPage'));
const AboutPage           = lazy(() => import('./routes/AboutPage'));
const GroupSessionPage    = lazy(() => import('./routes/GroupSessionPage'));
const GroupDetailPage     = lazy(() => import('./routes/GroupDetailPage'));
const SocialsPage         = lazy(() => import('./routes/SocialsPage'));
const PrivacyPage         = lazy(() => import('./routes/PrivacyPage'));
const TermsPage           = lazy(() => import('./routes/TermsPage'));

const PageFallback = <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>;

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
          { index: true, element: <Suspense fallback={PageFallback}><SearchPage /></Suspense> },
          { path: 'choose/*', element: <Suspense fallback={PageFallback}><HelpMeChoosePage /></Suspense> },
          { path: 'History/:userId', element: <Suspense fallback={PageFallback}><HistoryPage /></Suspense> },
          { path: 'userInfo/:userId', element: <Suspense fallback={PageFallback}><UserInfoPage /></Suspense> },
          { path: 'restaurant/:restaurantId?', element: <Suspense fallback={PageFallback}><RestaurantPage /></Suspense> },
          { path: 'socials', element: <Suspense fallback={PageFallback}><SocialsPage /></Suspense> },
          { path: 'groups/:id', element: <Suspense fallback={PageFallback}><GroupDetailPage /></Suspense> },
        ],
      },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>
  </React.StrictMode>
);
