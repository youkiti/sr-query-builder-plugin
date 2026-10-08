/**
 * ヘルプツアー（提案帯・一覧・カード・言語切替）のスモーク。
 * 共通スタブは既定で提案帯を止めている（fixtures/appStub.ts の GUIDE_PROGRESS_SUPPRESSED）。
 * 提案帯を検証する spec だけが extraStorage で guide_progress を明示的に渡す。
 */

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';

const HOME_URL = '/app/app.html#/home';
const SUGGESTING = { tours: {}, active: null, suppressSuggestions: false };

/** initGuide は非同期で、入口のボタンに aria-controls が付く前に押すと何も起きない。 */
async function waitForGuide(page: Page): Promise<void> {
  await page.waitForSelector('#app-open-tours[aria-controls]');
}

test.describe('app-guide (ヘルプツアー)', () => {
  test('既定のスタブ（提案を止めた状態）では #/home に提案帯が出ない', async ({ page }) => {
    await injectAppStub(page);
    await page.goto(HOME_URL);
    await waitForGuide(page);
    await expect(page.locator('#app-content h2')).toHaveText('ホーム');
    await expect(page.locator('#guide-suggest-band')).toHaveCount(0);
    await expect(page.locator('#app-open-tours')).toHaveText('ツアー');
  });

  test('提案を止めていなければ #/home に提案帯が出て、「ツアーで進める」で 1 手順目のカードと枠が出る', async ({ page }) => {
    await injectAppStub(page, { extraStorage: { guide_progress: SUGGESTING } });
    await page.goto(HOME_URL);
    const band = page.locator('#guide-suggest-band');
    await expect(band).toBeVisible();
    await expect(band.locator('button')).toHaveText(['ツアーで進める', 'あとで', '今後表示しない']);
    await band.locator('[data-guide-action="start"]').click();
    const card = page.locator('.guide-tour-card');
    await expect(card).toHaveAttribute('data-guide-step', 'welcome');
    await expect(card).toHaveAttribute('data-guide-waiting', 'false');
    await expect(page.locator('.guide-tour-highlight')).toBeVisible();
    await expect(band).toHaveCount(0);
  });

  test('ヘッダーの「ツアー」から一覧を開き、3 手順を最後まで進めて終え、一覧に「済み」が付く', async ({ page }) => {
    await injectAppStub(page);
    await page.goto(HOME_URL);
    await waitForGuide(page);
    await page.locator('#app-open-tours').click();
    await page.locator('#guide-tour-list [data-guide-action="start"]').click();
    const card = page.locator('.guide-tour-card');
    await expect(card).toHaveAttribute('data-guide-step', 'welcome');
    await expect(card).toContainText('1 / 3');
    await card.locator('[data-guide-action="next"]').click();
    await expect(card).toHaveAttribute('data-guide-step', 'open-protocol');
    await expect(card).toContainText('2 / 3');
    // 枠は対象の位置に追従する（再配置は一拍遅れることがある）。同じ瞬間に両方を読み、重なるまで待つ
    await expect
      .poll(() =>
        page.evaluate(() => {
          const target = document.querySelector('[data-tour="nav-protocol"]')!.getBoundingClientRect();
          const frame = document.querySelector('.guide-tour-highlight')!.getBoundingClientRect();
          return [Math.round(frame.x - target.x), Math.round(frame.y - target.y)];
        }),
      )
      .toEqual([-3, -3]);
    await page.locator('[data-tour="nav-protocol"]').click();
    await expect(page).toHaveURL(/#\/protocol$/);
    await expect(card).toHaveAttribute('data-guide-step', 'finish');
    await expect(card).toContainText('3 / 3');
    await card.locator('[data-guide-action="next"]').click();
    await expect(card).toHaveCount(0);
    await page.locator('#app-open-tours').click();
    await expect(page.locator('#guide-tour-list h2')).toContainText('済み');
  });

  test('カード表示中も axe の違反が無い', async ({ page }) => {
    await injectAppStub(page);
    await page.goto(HOME_URL);
    await waitForGuide(page);
    await page.locator('#app-open-tours').click();
    await page.locator('#guide-tour-list [data-guide-action="start"]').click();
    await expect(page.locator('.guide-tour-card')).toHaveAttribute('data-guide-step', 'welcome');
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });

  test('一覧で「English」を押すと、一覧の見出しとボタンが英語になる', async ({ page }) => {
    await injectAppStub(page);
    await page.goto(HOME_URL);
    await waitForGuide(page);
    await page.locator('#app-open-tours').click();
    const list = page.locator('#guide-tour-list');
    await expect(list.locator('h2')).toHaveText('はじめての流れ');
    await list.locator('[data-guide-language="en"]').click();
    await expect(list).toBeVisible();
    await expect(list.locator('h2')).toHaveText('Getting started');
    await expect(list.locator('[data-guide-action="start"]')).toHaveText('Start');
    await expect(list.locator('[data-guide-action="close-list"]')).toHaveText('Close list');
    await expect(list.locator('[data-guide-language="en"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#app-open-tours')).toHaveText('Tours');
  });
});
