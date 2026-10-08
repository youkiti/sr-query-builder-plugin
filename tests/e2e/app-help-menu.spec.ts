/**
 * 見出しの横の「?」メニュー（ヘルプ・動画・ツアー・一覧）のスモーク。
 * リンクは実際には開かず、href だけを確かめる（外部サイトへは行かない）。
 */

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';

const HOME_URL = '/app/app.html#/home';
const SETTINGS_URL = '/app/app.html#/settings';

/** initGuide は非同期で、入口のボタンに aria-controls が付く前に押すと何も起きない。 */
async function waitForGuide(page: Page): Promise<void> {
  await page.waitForSelector('#app-open-tours[aria-controls]');
}

test.describe('app-help-menu (「?」メニュー)', () => {
  test('#/home の見出しに「?」があり、メニューのヘルプと動画のリンクが正しい', async ({ page }) => {
    await injectAppStub(page);
    await page.goto(HOME_URL);
    await waitForGuide(page);
    const help = page.locator('#app-content h2 + .guide-help-btn');
    await expect(help).toHaveCount(1);
    await help.click();
    const menu = page.locator('.guide-help-menu');
    await expect(menu).toBeVisible();
    await expect(help).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.locator('[data-help-action="read"]')).toHaveAttribute(
      'href',
      'https://youkiti.github.io/sr-query-builder-plugin/help.html?lang=ja#project',
    );
    await expect(menu.locator('[data-help-action="video"]')).toHaveAttribute('href', 'https://youtu.be/RqUFlmncuIE?t=174');
    await expect(menu.locator('a')).toHaveCount(2);
    for (const anchor of await menu.locator('a').all()) {
      await expect(anchor).toHaveAttribute('target', '_blank');
      await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  test('「ここからツアーを始める」でツアーの 1 手順目のカードが出る', async ({ page }) => {
    await injectAppStub(page);
    await page.goto(HOME_URL);
    await waitForGuide(page);
    await page.locator('#app-content h2 + .guide-help-btn').click();
    await page.locator('.guide-help-menu [data-help-action="start-tour"]').click();
    await expect(page.locator('.guide-help-menu')).toHaveCount(0);
    await expect(page.locator('.guide-tour-card')).toHaveAttribute('data-guide-step', 'welcome');
  });

  test('「ツアーの一覧」でヘッダーの一覧が開く', async ({ page }) => {
    await injectAppStub(page);
    await page.goto(HOME_URL);
    await waitForGuide(page);
    await page.locator('#app-content h2 + .guide-help-btn').click();
    await page.locator('.guide-help-menu [data-help-action="tour-list"]').click();
    await expect(page.locator('#guide-tour-list')).toBeVisible();
    await expect(page.locator('.guide-help-menu')).toHaveCount(0);
  });

  test('#/settings ではツアーの項目が出ず、動画は設定の章（?t=66）を指す', async ({ page }) => {
    await injectAppStub(page);
    await page.goto(SETTINGS_URL);
    await waitForGuide(page);
    await page.locator('#app-content .guide-help-btn').first().click();
    const menu = page.locator('.guide-help-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-help-action="start-tour"]')).toHaveCount(0);
    await expect(menu.locator('[data-help-action="video"]')).toHaveAttribute('href', 'https://youtu.be/RqUFlmncuIE?t=66');
    await expect(menu.locator('[data-help-action="read"]')).toHaveAttribute('href', /help\.html\?lang=ja#setup$/);
  });

  test('Esc でメニューが閉じ、フォーカスが「?」に戻る', async ({ page }) => {
    await injectAppStub(page);
    await page.goto(HOME_URL);
    await waitForGuide(page);
    const help = page.locator('#app-content h2 + .guide-help-btn');
    await help.click();
    await expect(page.locator('.guide-help-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.guide-help-menu')).toHaveCount(0);
    await expect(help).toBeFocused();
    await expect(help).toHaveAttribute('aria-expanded', 'false');
  });

  test('メニュー表示中も axe の違反が無い', async ({ page }) => {
    await injectAppStub(page);
    await page.goto(HOME_URL);
    await waitForGuide(page);
    await page.locator('#app-content h2 + .guide-help-btn').click();
    await expect(page.locator('.guide-help-menu')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });

  test('「?」が入っても見出しの文字は変わらない', async ({ page }) => {
    await injectAppStub(page);
    await page.goto(HOME_URL);
    await waitForGuide(page);
    await expect(page.locator('#app-content h2 + .guide-help-btn')).toHaveCount(1);
    await expect(page.locator('#app-content h2')).toHaveText('ホーム');
    await expect(page.locator('#app-content h2 button')).toHaveCount(0);
    // 読み上げ名が変わっていない（「?」の aria-label が見出しの名前に混ざらない）
    await expect(page.getByRole('heading', { name: 'ホーム', exact: true })).toHaveCount(1);
  });
});
