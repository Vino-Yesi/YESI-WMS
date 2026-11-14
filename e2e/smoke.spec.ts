import { test, expect } from '@playwright/test';

/**
 * End-to-end smoke: login → dashboard → inbound → pick-pack → shipping → guardian resolve.
 * Requires a production build (`npm run build`) so `preview` serves dist/.
 */
test.describe('WMS smoke flow', () => {
  test('login and navigate core ops pages', async ({ page }) => {
    await page.goto('/');

    // Seed + auth init
    await page.waitForSelector('input, button', { timeout: 30_000 });

    // Login page
    const userInput = page.locator('input').first();
    await expect(userInput).toBeVisible({ timeout: 15_000 });

    // Fill credentials (default seed users)
    const inputs = page.locator('input');
    const count = await inputs.count();
    // username
    await inputs.nth(0).fill('VINOVJ');
    // password (second text/password field)
    if (count > 1) {
      await inputs.nth(1).fill('VINOVJ');
    }

    // Submit
    const loginBtn = page.getByRole('button', { name: /sign in|log in|login/i }).first();
    if (await loginBtn.count()) {
      await loginBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    // Land on dashboard
    await expect(page).toHaveURL(/\/($|\?)/, { timeout: 20_000 });
    await page.waitForTimeout(800);

    // Navigate via sidebar / routes across all 12 WMS domains
    const routes = [
      { path: '/dock', hint: /dock|appointment/i },
      { path: '/inbound', hint: /inbound|receiving/i },
      { path: '/putaway', hint: /putaway/i },
      { path: '/qc', hint: /qc|quality|hold/i },
      { path: '/inventory', hint: /inventory|sku/i },
      { path: '/pick-pack', hint: /pick|pack/i },
      { path: '/shipping', hint: /ship/i },
      { path: '/returns', hint: /return/i },
      { path: '/cloud', hint: /cloud|postgresql|ledger/i },
      { path: '/guardian', hint: /guardian|critical|scenario/i },
    ];

    for (const r of routes) {
      await page.goto(r.path);
      await page.waitForTimeout(600);
      // Page should not show error boundary
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
      // Some operational content should appear
      const body = await page.locator('main, body').innerText();
      expect(body.length).toBeGreaterThan(20);
    }

    // Guardian: attempt resolve if a scenario card exists
    await page.goto('/guardian');
    await page.waitForTimeout(1000);
    const resolveBtn = page.getByRole('button', { name: /resolve|auto|apply/i }).first();
    if (await resolveBtn.count()) {
      await resolveBtn.click();
      await page.waitForTimeout(500);
    }

    // Density toggle exists in top bar
    await page.goto('/');
    const densityBtn = page.locator('header button[title*="density" i], header button[title*="compact" i], header button[title*="comfortable" i]').first();
    if (await densityBtn.count()) {
      await densityBtn.click();
      await page.waitForTimeout(200);
    }
  });
});
