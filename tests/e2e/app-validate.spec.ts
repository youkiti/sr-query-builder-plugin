/**
 * #/validate 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario } from './fixtures/scenarios/fullState';

const APP_URL = '/app/app.html#/validate';

test.describe('app-validate (#/validate)', () => {
  test('formula 無し: guard プレースホルダ', async ({ page }) => {
    await injectAppStub(page, fullStateScenario({
      preloadedState: {
        ...(await import('./fixtures/scenarios/fullState')).FULL_APP_STATE,
        currentFormulaVersionId: null,
      },
    }));
    await page.goto(APP_URL);

    await expect(page.locator('#app-content .view__placeholder')).toBeVisible();
  });

  test('formula 有り: 検証ボタン・status / error 領域が並ぶ', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    const btn = page.locator('.validate__actions button');
    await expect(btn).toHaveText(/検証/);
    await expect(page.locator('.validate__status')).toHaveCount(1);
    await expect(page.locator('.validate__error')).toHaveCount(1);
    // 初期は results は空
    await expect(page.locator('.validate__results')).toBeEmpty();
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    await expect(page.locator('.validate__actions button')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
