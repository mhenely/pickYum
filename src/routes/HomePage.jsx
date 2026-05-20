// Root-path dispatcher: picks between the marketing LandingPage (for
// unauthenticated visitors who haven't seen the product before) and
// SearchPage (for signed-in users, the working surface). Pre-Phase-6,
// `/` always rendered SearchPage — meaning first-time visitors landed
// on a search form they couldn't act on, with no context for what
// the product even did.
//
// Auth-status gate:
//   - authenticated:    SearchPage (the working surface)
//   - unauthenticated:  LandingPage (marketing)
//   - idle / loading:   SearchPage placeholder via ProtectedRoute
//
// The ProtectedRoute wrapper handles the loading skeleton, so this
// component only needs to render one of two terminal views.

import { lazy, Suspense } from 'react';
import { useSelector } from 'react-redux';
import { SkeletonDetailPage } from '../components/Skeleton';

const LandingPage = lazy(() => import('./LandingPage'));
const SearchPage  = lazy(() => import('./SearchPage.jsx'));

export default function HomePage() {
  // Treat 'idle' / 'loading' as "not yet decided" — show the skeleton
  // instead of flashing the landing page before swapping to SearchPage
  // for already-authed users on refresh.
  const status = useSelector((s) => s.auth.status);

  if (status !== 'authenticated' && status !== 'unauthenticated') {
    return <SkeletonDetailPage />;
  }

  return (
    <Suspense fallback={<SkeletonDetailPage />}>
      {status === 'authenticated' ? <SearchPage /> : <LandingPage />}
    </Suspense>
  );
}
