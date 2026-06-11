/**
 * #/export 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario } from './fixtures/scenarios/fullState';

const APP_URL = '/app/app.html#/export';

test.describe('app-export (#/export)', () => {
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

  test('formula 有り: エクスポートボタン + PubMed リンクが出る、結果はまだ空', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    await expect(page.locator('.export__actions button')).toBeVisible();
    await expect(page.locator('.export__pubmed-link a')).toHaveAttribute(
      'href',
      /pubmed\.ncbi\.nlm\.nih\.gov/
    );
    await expect(page.locator('.export__results')).toBeEmpty();
  });

  test('未変換時は done 画面相当の完了導線が export 内には無い', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    // export view 内には done のボタンは無い
    await expect(page.locator('.export__results .export__result')).toHaveCount(0);
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    await expect(page.locator('.export__actions button')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
