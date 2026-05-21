// Frontend-side glue for the Web Push subscription handshake. Covers:
//   - Service worker registration (idempotent — safe to call on every
//     app boot; the browser returns the existing registration if
//     /sw.js was already registered)
//   - Asking the user for Notification permission at opt-in time
//   - Subscribing to the push service with our VAPID public key
//   - Pushing the new subscription to our backend so dispatch can fan
//     out to this device
//   - Checking current subscription status (used by the opt-in UI to
//     show "Enable" vs "Disable" + grey-out unsupported browsers)
//   - Unsubscribing (both browser-side and from our backend)
//
// All functions are safe to call from a browser that lacks Notification
// or PushManager support — they return `null` / `'unsupported'` so the
// UI can degrade gracefully. The most common gap today is iOS Safari
// pre-16.4 + non-PWA installs; those users see the opt-in disabled.

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const SW_URL = '/sw.js';

/** Whether this browser even supports Web Push. */
export function isPushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager'  in window
    && 'Notification' in window;
}

/** Current Notification permission, or 'unsupported' on incapable browsers. */
export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  return isPushSupported() ? Notification.permission : 'unsupported';
}

/**
 * Idempotent service-worker registration. Browsers store the registered
 * SW once installed; re-registering with the same URL is a no-op
 * (returns the existing registration). Safe to call on every app
 * boot. Returns null when the browser doesn't support service workers.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL);
  } catch {
    // Registration can fail on file://, in some private windows, or
    // when the SW file 404s. Push opt-in just stays disabled.
    return null;
  }
}

/**
 * Returns the existing PushSubscription if one is already active for
 * this browser, null otherwise. Used by the opt-in UI to render the
 * right state (enable vs disable) without re-prompting permission.
 */
export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  if (!reg) return null;
  return await reg.pushManager.getSubscription();
}

// Convert the URL-safe base64 VAPID key the backend ships into the
// Uint8Array that PushManager.subscribe expects. The browser is
// strict about this — passing the raw base64 string fails silently
// in older Chrome and throws in current Chrome. Same conversion
// every push library on npm performs; inlined to skip the dep.
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

interface SubscribeResult {
  ok:       boolean;
  /** Reason for failure, only present when !ok. */
  reason?:  'unsupported' | 'permission-denied' | 'no-vapid-key' | 'subscribe-failed' | 'server-error';
}

/**
 * End-to-end opt-in flow:
 *   1. Register the SW (if not yet)
 *   2. Request Notification permission (if not yet granted)
 *   3. Fetch the VAPID public key from our backend
 *   4. Call pushManager.subscribe(...)
 *   5. POST the new subscription to /api/notifications/subscriptions
 *
 * Designed to be called from a user gesture (a button click) since
 * browsers gate the permission prompt on user intent.
 */
export async function subscribeToPush(): Promise<SubscribeResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };

  const reg = await registerServiceWorker();
  if (!reg) return { ok: false, reason: 'unsupported' };

  // requestPermission auto-resolves to the existing value if already
  // granted/denied — calling it again doesn't re-prompt.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'permission-denied' };

  // VAPID key comes from the backend so we can rotate keys without a
  // frontend deploy. Cached briefly by the api.ts client to avoid
  // re-fetching on every opt-in attempt.
  const vapidRes = await fetch(`${BASE}/api/notifications/vapid-key`);
  const vapidJson = await vapidRes.json() as { publicKey?: string; enabled?: boolean };
  if (!vapidJson.publicKey || !vapidJson.enabled) {
    return { ok: false, reason: 'no-vapid-key' };
  }

  let subscription: PushSubscription;
  try {
    subscription = await reg.pushManager.subscribe({
      // Required: makes us promise to show a visible notification
      // for every push we receive. Browsers enforce this — silent
      // pushes get the subscription revoked.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidJson.publicKey),
    });
  } catch {
    return { ok: false, reason: 'subscribe-failed' };
  }

  // POST to our backend so this device shows up in the dispatch
  // fan-out next time someone sends this user a notification.
  const json = subscription.toJSON();
  const subRes = await fetch(`${BASE}/api/notifications/subscriptions`, {
    method:      'POST',
    credentials: 'include',
    headers:     { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint:  json.endpoint,
      keys:      json.keys,
      userAgent: navigator.userAgent,
    }),
  });
  if (!subRes.ok) {
    // Backend rejected the subscription — unsubscribe locally so
    // the next attempt can re-register cleanly instead of being
    // stuck with a subscription the server doesn't know about.
    try { await subscription.unsubscribe(); } catch { /* ignore */ }
    return { ok: false, reason: 'server-error' };
  }

  return { ok: true };
}

/**
 * Opt-out: unsubscribe locally AND tell the backend so this device
 * stops appearing in the fan-out. Tolerates failures on either side —
 * worst case the backend keeps a dead subscription, which it'll prune
 * itself on the next 410 GONE response.
 */
export async function unsubscribeFromPush(): Promise<void> {
  const subscription = await getCurrentSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  // Unsubscribe locally first — even if the backend call fails the
  // browser stops receiving pushes for this device.
  try { await subscription.unsubscribe(); } catch { /* ignore */ }
  try {
    await fetch(`${BASE}/api/notifications/subscriptions`, {
      method:      'DELETE',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ endpoint }),
    });
  } catch { /* ignore — backend cleanup on next 410 */ }
}
