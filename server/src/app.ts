// Patches express.Router to forward async handler rejections to error middleware.
// Must be imported before any route definitions.
import 'express-async-errors';
// Sentry must initialize before route handlers register so its instrumentation
// can wrap the express layer. Safe to call when SENTRY_DSN is unset (no-op).
import { initSentry, Sentry } from './lib/sentry';
initSentry();

import express, { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import passport from 'passport';
import pinoHttp from 'pino-http';

import { logger } from './lib/logger';
import authRoutes from './routes/auth';
import restaurantRoutes from './routes/restaurants';
import userRoutes from './routes/users';
import placesRoutes from './routes/places';
import sessionsRoutes from './routes/sessions';
import socialRoutes from './routes/social';
import groupRoutes from './routes/groups';
import healthRoutes from './routes/health';

export function createApp() {
  const app = express();

  // Per-request structured logger; auto-correlates logs by request id.
  // Stays quiet on the SSE stream (otherwise every keepalive logs).
  app.use(pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url?.endsWith('/stream') ?? false },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  }));

  app.use(helmet());
  app.use(compression({
    filter: (req, res) => req.path.endsWith('/stream') ? false : compression.filter(req, res),
  }));
  // CLIENT_URL falls back to localhost only outside production. In production the
  // env check in index.ts has already failed if it's missing — but defend in depth.
  const clientUrl = process.env.CLIENT_URL?.trim();
  if (process.env.NODE_ENV === 'production' && !clientUrl) {
    throw new Error('CLIENT_URL must be set in production');
  }
  app.use(cors({
    origin: clientUrl || 'http://localhost:5173',
    credentials: true,
  }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(passport.initialize());

  app.use('/api/auth', authRoutes);
  app.use('/api/restaurants', restaurantRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/places', placesRoutes);
  app.use('/api/sessions', sessionsRoutes);
  app.use('/api/social', socialRoutes);
  app.use('/api/groups', groupRoutes);
  app.use('/api/health', healthRoutes);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (err?.code === 'P2003') {
      res.status(422).json({ error: 'Referenced record does not exist' });
      return;
    }
    // Capture to Sentry (no-op when DSN unset) and log structured error.
    Sentry.captureException(err, { extra: { method: req.method, path: req.path } });
    logger.error({ err, method: req.method, path: req.path }, 'unhandled server error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
