import { useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAppDispatch } from '../redux/hooks';
import { checkAuth } from '../redux/slices/authSlice';

const ResetPasswordPage = () => {
  const [searchParams]    = useSearchParams();
  const navigate          = useNavigate();
  const dispatch          = useAppDispatch();
  const token             = searchParams.get('token') ?? '';
  const [password, setPassword]               = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!token) { setError('Missing or invalid reset link.'); return; }
    if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    setLoading(true);
    setError('');
    try {
      await api.auth.resetPassword({ token, password });
      // Backend signs the user in via cookie — refresh the auth state and redirect home
      await dispatch(checkAuth());
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message ?? 'Reset failed. The link may have expired.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-white to-red-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="text-center mb-6">
            <h1 className="text-xl font-bold text-gray-900">Choose a new password</h1>
            <p className="mt-1 text-sm text-gray-500">Use at least 8 characters with a letter and a number.</p>
          </div>

          {!token ? (
            <div className="text-center">
              <p className="text-sm text-red-600">This page needs a reset link from your email.</p>
              <Link to="/forgot-password" className="mt-4 inline-block text-sm text-orange-600 hover:underline">
                Request a new link
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">New password</label>
                <input
                  type="password"
                  required
                  autoFocus
                  autoComplete="new-password"
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Confirm password</label>
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-gradient-to-br from-orange-500 to-red-500 py-2.5 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 disabled:opacity-50 transition-all"
              >
                {loading ? 'Updating…' : 'Set new password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default ResetPasswordPage;
