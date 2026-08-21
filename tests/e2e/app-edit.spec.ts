/**
 * #/edit 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';
import {
  registerDriveStub,
  registerGeminiStub,
  registerMeshRdfStub,
  registerNcbiStub,
} from './fixtures/apiStubs';
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
 * issue #90（AI との会話継続・提案の手編集）の実操作 E2E 用。
 * BLOCK_IMPROVEMENT と違い history が非空（過去 1 turn）なので、「これまでのやり取り」
 * 欄（<details>）を含めて a11y を確認できる。
 */
const BLOCK_IMPROVEMENT_WITH_HISTORY: NonNullable<AppState['blockImprovement']> = {
  ...BLOCK_IMPROVEMENT,
  history: [
    {
      instruction: '同義語を増やして',
      proposedExpression: '"ARDS"[Mesh] OR "acute respiratory distress"[tiab]',
      rationale: 'MeSH を追加して感度を上げる',
    },
  ],
};

/** 「指示を追加してやり直す」（issue #90）で LLM から返す 2 回目の提案。 */
const REDO_IMPROVE_BLOCK_RESPONSE = {
  proposed_expression:
    '"ARDS"[Mesh] OR "acute respiratory distress"[tiab] OR "acute lung injury"[tiab]',
  rationale: '同義語 acute lung injury を追加しました。',
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

  /**
   * issue #90（提案を編集してから採用する）。CLAUDE.md が指摘する
   * 「jsdom が green でも『見えている』ことは保証されない」実例そのものと同じ構造
   * （`<details>` に畳んだ textarea）を持つ UI なので、jsdom の unit テストだけでなく
   * 実ブラウザで開閉・fill・click が通ることを確認する。
   */
  test('「提案を編集してから採用する」: <details> を開いて編集し、置き換えられる（issue #90）', async ({
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
    const manualEdit = firstRow.locator('.edit__block-ai-manual-edit');
    const manualEditInput = manualEdit.locator('.edit__block-ai-manual-edit-input');

    // <details> は既定で閉じている（manualEditDraft が無いため）。閉じたままだと
    // Playwright の `fill()` / `toBeVisible()` は失敗する（jsdom の click/querySelector と
    // 違って可視性を尊重するため）。summary をクリックして開く。
    await expect(manualEditInput).toBeHidden();
    await manualEdit.locator('summary').click();
    await expect(manualEditInput).toBeVisible();
    // 初期値は提案 expression（BLOCK_IMPROVEMENT.result.proposedExpression）
    await expect(manualEditInput).toHaveValue('"ARDS"[Mesh] OR "acute respiratory distress"[tiab]');

    const edited =
      '"ARDS"[Mesh] OR "acute respiratory distress"[tiab] OR "acute lung injury"[tiab]';
    await manualEditInput.fill(edited);
    await manualEdit.locator('.edit__block-ai-manual-edit-apply').click();

    // 適用後: ブロック #1 の読み取り表示が編集後の式に置き換わり、提案パネル（diff/accept/
    // reject）は閉じる（applyBlockImprovement 経路は accept と同じく onClearImprovement を呼ぶ）。
    await expect(firstRow.locator('.edit__block-current')).toHaveText(edited);
    await expect(firstRow.locator('.edit__block-accept')).toHaveCount(0);
    await expect(firstRow.locator('.edit__block-ai-manual-edit')).toHaveCount(0);
  });

  test('「提案を編集してから採用する」: 空にすると拒否されエラーが表示される（issue #90）', async ({
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
    const manualEdit = firstRow.locator('.edit__block-ai-manual-edit');
    await manualEdit.locator('summary').click();
    await manualEdit.locator('.edit__block-ai-manual-edit-input').fill('   ');
    await manualEdit.locator('.edit__block-ai-manual-edit-apply').click();

    await expect(manualEdit.locator('.edit__block-ai-manual-edit-error')).toContainText(
      '空にすることはできません'
    );
    // 拒否されているので式もパネルもそのまま残る。
    await expect(firstRow.locator('.edit__block-current')).toContainText('ARDS');
    await expect(firstRow.locator('.edit__block-accept')).toBeVisible();
  });

  /**
   * issue #90（指示を追加してやり直す）。「これは違う、こうして」の会話継続を、Gemini モックを
   * 挟んだ実操作で通す。redoWrap は `<details>` で畳んでいない常時表示 UI だが、jsdom の
   * unit テストだけでは実際に fill/click が Playwright の実ブラウザ経路（fetch を伴う
   * fire-and-forget の onImproveBlock 呼び出し）を通ることまでは確認できない。
   */
  test('「指示を追加してやり直す」: 実際に送信でき、新しい提案と履歴に反映される（issue #90）', async ({
    page,
  }) => {
    await registerDriveStub(page);
    await registerGeminiStub(page, {
      responses: { 'improve-block': REDO_IMPROVE_BLOCK_RESPONSE },
    });
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, blockImprovement: BLOCK_IMPROVEMENT },
        extraStorage: { 'apiKeys.gemini': 'dummy-key' },
      })
    );
    await page.goto(APP_URL);

    const firstRow = page.locator('.edit__block-row').first();
    const redoInstruction = firstRow.locator('.edit__block-ai-redo-instruction');
    await expect(redoInstruction).toBeVisible();
    await redoInstruction.fill('acute lung injury も同義語として追加して');
    await firstRow.locator('.edit__block-ai-redo-submit').click();

    // 新しい提案が届くまで待つ（rationale が新しい応答の文言に置き換わる）。
    await expect(firstRow.locator('.edit__block-rationale')).toContainText(
      'acute lung injury を追加しました',
      { timeout: 15_000 }
    );
    await expect(firstRow.locator('.edit__block-diff-after pre')).toContainText(
      'acute lung injury'
    );

    // 今回の turn（指示 → 旧提案の rationale ではなく、今回送った指示とその結果）が
    // 「これまでのやり取り」に積まれ、次回の会話継続に使われる（issue #90 の history 契約）。
    const history = firstRow.locator('.edit__block-ai-history');
    await expect(history.locator('summary')).toHaveText('これまでのやり取り（1 回）');
    await history.locator('summary').click();
    await expect(history.locator('.edit__block-ai-history-instruction')).toContainText(
      'acute lung injury も同義語として追加して'
    );
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

  test('a11y: axe violation zero（issue #90: 提案の手編集 <details> / これまでのやり取り <details> を展開時）', async ({
    page,
  }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, blockImprovement: BLOCK_IMPROVEMENT_WITH_HISTORY },
      })
    );
    await page.goto(APP_URL);

    const firstRow = page.locator('.edit__block-row').first();
    await firstRow.locator('.edit__block-ai-manual-edit summary').click();
    await expect(firstRow.locator('.edit__block-ai-manual-edit-input')).toBeVisible();
    await firstRow.locator('.edit__block-ai-history summary').click();
    await expect(firstRow.locator('.edit__block-ai-history-list')).toBeVisible();
    await expect(firstRow.locator('.edit__block-ai-redo-instruction')).toBeVisible();

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
