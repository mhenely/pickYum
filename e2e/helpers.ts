import type { APIRequestContext, Page } from '@playwright/test';

// Playwright helpers for E2E specs. Centralizes the contract with the
// __testHooks server endpoints (see server/src/routes/__testHooks.ts).
// The hooks must be enabled on the target backend (E2E_TEST_HOOKS=true).

export const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:3000';

// Dedicated test users. Each spec uses its own to allow parallelism
// later. The `.test` TLD is RFC-2606 reserved (never resolves on the
// real internet), and the hooks gate writes/reads to *@pickyum.test
// so a misconfigured prod deploy can't accidentally reset a real account.
export const TEST_USERS = {
  primary:  { email: 'e2e-primary@pickyum.test',  password: 'TestPass1234', username: 'e2e-primary' },
  lockout:  { email: 'e2e-lockout@pickyum.test',  password: 'TestPass1234', username: 'e2e-lockout' },
  insights: { email: 'e2e-insights@pickyum.test', password: 'TestPass1234', username: 'e2e-insights' },
  sync:     { email: 'e2e-sync@pickyum.test',     password: 'TestPass1234', username: 'e2e-sync' },
} as const;

export type TestUser = (typeof TEST_USERS)[keyof typeof TEST_USERS];

/**
 * Ensure a test user exists + has clean state. Call from `beforeEach`.
 * Idempotent: re-running just clears collections again.
 */
export async function ensureCleanTestUser(request: APIRequestContext, user: TestUser): Promise<void> {
  await request.post(`${API_BASE}/api/__test/ensure-user`, {
    data: { email: user.email, password: user.password, username: user.username },
  });
  await request.post(`${API_BASE}/api/__test/reset-user`, {
    data: { email: user.email },
  });
}

/**
 * Log in via the API directly (sets the auth cookie on the page's context),
 * then navigate to the target path. Bypasses the login form for specs that
 * don't specifically test login — keeps them focused on whatever behavior
 * is under test.
 */
export async function loginViaApi(page: Page, user: TestUser): Promise<void> {
  const res = await page.request.post(`${API_BASE}/api/auth/login`, {
    data: { email: user.email, password: user.password },
  });
  if (!res.ok()) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Login failed for ${user.email}: ${res.status()} ${JSON.stringify(body)}`);
  }
}

/**
 * Read a test user's server-side state — failed login count, lockout
 * timestamp, flip count. For assertions that aren't visible in the UI
 * (e.g. "did failedLoginCount actually go up after that POST?").
 */
export async function readTestUserState(request: APIRequestContext, user: TestUser) {
  const res = await request.get(`${API_BASE}/api/__test/user-state?email=${encodeURIComponent(user.email)}`);
  if (!res.ok()) throw new Error(`user-state failed: ${res.status()}`);
  const body = await res.json();
  return body.user as { id: number; failedLoginCount: number; failedLoginLockedUntil: string | null; flipCount: number };
}

export async function unlockTestUser(request: APIRequestContext, user: TestUser): Promise<void> {
  await request.post(`${API_BASE}/api/__test/unlock-user`, { data: { email: user.email } });
}
