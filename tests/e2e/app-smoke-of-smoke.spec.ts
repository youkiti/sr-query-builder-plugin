/**
 * Phase A 完了基準: `injectAppStub` + `window.__E2E_PRELOADED_STATE__` hook だけで
 * `#/home` 〜 `#/history` の 11 ルートに guard 違反なく到達できることを確認する。
 *
 * docs/ui-deep-test-plan.md §Phase A 完了基準。
 */

import { test, expect } from '@playwright/test';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario } from './fixtures/scenarios/fullState';
import type { RouteName } from '../../src/app/router';

const APP_URL = '/app/app.html';

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

test.describe('Phase A smoke-of-smoke: 全 11 ルートへ guard 違反なく到達', () => {
  for (const route of ROUTES) {
    test(`#/${route} に到達して guard プレースホルダが出ない`, async ({ page }) => {
      await injectAppStub(page, fullStateScenario());
      await page.goto(`${APP_URL}#/${route}`);

      // 本体が起動してレンダが走るのを待つ
      await expect(page.locator('#app-content')).not.toBeEmpty();

      // guard プレースホルダ（view__placeholder）は出ていないこと
      await expect(page.locator('#app-content .view__placeholder')).toHaveCount(0);

      // サイドバー上の該当ボタンが disabled でない（home はサイドバーに無い）
      if (route !== 'home') {
        const sidebarBtn = page.locator(`#app-sidebar button:has-text("${labelFor(route)}")`);
        await expect(sidebarBtn).not.toHaveAttribute('aria-disabled', 'true');
      }
    });
  }
});

function labelFor(route: RouteName): string {
  const map: Record<RouteName, string> = {
    home: 'ホーム',
    protocol: 'プロトコル入力',
    blocks: 'ブロック承認',
    seeds: 'シード論文',
    draft: '検索式ドラフト',
    validate: '検証',
    expand: '対話的シード拡張',
    edit: '検索式編集',
    export: 'エクスポート',
    done: '完了',
    history: 'バージョン履歴',
    settings: '設定',
  };
  return map[route];
}
