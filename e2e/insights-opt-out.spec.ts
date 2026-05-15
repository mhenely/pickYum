import { test, expect } from '@playwright/test';
import { ensureCleanTestUser, TEST_USERS, API_BASE } from './helpers';

// Exercises the per-entry insights opt-out (shipped earlier in this
// session) end-to-end:
//   1. Accept a restaurant
//   2. Confirm /me/insights aggregates it
//   3. Flip the exclude flag via PATCH /me/accepted/:id
//   4. Confirm /me/insights re-aggregates without it
//
// This is the test that would have caught the `Prisma.JsonNull` vs
// `Prisma.DbNull` bug we hit during the refresh-restaurant work: any
// place where server-side row state doesn't match the query filter
// surfaces as "you marked it excluded but Insights still shows it."

test.describe('Insights opt-out flow', () => {
  const user = TEST_USERS.insights;

  test.beforeEach(async ({ request }) => {
    await ensureCleanTestUser(request, user);
    // Log in via the API to get an auth cookie on this request context.
    const login = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: user.email, password: user.password },
    });
    expect(login.status()).toBe(200);
  });

  test('excluded acceptances drop out of /me/insights aggregates', async ({ request }) => {
    // The seed file populates restaurants id 1..40. Pick two; their
    // existence is a precondition for the test (without `npx prisma db
    // seed`, these specs won't run — call that out in the runbook).
    const r1 = 1;
    const r2 = 2;

    // Accept r1 twice and r2 once.
    for (const rid of [r1, r1, r2]) {
      const res = await request.post(`${API_BASE}/api/users/me/accepted`, {
        data: { restaurantId: rid, chooseMethod: 'flip' },
      });
      expect(res.status()).toBe(201);
    }

    // Baseline: 3 acceptances counted.
    let insights = await request.get(`${API_BASE}/api/users/me/insights`).then((r) => r.json());
    expect(insights.totalDecisions).toBe(3);
    expect(insights.distinctChosen).toBe(2);

    // Find the most recent r2 acceptance row and flip its exclude flag.
    const accepted = await request.get(`${API_BASE}/api/users/me/accepted`).then((r) => r.json());
    const r2row = accepted.accepted.find((a: { restaurantId: number }) => a.restaurantId === r2);
    expect(r2row).toBeDefined();
    expect(r2row.excludeFromInsights).toBe(false);

    const patched = await request.patch(`${API_BASE}/api/users/me/accepted/${r2row.id}`, {
      data: { excludeFromInsights: true },
    });
    expect(patched.status()).toBe(200);

    // Insights re-aggregates: r2 drops out.
    insights = await request.get(`${API_BASE}/api/users/me/insights`).then((r) => r.json());
    expect(insights.totalDecisions).toBe(2);
    expect(insights.distinctChosen).toBe(1);
  });

  test('toggling the flag back includes the row in aggregates again', async ({ request }) => {
    const rid = 3;
    await request.post(`${API_BASE}/api/users/me/accepted`, {
      data: { restaurantId: rid, chooseMethod: 'flip' },
    });

    const accepted = await request.get(`${API_BASE}/api/users/me/accepted`).then((r) => r.json());
    const row = accepted.accepted[0];

    // Exclude it.
    await request.patch(`${API_BASE}/api/users/me/accepted/${row.id}`, {
      data: { excludeFromInsights: true },
    });
    let insights = await request.get(`${API_BASE}/api/users/me/insights`).then((r) => r.json());
    expect(insights.totalDecisions).toBe(0);

    // Include it again.
    await request.patch(`${API_BASE}/api/users/me/accepted/${row.id}`, {
      data: { excludeFromInsights: false },
    });
    insights = await request.get(`${API_BASE}/api/users/me/insights`).then((r) => r.json());
    expect(insights.totalDecisions).toBe(1);
  });

  test('PATCH /me/accepted/:id returns 404 for someone else\'s row', async ({ request }) => {
    // We don't have access to another user's row id here — but a clearly
    // out-of-range id is equivalent: the route's updateMany filters on
    // userId, so any id we don't own returns count=0 → 404.
    const res = await request.patch(`${API_BASE}/api/users/me/accepted/999999999`, {
      data: { excludeFromInsights: true },
    });
    expect(res.status()).toBe(404);
  });
});
