import 'dotenv/config';
import { createApp } from './app';
import { logger } from './lib/logger';

// Fail fast on missing config rather than 500-ing on the first request.
// Required everywhere; CLIENT_URL is required only in production (dev defaults to localhost:5173).
function validateEnv(): void {
  const required = ['JWT_SECRET', 'DATABASE_URL'];
  const missing = required.filter((k) => !process.env[k]?.trim());

  if (process.env.NODE_ENV === 'production' && !process.env.CLIENT_URL?.trim()) {
    missing.push('CLIENT_URL');
  }

  if (missing.length > 0) {
    logger.fatal({ missing }, 'Missing required env vars at startup');
    process.exit(1);
  }

  // Warn on optional-but-recommended config so deploys don't silently lose features.
  const optional: Record<string, string> = {
    GOOGLE_PLACES_API_KEY: 'place search/refresh disabled',
    REDIS_URL: 'falling back to in-memory session store (sessions lost on restart)',
    SUPABASE_URL: 'Supabase OAuth callback disabled',
    SUPABASE_ANON_KEY: 'Supabase OAuth callback disabled',
    RESEND_API_KEY: 'transactional email disabled (verify-email / password-reset will no-op)',
    SENTRY_DSN: 'error reporting disabled',
  };
  for (const [key, consequence] of Object.entries(optional)) {
    if (!process.env[key]?.trim()) {
      logger.warn({ key }, `${key} not set — ${consequence}`);
    }
  }
}

validateEnv();

const PORT = process.env.PORT || 3000;
const app = createApp();

app.listen(PORT, () => {
  logger.info({ port: PORT }, `Server running on http://localhost:${PORT}`);
});
