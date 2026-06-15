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
  test('formula 有り: ブロックに分解表示され、鉛筆編集 UI が出る', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    // textarea は廃止。ブロックカードで表示する
    await expect(page.locator('textarea.edit__formula')).toHaveCount(0);
    await expect(page.locator('.edit__block-list')).toBeVisible();
    await expect(page.locator('.edit__block-current').first()).toContainText(/ARDS/);
    // 編集導線は鉛筆 1 つに統一（旧「AI に改善させる」ボタンは無い）
    const firstRow = page.locator('.edit__block-row').first();
    await expect(firstRow.locator('.edit__block-edit-toggle')).toHaveCount(1);
    await expect(firstRow.locator('.edit__block-improve')).toHaveCount(0);
    // note input + スナップショット保存ボタン（「この状態を履歴に残す」）
    await expect(page.locator('input.edit__note-input')).toBeVisible();
    await expect(page.locator('.edit__actions button')).toHaveText(/履歴に残す/);
  });

  test('鉛筆でチップ編集面と AI 改善フォームが同時に開く', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    const firstRow = page.locator('.edit__block-row').first();
    await firstRow.locator('.edit__block-edit-toggle').click();
    // 主編集面は式そのものをチップ化したもの（語の削除 ✕ と「＋ 語を追加」）
    await expect(firstRow.locator('.edit__block-chips')).toBeVisible();
    await expect(firstRow.locator('.edit__chip-remove').first()).toBeVisible();
    await expect(firstRow.locator('.edit__chip-add-btn')).toBeVisible();
    // 生テキスト編集は折りたたみ「詳細編集」に退避（既定は閉じている）
    const details = firstRow.locator('details.edit__block-raw');
    await expect(details).toBeVisible();
    await expect(firstRow.locator('.edit__block-edit-input')).toBeHidden();
    await details.locator('summary').click();
    await expect(firstRow.locator('.edit__block-edit-input')).toBeVisible();
    // AI 改善フォーム
    await expect(firstRow.locator('.edit__block-ai-instruction')).toBeVisible();
    await expect(firstRow.locator('.edit__block-ai-submit')).toBeVisible();
  });

  test('フリーワードチップの ✕ で語が消える', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    const firstRow = page.locator('.edit__block-row').first();
    await firstRow.locator('.edit__block-edit-toggle').click();
    const freewordChips = firstRow.locator('.edit__chip--freeword');
    const before = await freewordChips.count();
    test.skip(before === 0, 'このブロックにフリーワードが無いシナリオ');
    await freewordChips.first().locator('.edit__chip-remove').click();
    // 再描画後、フリーワードチップが 1 つ減る
    await expect(firstRow.locator('.edit__chip--freeword')).toHaveCount(before - 1);
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    await expect(page.locator('.edit__block-list')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
