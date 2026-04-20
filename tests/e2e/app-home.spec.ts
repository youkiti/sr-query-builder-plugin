/**
 * #/home 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario } from './fixtures/scenarios/fullState';

const APP_URL = '/app/app.html#/home';

test.describe('app-home (#/home)', () => {
  test('プロジェクト未選択時: 起動時点のホーム文言が出ている', async ({ page }) => {
    await injectAppStub(page, { authed: true });
    await page.goto(APP_URL);

    await expect(page.locator('#app-content h2')).toHaveText('ホーム');
    await expect(page.locator('#app-content')).toContainText('プロジェクト');
  });

  test('フル state: Protocol / Formula バージョンが dl に出る', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    await expect(page.locator('#app-content h2')).toHaveText('ホーム');
    const dl = page.locator('#app-content .home__status');
    await expect(dl).toBeVisible();
    // Protocol / Formula の 2 項目（dt/dd 各 2）
    await expect(dl.locator('dt')).toHaveCount(2);
    await expect(dl.locator('dd')).toHaveCount(2);
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    await expect(page.locator('#app-content h2')).toHaveText('ホーム');
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
