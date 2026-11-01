// tests/smoke.spec.ts — run by `databricks apps validate`. Checks only that the shell renders:
// /api/config needs no database, so this passes before the first deploy and without Lakebase access.
import { test, expect } from '@playwright/test';

test('both screens are reachable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: /Data foundation pipeline/ })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('tab', { name: /Agent Decisions/ })).toBeVisible();
});

test('phone layout shows the bottom bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Screens' });
  await expect(nav).toBeVisible({ timeout: 30000 });
  await expect(nav.getByRole('button', { name: /Decisions/ })).toBeVisible();
});
