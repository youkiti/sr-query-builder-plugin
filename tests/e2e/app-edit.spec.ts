/**
 * #/edit 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario } from './fixtures/scenarios/fullState';

const APP_URL = '/app/app.html#/edit';

test.describe('app-edit (#/edit)', () => {
  test('formula 有り: textarea に formula markdown が入り、ブロック AI 改善 UI が出る', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    await expect(page.locator('textarea.edit__formula')).toBeVisible();
    await expect(page.locator('textarea.edit__formula')).toHaveValue(/ARDS/);
    await expect(page.locator('.edit__block-list')).toBeVisible();
    // note input + 保存ボタン
    await expect(page.locator('input.edit__note-input')).toBeVisible();
    await expect(page.locator('.edit__actions button')).toHaveText(/保存/);
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    await expect(page.locator('textarea.edit__formula')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
