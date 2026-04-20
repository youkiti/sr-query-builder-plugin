/**
 * Popup の Playwright スモークテスト。
 *
 * 目的: jsdom 単体テストでは検出不能な、`hidden` 属性と CSS の相互作用バグを
 * 実 Chromium で再現する。`docs/ui-states.md` の状態 ID に対応する。
 *
 * 前提:
 * - `npm run dev` で `dist/` がビルド済み（`playwright.config.ts` の webServer が
 *   `dist:e2e` で自動実行する）
 * - `npx playwright install chromium` で Chromium が入っている
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectChromeStub, type PopupScenario } from './fixtures/chromeStub';

const POPUP_URL = '/popup/popup.html';

const RECENT_TWO: PopupScenario['recent'] = [
  {
    projectId: 'pid-aaaaaa1',
    spreadsheetId: 'sheet-aaa',
    driveFolderId: 'folder-aaa',
    title: 'Project Alpha',
  },
  {
    projectId: 'pid-bbbbbb2',
    spreadsheetId: 'sheet-bbb',
    driveFolderId: 'folder-bbb',
    title: 'Project Beta',
  },
];

test.describe('Popup smoke (docs/ui-states.md §1)', () => {
  test('状態 A: 未ログインなら login のみ表示・projects は完全に隠れる', async ({ page }) => {
    await injectChromeStub(page, { authed: false, email: '', recent: [] });
    await page.goto(POPUP_URL);

    await expect(page.locator('#popup-auth')).toBeVisible();
    await expect(page.locator('#login-button')).toBeVisible();
    // ↓ 過去の specificity バグでは `#login-button` と `#popup-recent` が同時に出ていた
    await expect(page.locator('#popup-projects')).toBeHidden();
    await expect(page.locator('#logout-button')).toBeHidden();
    await expect(page.locator('#popup-status')).toHaveText(/ログインが必要/);
  });

  test('状態 B-0: ログイン済 / 履歴 0 件で projects のみ表示・recent セクションは hidden', async ({
    page,
  }) => {
    await injectChromeStub(page, { authed: true, email: 'me@x', recent: [] });
    await page.goto(POPUP_URL);

    await expect(page.locator('#popup-auth')).toBeHidden();
    await expect(page.locator('#popup-projects')).toBeVisible();
    await expect(page.locator('#popup-recent-section')).toBeHidden();
    await expect(page.locator('#popup-create-form')).toBeVisible();
    await expect(page.locator('#popup-open-form')).toBeVisible();
    await expect(page.locator('#popup-status')).toHaveText(/作成|スプレッドシート ID/);
    await expect(page.locator('#popup-email')).toHaveText('me@x');
  });

  test('状態 B-N: 履歴 N 件なら recent セクションが表示され、ボタンが N 個並ぶ', async ({
    page,
  }) => {
    await injectChromeStub(page, {
      authed: true,
      email: 'me@x',
      recent: RECENT_TWO,
    });
    await page.goto(POPUP_URL);

    await expect(page.locator('#popup-recent-section')).toBeVisible();
    await expect(page.locator('#popup-recent button')).toHaveCount(2);
    await expect(page.locator('#popup-recent button').first()).toContainText('Project Alpha');
    await expect(page.locator('#popup-status')).toHaveText(/最近のプロジェクト/);
  });

  test('回帰: [hidden] 属性の付いたセクションは computed style でも display:none', async ({
    page,
  }) => {
    // 過去の specificity バグの直接的な回帰テスト。`.popup__section { display: flex }` が
    // `[hidden]` に勝って表示されてしまう挙動を CSS レベルで弾けているか確認する。
    await injectChromeStub(page, { authed: false, email: '', recent: [] });
    await page.goto(POPUP_URL);

    const projectsDisplay = await page
      .locator('#popup-projects')
      .evaluate((el) => window.getComputedStyle(el).display);
    expect(projectsDisplay).toBe('none');

    const authDisplay = await page
      .locator('#popup-auth')
      .evaluate((el) => window.getComputedStyle(el).display);
    expect(authDisplay).not.toBe('none');
  });

  test('a11y (axe): ログイン済の主要 violation がゼロ（Tier 3）', async ({ page }) => {
    await injectChromeStub(page, { authed: true, email: 'me@x', recent: RECENT_TWO });
    await page.goto(POPUP_URL);
    await expect(page.locator('#popup-projects')).toBeVisible();

    const result = await new AxeBuilder({ page })
      // tokens.css のコントラスト初期値は MVP 範囲外なので color-contrast は別 issue 化扱い
      .disableRules(['color-contrast'])
      .analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
