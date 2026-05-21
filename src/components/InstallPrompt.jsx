// PWA install affordance. Two flavors based on what the browser
// allows:
//
//   - Chrome / Edge / desktop Chromium: the browser fires
//     `beforeinstallprompt` when it considers the page installable.
//     We capture the event and surface a real "Install" button that
//     triggers the native install dialog.
//
//   - iOS Safari: no programmatic install API exists. The user must
//     manually use Share → Add to Home Screen. We show an
//     instructional banner walking them through it.
//
//   - Already installed (running standalone): render nothing.
//
//   - Dismissed (per-device, persisted to localStorage): render
//     nothing. Re-show after 14 days so a user who dismissed during
//     onboarding gets one more nudge later.
//
// Mounted at the app root so the prompt can appear over any page.
// Self-positioned to the bottom of the viewport so it doesn't fight
// the navbar / Options banner above the fold.

import { useEffect, useState } from 'react';

const DISMISS_KEY  = 'pickyum_install_dismissed';
const DISMISS_DAYS = 14; // re-show after this many days

function isStandalone() {
  if (typeof window === 'undefined') return false;
  // iOS Safari uses non-standard navigator.standalone
  if (window.navigator.standalone) return true;
  // Everyone else uses display-mode media query
  return window.matchMedia?.('(display-mode: standalone)').matches ?? false;
}

function isIos() {
  if (typeof navigator === 'undefined') return false;
  // iPad on iPadOS 13+ reports as Mac in userAgent — check touch points
  // to distinguish a real Mac from a touchscreen iPad. Older iPad / iPhone
  // matches the /iPhone|iPad|iPod/ heuristic directly.
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return navigator.maxTouchPoints > 1 && /Macintosh/.test(ua);
}

function isIosSafari() {
  if (!isIos()) return false;
  // CriOS = Chrome on iOS, FxiOS = Firefox on iOS — they still use
  // WebKit but don't expose the Add-to-Home-Screen affordance the
  // same way. Skip the prompt for them; only stock Safari can install.
  const ua = navigator.userAgent;
  if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return false;
  return /Safari/.test(ua);
}

function isDismissed() {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const dismissedAt = parseInt(raw, 10);
    if (!Number.isFinite(dismissedAt)) return false;
    const ageDays = (Date.now() - dismissedAt) / (1000 * 60 * 60 * 24);
    return ageDays < DISMISS_DAYS;
  } catch {
    return false;
  }
}

function markDismissed() {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
}

export default function InstallPrompt() {
  const [show, setShow]                 = useState(false);
  const [mode, setMode]                 = useState('ios');
  // Stash the Chromium beforeinstallprompt event so the user-gesture
  // Install click can call .prompt() on it. Browsers gate prompt()
  // on a real interaction.
  const [installEvent, setInstallEvent] = useState(null);

  useEffect(() => {
    if (isStandalone() || isDismissed()) return undefined;

    // Path 1: Chromium fires beforeinstallprompt. Stash + show button.
    const onBeforeInstall = (e) => {
      e.preventDefault();
      setInstallEvent(e);
      setMode('chromium');
      setShow(true);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);

    // Path 2: iOS Safari. Surface the instructional banner since the
    // browser won't fire beforeinstallprompt. A short delay lets the
    // page settle before the banner slides in — less jarring than
    // appearing on first paint.
    if (isIosSafari()) {
      const t = setTimeout(() => { setMode('ios'); setShow(true); }, 1500);
      return () => {
        window.removeEventListener('beforeinstallprompt', onBeforeInstall);
        clearTimeout(t);
      };
    }
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall);
  }, []);

  if (!show) return null;

  const handleDismiss = () => {
    markDismissed();
    setShow(false);
  };

  const handleInstall = async () => {
    if (!installEvent) return;
    try {
      await installEvent.prompt();
    } catch {
      // User dismissed the native dialog — treat as a soft no, don't
      // pester them again this session.
      markDismissed();
    } finally {
      setShow(false);
      setInstallEvent(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Install pickYum"
      className="fixed bottom-4 left-4 right-4 z-40 mx-auto max-w-sm rounded-2xl border border-orange-200 bg-white shadow-xl px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <div className="text-2xl shrink-0" aria-hidden="true">🍽️</div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900 mb-0.5">Install pickYum</p>
          {mode === 'chromium' ? (
            <p className="text-xs text-gray-600 leading-snug">
              Add pickYum to your device for one-tap access and push notifications.
            </p>
          ) : (
            <p className="text-xs text-gray-600 leading-snug">
              Tap <span aria-label="share icon">⎋</span> below, then <strong>Add to Home Screen</strong> to install pickYum on this device. Unlocks browser notifications too.
            </p>
          )}
          <div className="flex items-center gap-2 mt-2">
            {mode === 'chromium' && (
              <button
                type="button"
                onClick={handleInstall}
                className="rounded-lg bg-gradient-to-br from-orange-500 to-red-500 px-3 py-1.5 text-xs font-semibold text-white shadow-brand-sm hover:from-orange-400 hover:to-red-400 transition-all"
              >
                Install
              </button>
            )}
            <button
              type="button"
              onClick={handleDismiss}
              className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
            >
              {mode === 'ios' ? 'Got it' : 'Not now'}
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss install prompt"
          className="text-gray-400 hover:text-gray-600 text-sm leading-none shrink-0"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
