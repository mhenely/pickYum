// pickYum service worker.
//
// Purpose (right now): receive Web Push messages from our backend and
// render them as native browser notifications. The SW also handles
// notification clicks so tapping a push lands the user on the right
// page even if the app tab was closed.
//
// We are NOT using this SW for caching / offline support. The app
// behaves like a regular SPA — Vite handles asset hashing, Amplify
// serves a no-cache index.html. Adding cache strategies here would
// risk users seeing stale code after deploys; not worth it for the
// current product, where push is the only thing we need a SW for.
//
// To extend: the `push` handler reads a JSON payload from the server-
// side `sendPushToUser({ title, body, url?, tag? })` helper. New
// payload fields land here (e.g. icon overrides per event type) by
// extending the showNotification options below.

self.addEventListener('install', (event) => {
  // skipWaiting → take over immediately on first install. Without
  // this the SW sits in "waiting" until every controlled page is
  // closed, which means push wouldn't work for the user who just
  // opted in until they reload. The cost is racey behavior if we
  // ever ship SW-controlled caching (we don't today).
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  // clients.claim → become the controller for any open tabs that
  // weren't controlled before. Same rationale as skipWaiting — first
  // opt-in works without a manual reload.
  event.waitUntil(self.clients.claim());
});

// Web Push event. Fires when the push service delivers a message
// from our backend. event.data is null when the server didn't ship
// a payload (rare — we always do) so we degrade gracefully to a
// generic "you have an update" notification.
self.addEventListener('push', (event) => {
  let payload = { title: 'pickYum', body: 'You have an update', url: '/' };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      // Server might have sent text instead of JSON — use it as body.
      payload.body = event.data.text();
    }
  }

  const options = {
    body: payload.body,
    // tag groups related notifications — sending another notification
    // with the same tag REPLACES this one instead of stacking. Lets
    // a chatty event series ("Bob joined the vote, then Carol…")
    // collapse into a single up-to-date entry instead of buzzing
    // the user's lock screen N times.
    tag: payload.tag,
    // Carry the click-through URL into the notification so the
    // `notificationclick` handler below can navigate to it.
    data: { url: payload.url ?? '/' },
    // requireInteraction=false (default) lets OS dismiss after a few
    // seconds. Set to true only for high-value notifications where
    // we'd rather pester the user than have them miss it — none
    // today.
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

// Click handler. The browser opens / focuses the URL the push
// payload carried — if a tab on the same origin is already open we
// focus + navigate it rather than spawning a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url ?? '/';

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Prefer an existing same-origin tab — better UX than piling up
    // multiple pickYum tabs when a user clicks several notifications.
    for (const client of allClients) {
      // `focus()` is a no-op on platforms that don't allow it from
      // a non-user-gesture; we still navigate via the URL change.
      if ('focus' in client) {
        try {
          await client.navigate(targetUrl);
          return client.focus();
        } catch {
          // Some browsers throw on navigate() when target is cross-origin
          // or restricted. Fall through to opening a new window.
        }
      }
    }
    // No existing tab → open a new one at the target URL.
    if (self.clients.openWindow) {
      return self.clients.openWindow(targetUrl);
    }
    return undefined;
  })());
});
