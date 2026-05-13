import * as Sentry from '@sentry/react';

// No-op when VITE_SENTRY_DSN is unset — local dev never reports.
// Called once from main.tsx before the app renders.

export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
    ],
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

export { Sentry };
