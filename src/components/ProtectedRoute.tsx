import { Outlet } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { SkeletonDetailPage } from './Skeleton';

const ProtectedRoute = () => {
  const status = useSelector((state: { auth: { status: string } }) => state.auth.status);

  if (status === 'idle' || status === 'loading') {
    return <SkeletonDetailPage />;
  }

  // Guests (unauthenticated) are allowed through — data lives only in Redux for the session.
  return <Outlet />;
};

export default ProtectedRoute;
