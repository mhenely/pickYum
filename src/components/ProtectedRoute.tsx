import { Outlet } from 'react-router-dom';
import { useSelector } from 'react-redux';

const ProtectedRoute = () => {
  const status = useSelector((state: { auth: { status: string } }) => state.auth.status);

  if (status === 'idle' || status === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-400 text-sm animate-pulse">Loading…</div>
      </div>
    );
  }

  // Guests (unauthenticated) are allowed through — data lives only in Redux for the session.
  return <Outlet />;
};

export default ProtectedRoute;
