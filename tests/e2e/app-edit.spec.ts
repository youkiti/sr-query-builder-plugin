/**
 * #/edit 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';
import { registerMeshRdfStub, registerNcbiStub } from './fixtures/apiStubs';
import { fullStateScenario, FULL_APP_STATE } from './fixtures/scenarios/fullState';
import type { AppState } from '../../src/app/store';

const APP_URL = '/app/app.html#/edit';

/**
 * ブロック #1 の AI 改善提案（store.blockImprovement）。
 * issue #39: LLM コスト集計の setState による全ビュー再描画でも提案が消えないことの回帰確認用。
 */
const BLOCK_IMPROVEMENT: NonNullable<AppState['blockImprovement']> = {
  formulaVersionId: 'fv-20260420-01',
  blockId: '1',
  status: 'ready',
  result: {
    blockId: '1',
    currentExpression: '"ARDS"[tiab] OR "acute respiratory distress"[tiab]',
    proposedExpression: '"ARDS"[Mesh] OR "acute respiratory distress"[tiab]',
    rationale: 'MeSH を追加して感度を上げる',
  },
  error: null,
  history: [],
};

/**
 * 保存完了ステータス（store.formulaSave）。
 * issue #42: 保存完了の setState による全ビュー再描画でも確認メッセージが消えないことの回帰確認用。
 * saved は「保存で採番された新しい版」を持つので、`currentFormulaVersionId` も揃えて与える。
 */
const SAVED_STATE: Partial<AppState> = {
  ...FULL_APP_STATE,
  currentFormulaVersionId: 'fv-20260420-02',
  formulaSave: { formulaVersionId: 'fv-20260420-02', status: 'saved', error: null },
};

test.describe('app-edit (#/edit)', () => {
  test('formula 有り: ブロックに分解表示され、鉛筆編集と AI 改善 UI が出る', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    // textarea は廃止。ブロックカードで表示する
    await expect(page.locator('textarea.edit__formula')).toHaveCount(0);
    await expect(page.locator('.edit__block-list')).toBeVisible();
    await expect(page.locator('.edit__block-current').first()).toContainText(/ARDS/);
    // 各ブロックに鉛筆ボタンと AI 改善ボタン
    const firstRow = page.locator('.edit__block-row').first();
    await expect(firstRow.locator('.edit__block-edit-toggle')).toHaveCount(1);
    await expect(firstRow.locator('.edit__block-improve')).toHaveCount(1);
    // note input + 保存ボタン
    await expect(page.locator('input.edit__note-input')).toBeVisible();
    await expect(page.locator('.edit__actions button')).toHaveText(/保存/);
  });

  test('AI 改善ボタンでプロンプト入力欄が開く', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    const firstRow = page.locator('.edit__block-row').first();
    await firstRow.locator('.edit__block-improve').click();
    await expect(firstRow.locator('.edit__block-ai-instruction')).toBeVisible();
    await expect(firstRow.locator('.edit__block-ai-submit')).toBeVisible();
  });

  test('AI 改善提案は store から復元される: diff / accept / reject が出る（issue #39 回帰）', async ({
    page,
  }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, blockImprovement: BLOCK_IMPROVEMENT },
      })
    );
    await page.goto(APP_URL);

    const firstRow = page.locator('.edit__block-row').first();
    await expect(firstRow.locator('.edit__block-rationale')).toContainText('MeSH');
    await expect(firstRow.locator('.edit__block-diff-before pre')).toContainText('"ARDS"[tiab]');
    await expect(firstRow.locator('.edit__block-diff-after pre')).toContainText('"ARDS"[Mesh]');
    await expect(firstRow.locator('.edit__block-accept')).toBeVisible();
    await expect(firstRow.locator('.edit__block-reject')).toBeVisible();
    // 改善中のブロックは「AI に改善させる」ボタン自体はまだ活性（ready 状態のため）だが、
    // 提案 UI が対象ブロックの行に紐づいて出ていることを確認する。
    await expect(firstRow.locator('.edit__block-improve')).toBeEnabled();
  });

  test('保存ステータスと編集メモは store から復元される（issue #42 回帰）', async ({ page }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: {
          ...SAVED_STATE,
          formulaEditNote: { formulaVersionId: 'fv-20260420-02', note: '#2 に MeSH を追加' },
        },
      })
    );
    await page.goto(APP_URL);

    await expect(page.locator('p.edit__status')).toHaveText(
      '保存しました（version_id: fv-20260420-02）'
    );
    await expect(page.locator('p.edit__error')).toHaveText('');
    await expect(page.locator('input.edit__note-input')).toHaveValue('#2 に MeSH を追加');
  });

  test('保存中は「保存中…」と保存ボタン disabled', async ({ page }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: {
          ...FULL_APP_STATE,
          formulaSave: { formulaVersionId: 'fv-20260420-01', status: 'saving', error: null },
        },
      })
    );
    await page.goto(APP_URL);
    await expect(page.locator('p.edit__status')).toHaveText('保存中…');
    await expect(page.locator('.edit__actions button')).toBeDisabled();
  });

  test('保存失敗はエラー行に出て、もう一度押せる', async ({ page }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: {
          ...FULL_APP_STATE,
          formulaSave: {
            formulaVersionId: 'fv-20260420-01',
            status: 'error',
            error: 'Sheets への追記に失敗しました',
          },
        },
      })
    );
    await page.goto(APP_URL);
    await expect(page.locator('p.edit__error')).toHaveText('Sheets への追記に失敗しました');
    await expect(page.locator('p.edit__status')).toHaveText('');
    await expect(page.locator('.edit__actions button')).toBeEnabled();
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    await expect(page.locator('.edit__block-list')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });

  test('a11y: axe violation zero（AI 改善提案の diff 表示時）', async ({ page }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, blockImprovement: BLOCK_IMPROVEMENT },
      })
    );
    await page.goto(APP_URL);
    await expect(page.locator('.edit__block-accept')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });

  test('鉛筆を開くとブロック・インスペクタが展開し、既存の NCBI スタブ経路（esearch）だけを叩く（issue #58 chunk 3a）', async ({
    page,
  }) => {
    const esearchCalls: string[] = [];
    await registerNcbiStub(page, {
      esearch: (decodedUrl) => {
        esearchCalls.push(decodedUrl);
        return { count: '1234', idlist: [] };
      },
    });
    await registerMeshRdfStub(page);
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    const firstRow = page.locator('.edit__block-row').first();
    await firstRow.locator('.edit__block-edit-toggle').click();
    await expect(firstRow.locator('.bins')).toBeVisible();
    // #1 はフリーワードのみ（"ARDS"[tiab] OR "acute respiratory distress"[tiab]）なので
    // フリーワード Δ 表が出て、onCountHits（esearch）が実際に呼ばれる。
    await expect(firstRow.locator('.bins__delta-row').first()).toBeVisible();
    await expect
      .poll(() => esearchCalls.length, { message: 'esearch スタブが呼ばれること' })
      .toBeGreaterThan(0);
    expect(esearchCalls.some((u) => u.includes('db=pubmed'))).toBe(true);
  });

  test('a11y: axe violation zero（ブロック・インスペクタ展開時。issue #58 chunk 3a）', async ({
    page,
  }) => {
    await registerNcbiStub(page, { esearch: () => ({ count: '10', idlist: [] }) });
    await registerMeshRdfStub(page);
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    const firstRow = page.locator('.edit__block-row').first();
    await firstRow.locator('.edit__block-edit-toggle').click();
    await expect(firstRow.locator('.bins')).toBeVisible();
    await expect(firstRow.locator('.bins__delta-row').first()).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });

  test('掛け合わせ行の「組み合わせ方を編集」で式を変更すると読み取り表示が更新される（issue #91）', async ({
    page,
  }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    // FULL_FORMULA_MARKDOWN の #3 が掛け合わせ行（`#1 AND #2`）。
    const combinationRow = page.locator('.edit__block-row[data-block-id="3"]');
    await expect(combinationRow.locator('.edit__block-current')).toHaveText('#1 AND #2');

    await combinationRow.locator('.edit__block-combination-toggle').click();
    const input = combinationRow.locator('.edit__block-combination-input');
    // <details> で畳んでいないことの確認も兼ねる（CLAUDE.md: jsdom が green でも
    // 「見えている」ことは保証されないため、E2E では toBeVisible / fill が通ることを確かめる）。
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('#1 AND #2');

    await input.fill('(#1 OR #2)');
    await expect(combinationRow.locator('.edit__block-combination-status')).toHaveText(
      '✓ 構文 OK'
    );
    await combinationRow.locator('.edit__block-combination-save').click();

    await expect(combinationRow.locator('.edit__block-current')).toHaveText('(#1 OR #2)');
    // 語の編集手段（✏️ / AI 改善）は依然として出ない。
    await expect(combinationRow.locator('.edit__block-edit-toggle')).toHaveCount(0);
    await expect(combinationRow.locator('.edit__block-improve')).toHaveCount(0);
  });

  test('a11y: axe violation zero（組み合わせ方を編集パネル展開時。issue #91）', async ({
    page,
  }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    const combinationRow = page.locator('.edit__block-row[data-block-id="3"]');
    await combinationRow.locator('.edit__block-combination-toggle').click();
    await expect(combinationRow.locator('.edit__block-combination-input')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
