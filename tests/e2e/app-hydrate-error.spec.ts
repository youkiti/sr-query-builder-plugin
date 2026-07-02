/**
 * 起動時 hydrate（Sheets 読み込み）失敗のエラーバナー（fix-plan 1-3）。
 * Sheets API を 500 で落とすと home / protocol に「読み込みに失敗しました」バナーが出て、
 * 「再試行」で復旧すればバナーが消えることを確認する。
 */

import { test, expect, type Page } from '@playwright/test';
import { injectAppStub, scenarioWithProject } from './fixtures/appStub';

/** appStub のデフォルト Sheets モック（成功）を、切替可能な失敗モックで上書きする */
async function routeSheetsFailure(page: Page): Promise<{ recover: () => void }> {
  let failing = true;
  await page.route('**/sheets.googleapis.com/**', async (route) => {
    if (failing) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ values: [] }),
    });
  });
  return {
    recover: () => {
      failing = false;
    },
  };
}

test.describe('app-hydrate-error（Sheets 読み込み失敗）', () => {
  test('home: エラーバナー「読み込みに失敗しました」が出る', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await routeSheetsFailure(page);
    await page.goto('/app/app.html#/home');

    const banner = page.locator('.view__hydrate-error');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('読み込みに失敗しました');
    await expect(page.locator('.view__hydrate-error-retry')).toBeVisible();
  });

  test('protocol: 同じバナーが出る', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    await routeSheetsFailure(page);
    await page.goto('/app/app.html#/protocol');

    await expect(page.locator('.view__hydrate-error')).toContainText(
      '読み込みに失敗しました'
    );
  });

  test('「再試行」で Sheets が復旧していればバナーが消える', async ({ page }) => {
    await injectAppStub(page, scenarioWithProject());
    const sheets = await routeSheetsFailure(page);
    await page.goto('/app/app.html#/home');

    await expect(page.locator('.view__hydrate-error')).toBeVisible();
    sheets.recover();
    await page.locator('.view__hydrate-error-retry').click();
    await expect(page.locator('.view__hydrate-error')).toHaveCount(0);
  });
});
