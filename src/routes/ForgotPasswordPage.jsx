import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

const ForgotPasswordPage = () => {
  const [email, setEmail]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError]       = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError('');
    try {
      // Server always returns 200 to avoid leaking which emails exist —
      // we just acknowledge the request rather than confirming a match.
      await api.auth.forgotPassword(email.trim());
      setSubmitted(true);
    } catch (err) {
      setError(err.message ?? 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-white to-red-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="text-center mb-6">
            <h1 className="text-xl font-bold text-gray-900">Forgot your password?</h1>
            <p className="mt-1 text-sm text-gray-500">
              Enter the email on your account and we&apos;ll send you a reset link.
            </p>
          </div>

          {submitted ? (
            <div className="text-center">
              <p className="text-sm text-gray-700 leading-relaxed">
                If that email is registered, a reset link is on its way. Check your inbox (and spam folder) within the next few minutes.
              </p>
              <Link to="/authentication" className="mt-6 inline-block text-sm text-orange-600 hover:underline">
                ← Back to sign in
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
                <label className="block text-xs font-medium text-gray-600 mb-1">Email address</label>
                <input
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-gradient-to-br from-orange-500 to-red-500 py-2.5 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 disabled:opacity-50 transition-all"
              >
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
              <Link to="/authentication" className="block text-center text-xs text-gray-400 hover:text-gray-600">
                Back to sign in
              </Link>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default ForgotPasswordPage;
