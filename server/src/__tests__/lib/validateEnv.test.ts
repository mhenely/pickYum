// Startup env-validation tests. The function uses `process.exit(1)` on
// missing required vars, so each test stubs that to throw instead — both
// to capture the exit signal and to keep jest from actually terminating
// the worker.

jest.mock('../../lib/logger', () => ({
  logger: { fatal: jest.fn(), warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { validateEnv } from '../../lib/validateEnv';
import { logger } from '../../lib/logger';

const REQUIRED_DEV  = ['JWT_SECRET', 'DATABASE_URL'];
const REQUIRED_PROD = ['JWT_SECRET', 'DATABASE_URL', 'CLIENT_URL', 'API_URL', 'GOOGLE_PLACES_API_KEY'];

// Snapshot the relevant env vars on first run so we can put them back
// after each test. We intentionally don't snapshot the whole process.env
// — restoring it wholesale can leak unrelated test state.
const ENV_KEYS = [
  ...REQUIRED_PROD,
  'NODE_ENV',
  'REDIS_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY',
  'RESEND_API_KEY', 'SENTRY_DSN',
];
const originalEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) originalEnv[k] = process.env[k];

function setEnv(overrides: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (k in overrides) {
      if (overrides[k] === undefined) delete process.env[k];
      else process.env[k] = overrides[k];
    } else {
      delete process.env[k];
    }
  }
}

// Stub process.exit so missing-var paths throw instead of killing the
// jest worker. The thrown error doubles as the assertion target.
class ProcessExit extends Error {
  constructor(public code: number | undefined) { super(`exit ${code}`); }
}
let exitSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExit(code);
  }) as never);
});
afterEach(() => {
  exitSpy.mockRestore();
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

describe('validateEnv — always required', () => {
  for (const key of REQUIRED_DEV) {
    it(`exits when ${key} is missing (even in dev)`, () => {
      setEnv({
        ...Object.fromEntries(REQUIRED_DEV.map((k) => [k, 'value'])),
        NODE_ENV: 'development',
        [key]: undefined,
      });
      expect(() => validateEnv()).toThrow(ProcessExit);
      // The fatal log message includes the missing keys so on-call can see
      // exactly what's wrong in CloudWatch / the boot log.
      expect(logger.fatal).toHaveBeenCalledWith(
        expect.objectContaining({ missing: expect.arrayContaining([key]) }),
        expect.stringContaining('Missing required env vars'),
      );
    });
  }
});

describe('validateEnv — production-only required', () => {
  const prodOnlyKeys = REQUIRED_PROD.filter((k) => !REQUIRED_DEV.includes(k));

  for (const key of prodOnlyKeys) {
    it(`exits when ${key} is missing in production`, () => {
      setEnv({
        ...Object.fromEntries(REQUIRED_PROD.map((k) => [k, 'value'])),
        NODE_ENV: 'production',
        [key]: undefined,
      });
      expect(() => validateEnv()).toThrow(ProcessExit);
      expect(logger.fatal).toHaveBeenCalledWith(
        expect.objectContaining({ missing: expect.arrayContaining([key]) }),
        expect.anything(),
      );
    });

    it(`only warns (does NOT exit) when ${key} is missing in dev`, () => {
      setEnv({
        ...Object.fromEntries(REQUIRED_DEV.map((k) => [k, 'value'])),
        NODE_ENV: 'development',
        [key]: undefined,
      });
      // Dev tolerates missing prod-only vars — sensible defaults exist
      // locally (CORS allows localhost:5173, OAuth callback uses
      // localhost:3000, Places API silently degrades).
      expect(() => validateEnv()).not.toThrow();
      // CLIENT_URL doesn't trip the optional-warning loop in dev — it has
      // a hardcoded dev fallback in app.ts. The other two should warn.
      if (key !== 'CLIENT_URL') {
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ key }),
          expect.stringContaining(key),
        );
      }
    });
  }

  it('reports ALL missing prod-required vars at once (not just the first)', () => {
    // Diagnosability: if a deploy is missing 3 env vars, the operator
    // should see all 3 in one fatal log entry, not have to fix one,
    // redeploy, and discover the next.
    setEnv({
      JWT_SECRET: 'set', DATABASE_URL: 'set',
      NODE_ENV: 'production',
      CLIENT_URL: undefined, API_URL: undefined, GOOGLE_PLACES_API_KEY: undefined,
    });
    expect(() => validateEnv()).toThrow(ProcessExit);
    const call = (logger.fatal as jest.Mock).mock.calls[0][0];
    expect(call.missing).toEqual(expect.arrayContaining([
      'CLIENT_URL', 'API_URL', 'GOOGLE_PLACES_API_KEY',
    ]));
  });

  it('treats whitespace-only values as missing', () => {
    setEnv({
      ...Object.fromEntries(REQUIRED_PROD.map((k) => [k, 'value'])),
      NODE_ENV: 'production',
      API_URL: '   ',
    });
    expect(() => validateEnv()).toThrow(ProcessExit);
    const call = (logger.fatal as jest.Mock).mock.calls[0][0];
    expect(call.missing).toContain('API_URL');
  });
});

describe('validateEnv — happy path', () => {
  it('does NOT exit when every required (prod) var is set', () => {
    setEnv({
      ...Object.fromEntries(REQUIRED_PROD.map((k) => [k, 'value'])),
      NODE_ENV: 'production',
    });
    expect(() => validateEnv()).not.toThrow();
    expect(logger.fatal).not.toHaveBeenCalled();
  });

  it('warns about optional integrations that are unset (Redis, Resend, Sentry, Supabase)', () => {
    setEnv({
      ...Object.fromEntries(REQUIRED_PROD.map((k) => [k, 'value'])),
      NODE_ENV: 'production',
    });
    validateEnv();
    // These are the "degrades gracefully" set — each one should produce a
    // warn line so deploys without them are visible in logs.
    for (const key of ['REDIS_URL', 'RESEND_API_KEY', 'SENTRY_DSN', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']) {
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ key }),
        expect.anything(),
      );
    }
  });
});
