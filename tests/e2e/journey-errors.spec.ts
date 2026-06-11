/**
 * J5: エラー復帰の網（popup / app レイヤ）。
 * docs/ui-deep-test-plan.md §Phase E。
 */

import { test, expect } from '@playwright/test';
import { injectChromeStub } from './fixtures/chromeStub';

test.describe('journey-errors (J5, popup レイヤ)', () => {
  test('OAuth 失効: authed=false で popup 起動 → login ボタンが見える', async ({ page }) => {
    await injectChromeStub(page, { authed: false, email: '', recent: [] });
    await page.goto('/popup/popup.html');

    await expect(page.locator('#login-button')).toBeVisible();
    await expect(page.locator('#popup-status')).toContainText(/ログインが必要/);
    // 未認証でも projects セクションはクラッシュせず隠れる
    await expect(page.locator('#popup-projects')).toBeHidden();
  });

  test('再認証後の切替: authed=true で reload → projects が出る', async ({ page }) => {
    await injectChromeStub(page, { authed: true, email: 'me@x', recent: [] });
    await page.goto('/popup/popup.html');

    await expect(page.locator('#popup-projects')).toBeVisible();
    await expect(page.locator('#login-button')).toBeHidden();
  });
});
