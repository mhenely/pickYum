import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { loginUser, registerUser } from '../redux/slices/authSlice';
import { supabase, isSupabaseConfigured } from '../lib/supabase';

const CALLBACK_URL = `${window.location.origin}/auth/callback`;

// OAuth providers — only Google is wired to Supabase now; others become active once the
// app has a permanent domain and the providers are configured in Supabase's dashboard.
const OAUTH_PROVIDERS = [
  {
    id: 'google',
    label: 'Continue with Google',
    available: true,
    icon: (
      <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
      </svg>
    ),
  },
  {
    id: 'facebook',
    label: 'Continue with Facebook',
    available: false,
    icon: (
      <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true" fill="#1877F2">
        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
      </svg>
    ),
  },
  {
    id: 'apple',
    label: 'Continue with Apple',
    available: false,
    icon: (
      <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
        <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
      </svg>
    ),
  },
  {
    id: 'github',
    label: 'Continue with GitHub',
    available: false,
    icon: (
      <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
      </svg>
    ),
  },
];

const AuthenticationPage = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const authError = useSelector((state) => state.auth.error);

  const [searchParams] = useSearchParams();
  const [oauthLoading, setOauthLoading] = useState(null); // provider id or null
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [emailMode, setEmailMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [localError, setLocalError] = useState(
    searchParams.get('error') === 'oauth_failed' ? 'Social sign-in failed. Please try again.' : ''
  );
  const [formLoading, setFormLoading] = useState(false);

  const isSignUp = emailMode === 'signup';
  const error = localError || authError;

  const handleOAuth = async (provider) => {
    if (!provider.available || !supabase) return;
    setOauthLoading(provider.id);
    setLocalError('');
    // `supabase` is now an AuthClient directly (auth-only sub-package) — no
    // `.auth.` namespace. Same `signInWithOAuth` shape, same return value.
    const { error: oauthError } = await supabase.signInWithOAuth({
      provider: provider.id,
      options: { redirectTo: CALLBACK_URL },
    });
    if (oauthError) {
      setLocalError(oauthError.message);
      setOauthLoading(null);
    }
    // On success the browser navigates away — no need to reset loading state
  };

  const switchEmailMode = (next) => {
    setEmailMode(next);
    setLocalError('');
    setEmail('');
    setUsername('');
    setPassword('');
    setConfirmPassword('');
  };

  const handleEmailSubmit = async (e) => {
    e.preventDefault();
    setLocalError('');

    if (!email || !password) { setLocalError('Please fill in all fields.'); return; }
    if (isSignUp && !username.trim()) { setLocalError('Username is required.'); return; }
    if (isSignUp && password !== confirmPassword) { setLocalError('Passwords do not match.'); return; }

    setFormLoading(true);
    try {
      const action = isSignUp
        ? await dispatch(registerUser({ email, username: username.trim(), password }))
        : await dispatch(loginUser({ email, password }));

      if (action.meta.requestStatus === 'fulfilled') {
        navigate('/', { replace: true });
      }
    } finally {
      setFormLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-orange-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-lg border border-orange-100 px-8 py-10">

          {/* Header */}
          <div className="text-center mb-8">
            <div className="flex items-center justify-center gap-2.5 mb-3">
              <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-red-500 text-2xl shadow-brand-sm select-none">🍽</span>
              <span className="font-display font-extrabold text-3xl tracking-tight bg-gradient-to-br from-orange-600 to-red-600 bg-clip-text text-transparent">pickYum</span>
            </div>
            <h2 className="text-xl font-bold tracking-tight text-gray-900">
              Welcome!
            </h2>
            <p className="mt-1 text-sm text-gray-500">Sign in or create an account to continue</p>
          </div>

          {/* Error banner */}
          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-5">
              {error}
            </p>
          )}

          {/* OAuth buttons */}
          <div className="flex flex-col gap-3">
            {OAUTH_PROVIDERS.map((provider) => {
              const active = provider.available && isSupabaseConfigured;
              return (
                <div key={provider.id}>
                  <button
                    type="button"
                    onClick={() => handleOAuth(provider)}
                    disabled={!active || oauthLoading !== null}
                    className={[
                      'flex items-center justify-center gap-3 w-full rounded-lg border px-4 py-2.5 text-sm font-medium shadow-sm transition-colors',
                      active
                        ? 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-60 disabled:cursor-not-allowed'
                        : 'border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed',
                    ].join(' ')}
                  >
                    {oauthLoading === provider.id ? (
                      <svg className="h-4 w-4 animate-spin text-gray-400" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                    ) : (
                      provider.icon
                    )}
                    {provider.label}
                    {!active && (
                      <span className="ml-auto text-xs text-gray-400 font-normal">Soon</span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>

          {/* Email form — hidden by default, toggled by the link below */}
          {showEmailForm && (
            <>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-200" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="bg-white px-3 text-gray-400">or continue with email</span>
                </div>
              </div>

              {/* Sign in / Sign up toggle */}
              <div className="flex rounded-lg bg-gray-100 p-1 mb-5">
                {['signin', 'signup'].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => switchEmailMode(m)}
                    className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${
                      emailMode === m
                        ? 'bg-white text-gray-900 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {m === 'signin' ? 'Sign in' : 'Sign up'}
                  </button>
                ))}
              </div>

              <form onSubmit={handleEmailSubmit} className="flex flex-col gap-4">
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                    Email address
                  </label>
                  <input
                    id="email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="block w-full rounded-lg border-0 py-2.5 px-3 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-orange-500 sm:text-sm"
                  />
                </div>

                {isSignUp && (
                  <div>
                    <label htmlFor="username" className="block text-sm font-medium text-gray-700 mb-1">
                      Username
                    </label>
                    <input
                      id="username"
                      type="text"
                      autoComplete="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="yourname"
                      className="block w-full rounded-lg border-0 py-2.5 px-3 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-orange-500 sm:text-sm"
                    />
                  </div>
                )}

                <div>
                  <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    autoComplete={isSignUp ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="block w-full rounded-lg border-0 py-2.5 px-3 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-orange-500 sm:text-sm"
                  />
                </div>

                {isSignUp && (
                  <div>
                    <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700 mb-1">
                      Confirm password
                    </label>
                    <input
                      id="confirm-password"
                      type="password"
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="••••••••"
                      className="block w-full rounded-lg border-0 py-2.5 px-3 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-orange-500 sm:text-sm"
                    />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={formLoading}
                  className="mt-1 w-full rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-4 py-2.5 text-sm font-semibold text-white shadow-brand-sm hover:from-orange-400 hover:to-red-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  {formLoading
                    ? (isSignUp ? 'Creating account…' : 'Signing in…')
                    : (isSignUp ? 'Create account' : 'Sign in')}
                </button>

                {!isSignUp && (
                  <div className="text-center">
                    <Link to="/forgot-password" className="text-xs text-gray-500 hover:text-orange-600 hover:underline">
                      Forgot password?
                    </Link>
                  </div>
                )}
              </form>
            </>
          )}

        </div>

        <p className="mt-6 text-center text-xs text-gray-400">
          By continuing you agree to our{' '}
          <Link to="/terms" className="hover:text-orange-600 hover:underline">Terms</Link>
          {' '}and{' '}
          <Link to="/privacy" className="hover:text-orange-600 hover:underline">Privacy Policy</Link>.
        </p>
      </div>
    </div>
  );
};

export default AuthenticationPage;
