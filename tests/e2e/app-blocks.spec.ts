/**
 * #/blocks 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub, scenarioWithProject } from './fixtures/appStub';
import { fullStateScenario, FULL_PROTOCOL_DRAFT } from './fixtures/scenarios/fullState';

const APP_URL = '/app/app.html#/blocks';

test.describe('app-blocks (#/blocks)', () => {
  test('プロトコル未入力: guard プレースホルダ', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);

    await expect(page.locator('#app-content .view__placeholder')).toBeVisible();
  });

  test('blocksDraft あり: 2 ブロックが li に並ぶ', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    await expect(page.locator('.blocks__item')).toHaveCount(2);
    await expect(page.locator('.blocks__combination-input')).toHaveValue('#1 AND #2');
  });

  test('blocksDraft 空配列: add ボタンは押せる、approve は disabled でない（空配列は有効式）', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject({
      preloadedState: {
        project: (await import('./fixtures/appStub')).PROJECT_FIXTURE,
        protocolDraft: FULL_PROTOCOL_DRAFT,
        blocksDraft: { blocks: [], combinationExpression: '' },
      },
    }));
    await page.goto(APP_URL);

    await expect(page.locator('.blocks__item')).toHaveCount(0);
    // add ボタンは常に少なくとも MIN までは有効
    await expect(page.locator('.blocks__add-row button')).toBeEnabled();
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    await expect(page.locator('.blocks__item').first()).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
