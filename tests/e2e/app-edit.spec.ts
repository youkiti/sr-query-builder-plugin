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
  test('formula 有り: ブロックに分解表示され、鉛筆編集と AI 改善 UI が出る', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    // textarea は廃止。ブロックカードで表示する
    await expect(page.locator('textarea.edit__formula')).toHaveCount(0);
    await expect(page.locator('.edit__block-list')).toBeVisible();
    await expect(page.locator('.edit__block-current').first()).toContainText(/ARDS/);
    // 各ブロックに鉛筆ボタンと AI 改善ボタン
    const firstRow = page.locator('.edit__block-row').first();
    await expect(firstRow.locator('.edit__block-edit-toggle')).toHaveCount(1);
    await expect(firstRow.locator('.edit__block-improve')).toHaveCount(1);
    // note input + 保存ボタン
    await expect(page.locator('input.edit__note-input')).toBeVisible();
    await expect(page.locator('.edit__actions button')).toHaveText(/保存/);
  });

  test('AI 改善ボタンでプロンプト入力欄が開く', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    const firstRow = page.locator('.edit__block-row').first();
    await firstRow.locator('.edit__block-improve').click();
    await expect(firstRow.locator('.edit__block-ai-instruction')).toBeVisible();
    await expect(firstRow.locator('.edit__block-ai-submit')).toBeVisible();
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    await expect(page.locator('.edit__block-list')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
