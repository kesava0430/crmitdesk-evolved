import { test, expect } from '@playwright/test';
import { login } from '../helpers/auth';

test.describe('Billing', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/billing');
    await page.waitForURL(/\/billing/);
  });

  // Verifies the Billing page loads with heading
  test('billing page loads with heading', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: /billing|subscription/i })
    ).toBeVisible({ timeout: 8_000 });
  });

  // Verifies the subscription status or plan name is visible
  test('subscription status or plan name is visible', async ({ page }) => {
    await expect(
      page.getByText(/plan|subscription|starter|pro|enterprise|free|trial/i).first()
    ).toBeVisible({ timeout: 5_000 });
  });

  // Verifies an upgrade or manage button is present
  test('upgrade or manage button is visible', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: /upgrade|manage|subscribe|billing portal/i })
    ).toBeVisible({ timeout: 5_000 });
  });
});
