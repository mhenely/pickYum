// Top-of-app banner asking unverified users to confirm their email. Tries
// /api/auth/resend-verification on demand; the server rate-limits resends
// so spam-clicking is harmless. Dismissal is per-session (sessionStorage)
// so the banner returns next time the user logs in — a stronger nudge than
// permanent dismissal without becoming annoying.

import { useState } from 'react';
import { api } from '../../lib/api';

export default function EmailVerifyBanner({ email }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem('pickyum:verify-banner-dismissed') === '1'; }
    catch { return false; }
  });
  const [sending,   setSending]   = useState(false);
  const [sent,      setSent]      = useState(false);
  const [error,     setError]     = useState('');

  if (dismissed) return null;

  const handleResend = async () => {
    setSending(true);
    setError('');
    try {
      await api.auth.resendVerification();
      setSent(true);
    } catch (err) {
      // The server returns 429 when rate-limited — surface a friendly hint.
      setError(err?.message ?? 'Could not send. Try again in a moment.');
    } finally {
      setSending(false);
    }
  };

  const handleDismiss = () => {
    try { sessionStorage.setItem('pickyum:verify-banner-dismissed', '1'); }
    catch { /* private mode, etc. — non-fatal */ }
    setDismissed(true);
  };

  return (
    <div className="bg-amber-50 border-b border-amber-200">
      <div className="mx-auto max-w-7xl px-4 py-2 sm:px-6 lg:px-8 flex items-center gap-3 flex-wrap">
        <span className="text-amber-700 text-base shrink-0" aria-hidden="true">✉️</span>
        <p className="text-xs text-amber-900 flex-1 min-w-0">
          {sent
            ? <>Verification email sent{email ? <> to <span className="font-semibold">{email}</span></> : ''}. Check your inbox.</>
            : <>Verify your email address{email ? <> (<span className="font-semibold">{email}</span>)</> : ''} to unlock account-recovery features.</>
          }
          {error && <span className="ml-2 text-red-600">{error}</span>}
        </p>
        {!sent && (
          <button
            onClick={handleResend}
            disabled={sending}
            className="text-xs font-semibold text-amber-800 hover:text-amber-900 underline disabled:opacity-40 shrink-0"
          >
            {sending ? 'Sending…' : 'Resend email'}
          </button>
        )}
        <button
          onClick={handleDismiss}
          aria-label="Dismiss"
          className="text-amber-500 hover:text-amber-700 shrink-0"
        >
          ×
        </button>
      </div>
    </div>
  );
}
