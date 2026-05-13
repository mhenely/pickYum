import { test, expect } from '@playwright/test';

test.describe('Authentication page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/authentication');
  });

  test('renders the welcome heading', async ({ page }) => {
    // The visible heading is "Welcome!"; the "pickYum" branding above it is a
    // span, not a heading element.
    await expect(page.getByRole('heading', { name: /welcome/i })).toBeVisible();
  });

  test('shows the Google sign-in button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
  });

  test('email form is hidden (OAuth-only entry by design)', async ({ page }) => {
    // The email form toggle was removed — sign-in is OAuth-only at the moment.
    await expect(page.getByLabel('Email address')).not.toBeVisible();
  });
});

test.describe('Public route access (guests are allowed)', () => {
  // ProtectedRoute lets unauthenticated users through; their data lives in
  // localStorage as "guest" state for the session. There is no longer a
  // redirect to /authentication for guests.
  test('guest can visit / without being forced to /authentication', async ({ page }) => {
    await page.goto('/');
    await expect(page).not.toHaveURL(/authentication/, { timeout: 4000 });
  });

  test('guest can visit /choose/1 without being forced to /authentication', async ({ page }) => {
    await page.goto('/choose/1');
    await expect(page).not.toHaveURL(/authentication/, { timeout: 4000 });
  });
});
