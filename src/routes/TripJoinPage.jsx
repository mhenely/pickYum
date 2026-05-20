// Lands here from a shareable trip invite link like /trips/join/<token>.
// The auth gate above (ProtectedRoute) ensures the user is signed in
// before the join happens; this page just calls the join endpoint with
// the token from the URL, then navigates to the trip detail page on
// success (or back to /trips with a toast on failure).

import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { api } from '../lib/api';
import { pushToast } from '../redux/slices/toastSlice';

export default function TripJoinPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const [error, setError] = useState('');
  // StrictMode double-mounts in dev, which fires the join POST twice.
  // The server is idempotent (upsert on TripMember) so it's not a
  // correctness issue, but the double-toast is noisy — gate with a ref.
  const consumedRef = useRef(false);

  useEffect(() => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    if (!token) {
      setError('Missing invite token.');
      return;
    }
    api.trips.joinByToken(token)
      .then(({ tripId, name }) => {
        dispatch(pushToast({
          id: `joined-trip-${tripId}`,
          status: 'success',
          label: `Joined ${name}.`,
        }));
        navigate(`/trips/${tripId}`, { replace: true });
      })
      .catch((err) => {
        setError(err.message ?? 'This invite link is invalid or expired.');
      });
  }, [token, navigate, dispatch]);

  if (error) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <p className="text-3xl mb-3">🔗</p>
        <p className="font-semibold text-gray-900 mb-1">Can't open this invite</p>
        <p className="text-sm text-gray-500 mb-6">{error}</p>
        <button
          onClick={() => navigate('/trips', { replace: true })}
          className="rounded-md bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-400"
        >
          Go to your trips
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <p className="text-3xl mb-3">🔗</p>
      <p className="font-semibold text-gray-900 mb-1">Joining trip…</p>
      <p className="text-sm text-gray-500">One moment.</p>
    </div>
  );
}
