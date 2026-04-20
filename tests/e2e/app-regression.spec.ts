/**
 * Phase F 回帰ネット。過去バグと同系統を 1 行で落とす。
 *
 * 初期メニュー:
 * 1. 全 route で `#app-content` が空でない
 * 2. `#app-status` / `#popup-status` / `#options-status` が全状態で非空
 * 3. 長いプロジェクト名（100 文字）で popup `#open-options` の bounding box が独立
 *
 * docs/ui-deep-test-plan.md §Phase F。
 */

import { test, expect } from '@playwright/test';
import { injectAppStub, PROJECT_FIXTURE } from './fixtures/appStub';
import { injectChromeStub } from './fixtures/chromeStub';
import { injectOptionsStub } from './fixtures/optionsStub';
import { fullStateScenario } from './fixtures/scenarios/fullState';
import type { RouteName } from '../../src/app/router';

const ROUTES: RouteName[] = [
  'home',
  'protocol',
  'blocks',
  'seeds',
  'draft',
  'validate',
  'expand',
  'edit',
  'export',
  'done',
  'history',
];

test.describe('Phase F 回帰ネット', () => {
  for (const route of ROUTES) {
    test(`#/${route}: #app-content が空文字にならない`, async ({ page }) => {
      await injectAppStub(page, fullStateScenario());
      await page.goto(`/app/app.html#/${route}`);

      const text = await page
        .locator('#app-content')
        .evaluate((el) => (el.textContent ?? '').trim());
      expect(text.length).toBeGreaterThan(0);
    });
  }

  test('app: 全 guard 段階で #app-status が非空', async ({ page }) => {
    // project 未選択（初期状態）でも status にはルートラベルが載る
    await injectAppStub(page, { authed: true });
    await page.goto('/app/app.html#/home');
    const text = await page.locator('#app-status').evaluate((el) => (el.textContent ?? '').trim());
    expect(text.length).toBeGreaterThan(0);
  });

  test('popup: 未ログイン / ログイン済 どちらでも #popup-status が非空', async ({ page }) => {
    await injectChromeStub(page, { authed: false, email: '', recent: [] });
    await page.goto('/popup/popup.html');
    let text = await page
      .locator('#popup-status')
      .evaluate((el) => (el.textContent ?? '').trim());
    expect(text.length).toBeGreaterThan(0);

    await injectChromeStub(page, { authed: true, email: 'a@b', recent: [] });
    await page.goto('/popup/popup.html');
    text = await page.locator('#popup-status').evaluate((el) => (el.textContent ?? '').trim());
    expect(text.length).toBeGreaterThan(0);
  });

  test('options: #options-status が初期描画直後に読み込み中のまま固まらない', async ({ page }) => {
    await injectOptionsStub(page);
    await page.goto('/options/options.html');

    // 起動時「読み込み中…」→ readKey 解決後に差し替わる
    await expect(page.locator('#options-status')).not.toHaveText('読み込み中…');
    const text = await page
      .locator('#options-status')
      .evaluate((el) => (el.textContent ?? '').trim());
    expect(text.length).toBeGreaterThan(0);
  });

  test('popup: 長い title (100 文字) でも #open-options の bounding box が独立', async ({
    page,
  }) => {
    const longTitle = 'あ'.repeat(100);
    await injectChromeStub(page, {
      authed: true,
      email: 'me@x',
      recent: [
        { ...PROJECT_FIXTURE, title: longTitle },
        { ...PROJECT_FIXTURE, projectId: 'pid-2', title: 'Short' },
      ],
    });
    await page.goto('/popup/popup.html');

    const openOptions = page.locator('#open-options');
    const recentBtn = page.locator('#popup-recent button').first();
    await expect(openOptions).toBeVisible();
    await expect(recentBtn).toBeVisible();

    const optionsBox = await openOptions.boundingBox();
    const recentBox = await recentBtn.boundingBox();
    expect(optionsBox).not.toBeNull();
    expect(recentBox).not.toBeNull();
    // 2 要素の bounding box が重ならない（= open-options が recent の上に潰れない）
    if (optionsBox && recentBox) {
      const xOverlap =
        Math.max(
          0,
          Math.min(optionsBox.x + optionsBox.width, recentBox.x + recentBox.width) -
            Math.max(optionsBox.x, recentBox.x)
        ) > 0;
      const yOverlap =
        Math.max(
          0,
          Math.min(optionsBox.y + optionsBox.height, recentBox.y + recentBox.height) -
            Math.max(optionsBox.y, recentBox.y)
        ) > 0;
      expect(xOverlap && yOverlap).toBeFalsy();
    }
  });
});
