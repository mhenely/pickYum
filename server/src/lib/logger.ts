import pino from 'pino';

// Single shared logger instance. JSON output in production for log aggregators
// (Datadog/Loki/CloudWatch); pretty-printed in dev for readability.
//
// Log level can be tuned at runtime via LOG_LEVEL env var. Defaults match
// the convention: debug in dev, info in prod, silent in test (so test output
// stays clean — explicit `pino-test` style is a future improvement).
const level = process.env.LOG_LEVEL ?? (
  process.env.NODE_ENV === 'production' ? 'info' :
  process.env.NODE_ENV === 'test'       ? 'silent' :
  'debug'
);

export const logger = pino({
  level,
  // Redact secrets — anything that looks like a token or auth header gets `[REDACTED]`
  // before it reaches stdout. Fail-safe: it's better to over-redact than to leak.
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.access_token',
      '*.refresh_token',
      '*.tokenHash',
    ],
    censor: '[REDACTED]',
  },
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    },
  }),
});
