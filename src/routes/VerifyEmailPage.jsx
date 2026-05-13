import { useEffect, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api } from '../lib/api';

const VerifyEmailPage = () => {
  const [searchParams] = useSearchParams();
  const token          = searchParams.get('token') ?? '';
  const [status, setStatus] = useState(token ? 'verifying' : 'missing');
  const [message, setMessage] = useState('');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current || !token) return;
    ran.current = true;
    api.auth.verifyEmail(token)
      .then(() => setStatus('ok'))
      .catch((err) => {
        setStatus('error');
        setMessage(err.message ?? 'This link is invalid or has expired.');
      });
  }, [token]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-white to-red-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8 text-center">
        {status === 'missing' && (
          <>
            <h1 className="text-xl font-bold text-gray-900 mb-2">Verification link missing</h1>
            <p className="text-sm text-gray-500">This page needs a token from your verification email.</p>
            <Link to="/" className="mt-6 inline-block text-sm text-orange-600 hover:underline">Go home</Link>
          </>
        )}
        {status === 'verifying' && (
          <>
            <p className="text-sm text-gray-500">Verifying your email…</p>
          </>
        )}
        {status === 'ok' && (
          <>
            <div className="text-5xl mb-3">✓</div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">Email verified</h1>
            <p className="text-sm text-gray-500">You&apos;re all set. Welcome to PickYum.</p>
            <Link to="/" className="mt-6 inline-block rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-5 py-2.5 text-sm font-semibold text-white hover:from-orange-400 hover:to-red-400 transition-all">
              Continue to PickYum
            </Link>
          </>
        )}
        {status === 'error' && (
          <>
            <h1 className="text-xl font-bold text-gray-900 mb-2">Couldn&apos;t verify</h1>
            <p className="text-sm text-red-600">{message}</p>
            <Link to="/authentication" className="mt-6 inline-block text-sm text-orange-600 hover:underline">
              Back to sign in
            </Link>
          </>
        )}
      </div>
    </div>
  );
};

export default VerifyEmailPage;
