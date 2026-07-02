/**
 * #/export 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario, FULL_APP_STATE } from './fixtures/scenarios/fullState';
import type { AppState } from '../../src/app/store';

const APP_URL = '/app/app.html#/export';

/** 現在バージョン（fv-20260420-01）に紐づく検証結果を組み立てる */
function validationResultWith(
  finalQuery: Partial<
    NonNullable<AppState['validationResult']>['summary']['finalQuery']
  > = {}
): NonNullable<AppState['validationResult']> {
  return {
    formulaVersionId: 'fv-20260420-01',
    summary: {
      lineHits: [],
      finalQuery: {
        finalQuery: 'q',
        totalHits: 100,
        captureRate: 1,
        capturedPmids: ['111'],
        missedPmids: [],
        ...finalQuery,
      },
      finalQueryError: null,
      mesh: [],
      meshFrequency: [],
      meshError: null,
      meshHierarchy: [],
      meshMermaid: 'flowchart TD',
      meshHierarchyError: null,
      eligibleSeedCount: 1,
      totalSeedCount: 1,
      loggedValidationIds: [],
    },
  };
}

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

  test('未検証の式では警告バナーが出るが、エクスポートはブロックされない（fix-plan 2-3）', async ({ page }) => {
    // fullStateScenario は validationResult 無し = 未検証
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    const banner = page.locator('.export__validation-warning');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('まだ検証されていません');
    await expect(page.locator('.export__actions button')).toBeEnabled();
  });

  test('捕捉率 < 100% の検証済み式では捕捉率入りの警告が出る（fix-plan 2-3）', async ({ page }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: {
          ...FULL_APP_STATE,
          validationResult: validationResultWith({
            captureRate: 0.5,
            capturedPmids: ['111'],
            missedPmids: ['222'],
          }),
        },
      })
    );
    await page.goto(APP_URL);

    const banner = page.locator('.export__validation-warning');
    await expect(banner).toContainText('50.0%');
    await expect(banner).toContainText('1/2 件');
  });

  test('現在バージョンが検証済み（捕捉率 100%）なら警告バナーは出ない（fix-plan 2-3）', async ({ page }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: {
          ...FULL_APP_STATE,
          validationResult: validationResultWith(),
        },
      })
    );
    await page.goto(APP_URL);

    await expect(page.locator('.export__actions button')).toBeVisible();
    await expect(page.locator('.export__validation-warning')).toHaveCount(0);
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    await expect(page.locator('.export__actions button')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
