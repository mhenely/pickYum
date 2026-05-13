import { test, expect } from '@playwright/test';

test.describe('Public pages load', () => {
  test('/authentication page loads without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/authentication');
    await expect(page).toHaveTitle(/pickyum/i);
    expect(errors).toHaveLength(0);
  });

  test('/auth/callback page renders without crashing', async ({ page }) => {
    // The callback page always shows a spinner until Supabase resolves;
    // navigating directly without a session shows the error state.
    await page.goto('/auth/callback');
    // Either the spinner or the error fallback is acceptable — just verify it doesn't crash
    await expect(page.locator('body')).not.toBeEmpty();
  });
});

test.describe('App shell for guests', () => {
  test('guest visit to / loads the app without redirecting to /authentication', async ({ page }) => {
    await page.goto('/');
    // Wait briefly for any async redirect that should NOT happen, then assert.
    await page.waitForTimeout(500);
    await expect(page).not.toHaveURL(/authentication/);
  });
});
