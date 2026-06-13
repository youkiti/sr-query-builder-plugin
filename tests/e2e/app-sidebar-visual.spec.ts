/**
 * サイドバーのビジュアル状態検証: is-active / aria-current / #app-context のライブ更新。
 *
 * docs/ui-deep-test-plan.md §Phase C 2。
 */

import { test, expect } from '@playwright/test';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario } from './fixtures/scenarios/fullState';

test.describe('app-sidebar-visual', () => {
  test('現在のルートのボタンに is-active + aria-current=page が付く', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto('/app/app.html#/draft');

    const activeBtn = page.locator('#app-sidebar nav button:has-text("検索式（生成・検証）")');
    await expect(activeBtn).toHaveAttribute('aria-current', 'page');
    await expect(activeBtn).toHaveClass(/is-active/);

    // 他ルートのボタンには aria-current が付かない
    const otherBtn = page.locator('#app-sidebar nav button:has-text("エクスポート")');
    await expect(otherBtn).not.toHaveAttribute('aria-current', 'page');
  });

  test('クリックでルート遷移 → aria-current が追従する', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto('/app/app.html#/draft');

    await page.locator('#app-sidebar nav button:has-text("エクスポート")').click();
    const nextActive = page.locator('#app-sidebar nav button:has-text("エクスポート")');
    await expect(nextActive).toHaveAttribute('aria-current', 'page');
    const prevActive = page.locator('#app-sidebar nav button:has-text("検索式（生成・検証）")');
    await expect(prevActive).not.toHaveAttribute('aria-current', 'page');
  });

  test('#app-context は aria-live=polite でルート遷移時に再描画される', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto('/app/app.html#/home');

    const ctx = page.locator('#app-context');
    await expect(ctx).toHaveAttribute('aria-live', 'polite');
    // フル state では Protocol + Formula 両方が文字列に載る
    await expect(ctx).toContainText('Protocol v1');
    await expect(ctx).toContainText('Formula');
  });

  test('#app-status は aria-live を持たない（plan §Phase C 2 の仕様）', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto('/app/app.html#/home');

    const status = page.locator('#app-status');
    await expect(status).toBeVisible();
    // aria-live は付いていない（ポライトネス通知の対象外）
    const ariaLive = await status.getAttribute('aria-live');
    expect(ariaLive).toBeNull();
  });
});
