import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { logger } from './logger';

// No-op when SENTRY_DSN is unset — local dev and CI never report.
// All exports stay safe to call so the integration sites don't need conditionals.

let initialized = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    logger.info('SENTRY_DSN not set — error reporting disabled');
    return;
  }
  if (initialized) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    integrations: [nodeProfilingIntegration()],
    // Sample 10% of transactions in production; everything in dev/staging.
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    // Strip the cookie header from breadcrumbs/events — JWT bearer.
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers.cookie;
        delete event.request.headers.authorization;
      }
      return event;
    },
  });

  initialized = true;
  logger.info({ environment: process.env.NODE_ENV }, 'Sentry initialized');
}

export { Sentry };
