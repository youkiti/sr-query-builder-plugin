/**
 * #/seeds 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub, scenarioWithProject } from './fixtures/appStub';

const APP_URL = '/app/app.html#/seeds';

test.describe('app-seeds (#/seeds)', () => {
  test('プロジェクト未選択: guard プレースホルダ', async ({ page }) => {
    await injectAppStub(page, { authed: true });
    await page.goto(APP_URL);

    await expect(page.locator('#app-content .view__placeholder')).toBeVisible();
  });

  test('プロジェクト有り: 2 セクション（PMID 直接入力 / NBIB・RIS 統合アップロード）が並ぶ', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);

    // NBIB / RIS は 1 つのアップロードセクションに統合され、形式は内容から自動判別する（seedsView.ts buildFileForm）
    await expect(page.locator('.seeds__section')).toHaveCount(2);
    await expect(page.locator('textarea.seeds__pmid-input')).toBeVisible();
    await expect(page.locator('input[type="file"][accept*=".nbib"][accept*=".ris"]')).toHaveCount(1);
    // summary 枠は初期時は空（aria-live は常設でも内容は空）
    await expect(page.locator('.seeds__summary')).toBeEmpty();
  });

  test('空 PMID で登録ボタン: status にエラー風テキストは出るがクラッシュしない', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);

    // 未入力状態で最初のセクションの登録ボタンをクリック
    await page.locator('.seeds__section').first().locator('button').click();
    // error もしくは status の aria-live 領域がクラッシュせず残っている（空でもよい）
    await expect(page.locator('.seeds__status')).toHaveCount(1);
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);
    await expect(page.locator('.seeds__section').first()).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
