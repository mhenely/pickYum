import { logger } from './logger';

// Fail fast on missing config rather than 500-ing on the first request.
// Required everywhere; the production-only block holds vars that we tolerate
// missing in dev (sensible local defaults exist) but that silently break a
// production deploy if absent.
//
//   - CLIENT_URL: drives CORS allowlist + outbound email links. Dev
//     defaults to http://localhost:5173 (Vite).
//   - API_URL:    used in OAuth callbackURL construction. Dev falls back
//     to http://localhost:3000 in auth.ts — fine for local Passport
//     testing, fatal in prod (Google/Facebook would callback to the dev
//     port and silently fail).
//   - GOOGLE_PLACES_API_KEY: place search + nearby are core features. In
//     dev a missing key just hides the affordance; in prod a missing key
//     breaks the Search page entirely. Promoted from warn → fatal so a
//     deploy without it fails at boot, not at the first user request.
//
// Extracted from index.ts so the tests can exercise this function without
// triggering index.ts's other module-load side effects (createApp,
// startBackgroundRefresh, app.listen).
export function validateEnv(): void {
  const required = ['JWT_SECRET', 'DATABASE_URL'];
  const missing = required.filter((k) => !process.env[k]?.trim());

  const isProd = process.env.NODE_ENV === 'production';
  const requiredInProd = ['CLIENT_URL', 'API_URL', 'GOOGLE_PLACES_API_KEY'];
  if (isProd) {
    for (const k of requiredInProd) {
      if (!process.env[k]?.trim()) missing.push(k);
    }
  }

  if (missing.length > 0) {
    logger.fatal({ missing }, 'Missing required env vars at startup');
    process.exit(1);
  }

  // Warn on optional-but-recommended config so deploys don't silently lose features.
  const optional: Record<string, string> = {
    REDIS_URL: 'falling back to in-memory session store (sessions lost on restart)',
    SUPABASE_URL: 'Supabase OAuth callback disabled',
    SUPABASE_ANON_KEY: 'Supabase OAuth callback disabled',
    RESEND_API_KEY: 'transactional email disabled (verify-email / password-reset will no-op)',
    SENTRY_DSN: 'error reporting disabled',
  };
  // In dev we still want a heads-up for the now-prod-required vars when
  // they're missing — the dev fallbacks work but it's worth knowing what's
  // implicit, especially for engineers wiring up OAuth locally for the
  // first time.
  if (!isProd) {
    optional.GOOGLE_PLACES_API_KEY = 'place search/refresh disabled';
    optional.API_URL = 'OAuth callbacks falling back to http://localhost:3000';
  }
  for (const [key, consequence] of Object.entries(optional)) {
    if (!process.env[key]?.trim()) {
      logger.warn({ key }, `${key} not set — ${consequence}`);
    }
  }
}
