// Sentry footprint policy
// -----------------------
// `@sentry/react` ships several integrations. Pulled in statically, they
// bloat the deferred-Sentry chunk well past 150 KB gzip — most of that is
// Replay (~75 KB gzip) and Browser Tracing (~25 KB gzip) on top of the
// ~50 KB error-reporting core. We do three things to slim it down:
//
//   1. Everything in this module is fetched via dynamic `import()` so
//      `@sentry/react` doesn't appear in the entry chunk at all. The whole
//      Sentry runtime lives in its own lazy chunk that's pulled in only
//      AFTER main.tsx defers it via `requestIdleCallback`.
//
//   2. Vite's `define` config sets `__SENTRY_TRACING__` to a build-time
//      boolean. When false (the default), Sentry's own tree-shaker drops
//      the tracing code paths — span machinery, helper functions, transport
//      overhead — typically 25-30 KB gzip.
//
//   3. Replay is only registered when `VITE_SENTRY_REPLAY === '1'`. The
//      conditional dynamic import means the Replay sub-chunk isn't fetched
//      at all when the flag is off (~75 KB gzip savings on cold load).
//
// Net: a stock prod build with no flags should land near ~50 KB gzip for
// the Sentry chunk, down from ~158 KB.
//
//   VITE_SENTRY_REPLAY=1  → enable session replay  (heaviest)
//   VITE_SENTRY_TRACES=1  → enable performance tracing

export async function initSentry(): Promise<void> {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;

  // Pulled in here, not at module top — keeps `@sentry/react` out of the
  // entry chunk entirely. Re-using the same dynamic-import URL for the
  // tracing/replay branches lets the module record cache short-circuit; the
  // second `import` is effectively free.
  const Sentry = await import('@sentry/react');

  // Build-time literals from vite.config.ts `define`. esbuild treats them
  // as constants and dead-code-eliminates the false branch entirely —
  // including the reference to `Sentry.replayIntegration` / `browserTracingIntegration`,
  // which is what lets Sentry's own tree-shaker drop the heavy integration
  // code. An env-string comparison like `import.meta.env.X === '1'` would
  // technically work too, but esbuild doesn't always reliably eliminate
  // those, especially when the comparison crosses module boundaries.
  const integrations: Parameters<typeof Sentry.init>[0]['integrations'] = [];
  if (__PICKYUM_SENTRY_TRACES__) {
    integrations.push(Sentry.browserTracingIntegration());
  }
  if (__PICKYUM_SENTRY_REPLAY__) {
    integrations.push(Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }));
  }

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
    integrations,
    // Sample rates are inert unless the matching integration is registered.
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
    replaysSessionSampleRate: import.meta.env.PROD ? 0.05 : 0,
    replaysOnErrorSampleRate: 1.0,
    // Strip auth headers / cookies from any captured fetch breadcrumbs.
    beforeSend(event) {
      if (event.request?.cookies) delete event.request.cookies;
      if (event.request?.headers) {
        delete event.request.headers.Cookie;
        delete event.request.headers.Authorization;
      }
      return event;
    },
  });
}
