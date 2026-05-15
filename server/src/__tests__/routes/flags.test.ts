import request from 'supertest';
import express from 'express';
import flagsRouter from '../../routes/flags';

// Minimal app — flags route is dependency-free (no auth, no DB).
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/flags', flagsRouter);
  return app;
}

describe('GET /api/flags', () => {
  it('returns the documented flag shape with default values', async () => {
    const res = await request(buildApp()).get('/api/flags');

    expect(res.status).toBe(200);
    expect(res.body.flags).toMatchObject({
      // Defaults are documented in server/src/lib/flags.ts. If a flag is
      // added there, mirror it here so this test catches drift between
      // server defaults and what the endpoint reports.
      newDetailModal: false,
      insightsOptOutVisible: true,
      backgroundRefresh: false,
      strictApiSchemaValidation: true,
    });
  });

  it('is publicly accessible (no auth required)', async () => {
    // Flag values aren't secrets — they control which UI code paths
    // are active. The endpoint is intentionally open so the React
    // bundle can read them before any login flow runs.
    const res = await request(buildApp()).get('/api/flags');
    expect(res.status).toBe(200);
  });

  it('sets a 5-minute cache header so the client can lean on its cache', async () => {
    // Flags are read once at server boot; the response is constant
    // between deploys. The Cache-Control header lets the browser
    // (and any intermediate CDN) reuse the response without bothering
    // the server.
    const res = await request(buildApp()).get('/api/flags');
    expect(res.headers['cache-control']).toContain('max-age=300');
  });
});
