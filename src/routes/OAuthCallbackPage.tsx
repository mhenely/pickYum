import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { api } from '../lib/api';
import { checkAuth } from '../redux/slices/authSlice';
import { useAppDispatch } from '../redux/hooks';

export default function OAuthCallbackPage() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [error, setError] = useState('');
  const ran = useRef(false);

  useEffect(() => {
    // Strict-mode guard — run once only
    if (ran.current) return;
    ran.current = true;

    const complete = async () => {
      if (!supabase) {
        setError('Supabase is not configured. Please fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
        return;
      }
      // `supabase` is now an AuthClient (auth-only sub-package) — call
      // `getSession()` directly without the `.auth.` namespace. Behavior is
      // identical: it detects PKCE code-flow vs implicit hash-flow params.
      const { data, error: sessionError } = await supabase.getSession();

      if (sessionError || !data.session) {
        setError('Sign-in failed or was cancelled. Please try again.');
        return;
      }

      try {
        await api.auth.supabaseCallback(data.session.access_token);
        await dispatch(checkAuth());
        navigate('/', { replace: true });
      } catch (err) {
        setError((err as Error).message ?? 'Sign-in failed. Please try again.');
      }
    };

    complete();
  }, [dispatch, navigate]);

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <p className="text-red-600 text-sm mb-4">{error}</p>
          <a
            href="/authentication"
            className="text-orange-600 text-sm font-medium hover:underline"
          >
            Back to sign in
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <svg
          className="mx-auto h-8 w-8 animate-spin text-orange-600 mb-4"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        <p className="text-sm text-gray-500">Completing sign in…</p>
      </div>
    </div>
  );
}
