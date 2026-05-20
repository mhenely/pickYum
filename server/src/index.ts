import 'dotenv/config';
import { createApp } from './app';
import { logger } from './lib/logger';
import { startBackgroundRefresh } from './lib/backgroundRefresh';
import { validateEnv } from './lib/validateEnv';

validateEnv();

const PORT = process.env.PORT || 3000;
const app = createApp();

app.listen(PORT, () => {
  logger.info({ port: PORT }, `Server running on http://localhost:${PORT}`);
  // Background-refresh job — gated on the FLAG_BACKGROUND_REFRESH env
  // var (default false). Schedules a daily run that pre-warms the
  // oldest stale Google-sourced rows so users don't pay the refresh
  // latency on their first open. See lib/backgroundRefresh.ts.
  startBackgroundRefresh();
});
