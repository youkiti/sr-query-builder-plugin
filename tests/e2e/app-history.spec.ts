/**
 * #/history 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub, scenarioWithProject } from './fixtures/appStub';

const APP_URL = '/app/app.html#/history';

test.describe('app-history (#/history)', () => {
  test('プロジェクト未選択: guard プレースホルダ', async ({ page }) => {
    await injectAppStub(page, { authed: true });
    await page.goto(APP_URL);

    await expect(page.locator('#app-content .view__placeholder')).toBeVisible();
  });

  test('プロジェクト有り・onList 未注入: 初期スケルトンのまま（クラッシュしない）', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);

    // production 経由では onList が wiring されるが、preloaded state だけでは
    // Sheets API を経由するため route モックが無いと非同期で error へ。
    // view 自体が描画されていることだけを確認する。
    await expect(page.locator('.history__list')).toHaveCount(1);
    await expect(page.locator('.history__status')).toHaveCount(1);
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await page.goto(APP_URL);
    await expect(page.locator('.history__list')).toHaveCount(1);
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
