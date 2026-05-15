import { test, expect } from '@playwright/test';
import { ensureCleanTestUser, readTestUserState, unlockTestUser, TEST_USERS, API_BASE } from './helpers';

// Exercises the per-account failed-login lockout (Tier 1 #5 hardening).
//
// This is the kind of test that mocked unit tests can verify exists but
// cannot prove actually defends — only an end-to-end run against the
// real server proves the migration applied, the route reads the column,
// the bcrypt timing dummy still runs on lockout (anti-enumeration), and
// the lockout window survives.

test.describe('Per-account login lockout', () => {
  const user = TEST_USERS.lockout;

  test.beforeEach(async ({ request }) => {
    await ensureCleanTestUser(request, user);
  });

  test('locks the account after 8 consecutive wrong-password attempts', async ({ request }) => {
    // 7 wrong-password attempts — should fail but not lock.
    for (let i = 0; i < 7; i += 1) {
      const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: user.email, password: 'WrongPassword' },
      });
      expect(res.status()).toBe(401);
    }

    let state = await readTestUserState(request, user);
    expect(state.failedLoginCount).toBe(7);
    expect(state.failedLoginLockedUntil).toBeNull();

    // 8th attempt trips the lockout.
    const eighth = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: user.email, password: 'WrongPassword' },
    });
    expect(eighth.status()).toBe(401);

    state = await readTestUserState(request, user);
    expect(state.failedLoginCount).toBe(8);
    expect(state.failedLoginLockedUntil).not.toBeNull();

    // Now the CORRECT password is also rejected — the lockout is honored.
    const correctButLocked = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: user.email, password: user.password },
    });
    expect(correctButLocked.status()).toBe(401);
    // Anti-enumeration: response body must look identical to a normal
    // wrong-password rejection. If the error text hinted at lockout,
    // an attacker would know which accounts to skip.
    const body = await correctButLocked.json();
    expect(body.error).toMatch(/invalid email or password/i);
    expect(body.error).not.toMatch(/lock|attempt|too many/i);
  });

  test('a successful login clears the failure counter', async ({ request }) => {
    // 3 wrong attempts to seed some history.
    for (let i = 0; i < 3; i += 1) {
      await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: user.email, password: 'WrongPassword' },
      });
    }
    let state = await readTestUserState(request, user);
    expect(state.failedLoginCount).toBe(3);

    // Now log in with the right password.
    const ok = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: user.email, password: user.password },
    });
    expect(ok.status()).toBe(200);

    state = await readTestUserState(request, user);
    expect(state.failedLoginCount).toBe(0);
    expect(state.failedLoginLockedUntil).toBeNull();
  });

  test.afterEach(async ({ request }) => {
    // Ensure the lockout user is unlocked for the next run even if the
    // spec failed mid-way through trip-the-lockout.
    await unlockTestUser(request, user);
  });
});
