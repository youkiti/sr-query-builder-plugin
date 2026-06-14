/**
 * ガード横断スモーク: 5 段階の state × 8 ルートで enabled / deny 文言を確認。
 *
 * jsdom テストでは属性のみだが、ここでは実 Chromium の「サイドバーのボタンが
 * クリック可能か + aria-disabled + title（deny reason）」と `#app-status` 文言を
 * 実際に触る。
 *
 * docs/ui-deep-test-plan.md §Phase C / guards.ts §3 の state マトリクス。
 */

import { test, expect } from '@playwright/test';
import { injectAppStub, PROJECT_FIXTURE } from './fixtures/appStub';
import {
  FULL_APP_STATE,
  FULL_BLOCKS_DRAFT,
  FULL_PROTOCOL_DRAFT,
} from './fixtures/scenarios/fullState';
import type { AppState } from '../../src/app/store';

const APP_URL = '/app/app.html#/home';

const LABELS = {
  blocks: 'ブロック承認',
  seeds: 'シード論文',
  draft: '検索式（ドラフト）',
  expand: '対話的シード拡張',
  edit: '検索式編集',
  export: 'エクスポート',
  done: '完了',
  history: 'バージョン履歴',
} as const;

const REASON = {
  PROJECT: 'プロジェクトを選択してください',
  PROTOCOL: '先にプロトコルを入力してください',
  BLOCKS: '先にブロック承認を完了させてください',
  FORMULA: '先に検索式を生成または読み込んでください',
} as const;

type StateName = 'empty' | 'projectOnly' | 'protocol' | 'blocksApproved' | 'full';

const STATES: Record<StateName, Partial<AppState>> = {
  empty: {},
  projectOnly: { project: PROJECT_FIXTURE },
  protocol: { project: PROJECT_FIXTURE, protocolDraft: FULL_PROTOCOL_DRAFT },
  blocksApproved: {
    project: PROJECT_FIXTURE,
    protocolDraft: FULL_PROTOCOL_DRAFT,
    blocksDraft: FULL_BLOCKS_DRAFT,
    currentProtocolVersion: 1,
  },
  full: FULL_APP_STATE,
};

type Expectation = 'enabled' | keyof typeof REASON;

const MATRIX: Record<StateName, Record<keyof typeof LABELS, Expectation>> = {
  empty: {
    blocks: 'PROJECT',
    seeds: 'PROJECT',
    draft: 'PROJECT',
    expand: 'PROJECT',
    edit: 'PROJECT',
    export: 'PROJECT',
    done: 'PROJECT',
    history: 'PROJECT',
  },
  projectOnly: {
    blocks: 'PROTOCOL',
    seeds: 'enabled',
    draft: 'BLOCKS',
    expand: 'FORMULA',
    edit: 'FORMULA',
    export: 'FORMULA',
    done: 'FORMULA',
    history: 'enabled',
  },
  protocol: {
    blocks: 'enabled',
    seeds: 'enabled',
    draft: 'BLOCKS',
    expand: 'FORMULA',
    edit: 'FORMULA',
    export: 'FORMULA',
    done: 'FORMULA',
    history: 'enabled',
  },
  blocksApproved: {
    blocks: 'enabled',
    seeds: 'enabled',
    draft: 'enabled',
    expand: 'FORMULA',
    edit: 'FORMULA',
    export: 'FORMULA',
    done: 'FORMULA',
    history: 'enabled',
  },
  full: {
    blocks: 'enabled',
    seeds: 'enabled',
    draft: 'enabled',
    expand: 'enabled',
    edit: 'enabled',
    export: 'enabled',
    done: 'enabled',
    history: 'enabled',
  },
};

test.describe('app-guards: 5 state × 8 route のマトリクス', () => {
  for (const stateName of Object.keys(MATRIX) as StateName[]) {
    test(`${stateName}: 各ルートの enabled / deny reason`, async ({ page }) => {
      await injectAppStub(page, {
        authed: true,
        currentProject: STATES[stateName].project ?? null,
        preloadedState: STATES[stateName],
      });
      await page.goto(APP_URL);

      // サイドバーが描画されるのを待つ（home は sidebar に並ばない）
      await expect(page.locator('#app-sidebar nav button').first()).toBeVisible();

      for (const route of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
        const expectation = MATRIX[stateName][route];
        const btn = page.locator(`#app-sidebar nav button:has-text("${LABELS[route]}")`);

        if (expectation === 'enabled') {
          await expect(btn).not.toHaveAttribute('aria-disabled', 'true');
        } else {
          await expect(btn).toHaveAttribute('aria-disabled', 'true');
          await expect(btn).toHaveAttribute('title', REASON[expectation]);
        }
      }
    });
  }

  test('deny されたルートをクリックすると #app-status に reason が入る（home のまま）', async ({
    page,
  }) => {
    await injectAppStub(page, { authed: true });
    await page.goto(APP_URL);

    // aria-disabled=true の button は Playwright の actionability チェックに引っかかるので
    // force: true で dispatch。これは本来ユーザーがマウスクリックで試せる経路に相当する。
    await page
      .locator('#app-sidebar nav button:has-text("ブロック承認")')
      .click({ force: true });
    await expect(page.locator('#app-status')).toContainText(REASON.PROJECT);
    // ハッシュは遷移しない（home のまま）
    expect(new URL(page.url()).hash).toBe('#/home');
  });
});
