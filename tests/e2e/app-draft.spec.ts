/**
 * #/draft 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario } from './fixtures/scenarios/fullState';

const APP_URL = '/app/app.html#/draft';

test.describe('app-draft (#/draft)', () => {
  test('既存 formula 無し相当: 「生成する」ボタンが出る', async ({ page }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: {
          ...(await import('./fixtures/scenarios/fullState')).FULL_APP_STATE,
          currentFormulaVersionId: null,
          currentFormulaMarkdown: null,
        },
      })
    );
    await page.goto(APP_URL);

    // currentFormulaVersionId が null かつ blocks 承認済みなので /draft は通る
    const btn = page.locator('.draft__actions button');
    await expect(btn).toHaveText(/生成する/);
    // 既存 formula の <pre> は出ない
    await expect(page.locator('.draft__formula')).toHaveCount(0);
  });

  test('既存 formula 有り: 「再生成する」ボタンと pre が両方出る', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    const btn = page.locator('.draft__actions button');
    await expect(btn).toHaveText(/再生成する/);
    await expect(page.locator('.draft__formula')).toBeVisible();
    await expect(page.locator('.draft__formula')).toContainText('ARDS');
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    await expect(page.locator('.draft__actions button')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
