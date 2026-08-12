/**
 * J2: バージョン履歴から別バージョンをロードして state が切り替わる。
 *
 * historyView は `onList` で Sheets API（values:get）を呼ぶ → 結果を render。
 * 本スペックは `page.route` で Sheets の `FormulaVersions` タブ取得を mock する。
 * 起動時 hydrate も同じ mock を読むため、最新の fv-B が作業バージョンになる。
 *
 * docs/ui-deep-test-plan.md §Phase D J2。
 */

import { test, expect } from '@playwright/test';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario } from './fixtures/scenarios/fullState';

const APP_URL = '/app/app.html#/history';

/** FormulaVersions タブの values:get レスポンス（2 バージョン） */
const FORMULA_VERSIONS_ROWS = [
  [
    'version_id',
    'protocol_version',
    'formula_md',
    'note',
    'source',
    'created_at',
    'created_by',
    'parent_version_id',
  ],
  [
    'fv-A',
    '1',
    '## PubMed/MEDLINE\n\n```\n#1 ARDS[tiab]\n#2 ECMO[tiab]\n#3 #1 AND #2\n```\n',
    'First draft',
    'ai_draft',
    '2026-04-20T09:00:00Z',
    'tester@example.com',
    '',
  ],
  [
    'fv-B',
    '1',
    '## PubMed/MEDLINE\n\n```\n#1 ARDS[tiab] OR "acute resp"[tiab]\n#2 ECMO[tiab]\n#3 #1 AND #2\n```\n',
    'Second',
    'user_edit',
    '2026-04-20T10:00:00Z',
    'tester@example.com',
    'fv-A',
  ],
];

test.describe('journey-history-switch (J2)', () => {
  test('2 バージョン一覧 → 過去バージョン A を復元 → context の Formula が新しい作業版に切り替わる', async ({
    page,
  }) => {
    await injectAppStub(page, {
      ...fullStateScenario(),
      routes: [
        {
          url: /sheets\.googleapis\.com\/v4\/spreadsheets\/[^/]+\/values\/FormulaVersions/,
          json: {
            range: 'FormulaVersions!A1:H',
            majorDimension: 'ROWS',
            values: FORMULA_VERSIONS_ROWS,
          },
        },
      ],
    });
    await page.goto(APP_URL);

    // onList の結果として 2 件描画されるまで待つ
    const items = page.locator('.history__item');
    await expect(items).toHaveCount(2);

    // hydrate が Sheets の最新（fv-B）を読むため、起動直後の作業版は fv-B
    await expect(page.locator('#app-context')).toContainText('fv-B');

    // 過去バージョン fv-A を読み込む → 作業版が切り替わる
    const itemA = page.locator('.history__item[data-version-id="fv-A"]');
    await expect(itemA).toBeVisible();
    await itemA.locator('button.history__load').click();

    // context ラベル（#app-context, aria-live=polite）が、復元した fv-A に切り替わる
    const context = page.locator('#app-context');
    await expect(context).toContainText('Formula');
    await expect(context).not.toContainText('fv-B');
  });
});
