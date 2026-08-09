/**
 * J6: #/edit の「新バージョンとして保存」を**実操作で**通し、保存ステータスと編集メモが
 * 全ビュー再描画に耐えることを確認する（issue #42 / PR #43 の受け入れ確認）。
 *
 * 既存の app-edit.spec.ts は store を preload して「その state を描画できるか」を見る
 * 静的な確認に留まる。本 spec はボタンを実際に押し、Sheets（values:append / values:get）を
 * 状態を持つスタブで受けて本物の保存フローを走らせたうえで、AI 改善（Gemini モック）による
 * LLM コスト集計 setState で全ビュー再描画を誘発し、メッセージとメモが生き残ることを見る。
 * ローカル DOM に書いていた旧実装では、この経路でだけメッセージが消えていた（#42）。
 *
 * docs/ui-deep-test-plan.md §Phase D の J1/J2 と同じく、外部 API はすべて
 * `tests/e2e/fixtures/apiStubs.ts` の共通スタブで止める（応答形や skill 判別の詳細は
 * そちらの doc コメント参照）。
 */

import { test, expect, type Page } from '@playwright/test';
import { injectAppStub } from './fixtures/appStub';
import {
  fullStateScenario,
  FULL_APP_STATE,
  FULL_FORMULA_MARKDOWN,
} from './fixtures/scenarios/fullState';
import {
  registerSheetsStub,
  registerDriveStub,
  registerGeminiStub,
  type SheetsFake,
} from './fixtures/apiStubs';

const APP_URL = '/app/app.html#/edit';

/** 保存で採番される version_id は UUID v4。文言ごと突き合わせる。 */
const SAVED_MESSAGE_RE =
  /^保存しました（version_id: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}）$/;

/** SHEET_HEADERS.FormulaVersions と同じ列順（src/domain/sheetsSchema.ts） */
const FORMULA_VERSIONS_HEADER = [
  'version_id',
  'parent_version_id',
  'protocol_version',
  'protocol_snapshot_ref',
  'formula_md',
  'created_by',
  'created_at',
  'note',
  'model',
];

/** preload される currentFormulaVersionId（fv-20260420-01）に対応する既存行 */
const EXISTING_VERSION_ROW = [
  'fv-20260420-01',
  '',
  '1',
  'protocol-snapshot-1',
  FULL_FORMULA_MARKDOWN,
  'ai_draft',
  '2026-04-20T09:00:00Z',
  '初回ドラフト',
  'gemini-3.5-flash',
];

/** improve-block skill の応答。「AI 改善で全ビュー再描画を起こす」ための素材。 */
const IMPROVE_BLOCK_RESPONSE = {
  proposed_expression:
    '"Extracorporeal Membrane Oxygenation"[Mesh] OR "ECMO"[tiab] OR "ECLS"[tiab]',
  rationale: 'MeSH と略語 ECLS を足して感度を上げました。',
};

interface EditScenarioOptions {
  failAppendTabs?: string[];
  appendDelayMs?: number;
}

/**
 * #/edit を実操作するための外部 API スタブ一式を仕込む。
 * - Sheets: FormulaVersions を状態付きで処理（append した行が後続の get に見えるので、
 *   「保存 → #/history に増えている」まで 1 本の筋で確認できる）
 * - Drive: LLM ログ payload のアップロードを成功で返す
 * - Gemini: improve-block skill の JSON を返す（usageMetadata 付き＝コスト集計が動く）
 */
async function setupEditScenario(
  page: Page,
  options: EditScenarioOptions = {}
): Promise<SheetsFake> {
  const fake = await registerSheetsStub(page, {
    tabs: { FormulaVersions: [FORMULA_VERSIONS_HEADER, EXISTING_VERSION_ROW] },
    failAppendTabs: options.failAppendTabs,
    appendDelayMs: options.appendDelayMs,
  });

  await registerDriveStub(page);

  // トークン数は累積コストの変化が目視できる大きさにする
  // （gemini-3.5-flash: in $1.5 / out $9.0 per 1M → 1000/1000 で +$0.0105）。
  await registerGeminiStub(page, {
    responses: { 'improve-block': IMPROVE_BLOCK_RESPONSE },
    usage: { promptTokenCount: 1000, candidatesTokenCount: 1000 },
  });

  await injectAppStub(
    page,
    fullStateScenario({
      preloadedState: { ...FULL_APP_STATE },
      extraStorage: { 'apiKeys.gemini': 'dummy-key' },
    })
  );
  return fake;
}

/** 鉛筆でブロック #blockId を開き、式を書き換えて確定する（md が変わる＝未保存の編集）。 */
async function editBlockInline(page: Page, blockId: string, nextExpression: string): Promise<void> {
  const row = page.locator(`.edit__block-row[data-block-id="${blockId}"]`);
  await row.locator('.edit__block-edit-toggle').click();
  await row.locator('.edit__block-edit-input').fill(nextExpression);
  await row.locator('.edit__block-edit-save').click();
  await expect(row.locator('.edit__block-current')).toHaveText(nextExpression);
}

/**
 * 編集メモを入力する。
 *
 * メモ欄は `input` イベントで store へ入る（PR #43 で change → input に変更）ため、
 * `fill()` が発火させる input イベントの時点で反映済みで、blur を挟む必要はない。
 */
async function fillNote(page: Page, note: string): Promise<void> {
  await page.locator('input.edit__note-input').fill(note);
  await expect(page.locator('input.edit__note-input')).toHaveValue(note);
}

/** 「AI に改善させる」→「改善案を取得」を実行し、提案 diff が出るまで待つ。 */
async function runBlockImprovement(page: Page, blockId: string): Promise<void> {
  const row = page.locator(`.edit__block-row[data-block-id="${blockId}"]`);
  await row.locator('.edit__block-improve').click();
  await expect(row.locator('.edit__block-ai-submit')).toBeVisible();
  await row.locator('.edit__block-ai-submit').click();
  await expect(row.locator('.edit__block-rationale')).toContainText('ECLS', { timeout: 15_000 });
}

test.describe('journey-edit-save (J6 / issue #42)', () => {
  test('保存 → 「保存中…」→「保存しました（version_id: …）」が押した後も残る', async ({ page }) => {
    // append を遅らせて「保存中…」を確実に観測する
    await setupEditScenario(page, { appendDelayMs: 800 });
    await page.goto(APP_URL);

    await editBlockInline(page, '1', '"ARDS"[tiab] OR "acute lung injury"[tiab]');
    await fillNote(page, '#1 に acute lung injury を追加');

    const saveBtn = page.locator('.edit__actions button');
    const status = page.locator('p.edit__status');
    await saveBtn.click();

    // 押した瞬間: 保存中 + 二重押し防止
    await expect(status).toHaveText('保存中…');
    await expect(saveBtn).toBeDisabled();

    // 完了後: 確認メッセージが「出たまま残る」（旧実装ではここが空だった）
    await expect(status).toHaveText(SAVED_MESSAGE_RE, { timeout: 15_000 });
    await expect(saveBtn).toBeEnabled();
    await expect(page.locator('p.edit__error')).toHaveText('');
    // 待たずにもう一度確かめる: 一過性の表示ではないこと
    await page.waitForTimeout(1000);
    await expect(status).toHaveText(SAVED_MESSAGE_RE);
  });

  test('保存成功で編集メモは空に戻り、#/history に新バージョンが増える', async ({ page }) => {
    const fake = await setupEditScenario(page);
    await page.goto(APP_URL);

    await editBlockInline(page, '2', '"ECMO"[tiab] OR "ECLS"[tiab]');
    await fillNote(page, '#2 に ECLS を追加');
    await page.locator('.edit__actions button').click();
    await expect(page.locator('p.edit__status')).toHaveText(SAVED_MESSAGE_RE, { timeout: 15_000 });

    // 版が変わってメモは stale → 空に戻る
    await expect(page.locator('input.edit__note-input')).toHaveValue('');

    // Sheets には note 付きで 1 行追記されている
    const savedRows = fake.tabs['FormulaVersions'] ?? [];
    const appended = savedRows[savedRows.length - 1] ?? [];
    expect(appended[FORMULA_VERSIONS_HEADER.indexOf('created_by')]).toBe('user_edit');
    expect(appended[FORMULA_VERSIONS_HEADER.indexOf('note')]).toBe('#2 に ECLS を追加');
    expect(appended[FORMULA_VERSIONS_HEADER.indexOf('parent_version_id')]).toBe('fv-20260420-01');
    expect(appended[FORMULA_VERSIONS_HEADER.indexOf('formula_md')]).toContain('ECLS');

    // #/history にも 2 件目として出る
    await page.evaluate(() => {
      window.location.hash = '#/history';
    });
    await expect(page.locator('.history__item')).toHaveCount(2);
    await expect(page.locator('.history__item').first()).toContainText('user_edit');
    await expect(page.locator('.history__note').first()).toHaveText('#2 に ECLS を追加');
  });

  test('保存メッセージは AI 改善による全ビュー再描画のあとも消えない（#42 の本丸）', async ({
    page,
  }) => {
    await setupEditScenario(page);
    await page.goto(APP_URL);

    const context = page.locator('#app-context');
    await expect(context).toContainText('累積 $0.1200');

    await editBlockInline(page, '1', '"ARDS"[tiab] OR "ALI"[tiab]');
    await page.locator('.edit__actions button').click();
    const status = page.locator('p.edit__status');
    await expect(status).toHaveText(SAVED_MESSAGE_RE, { timeout: 15_000 });
    const savedMessage = (await status.textContent()) ?? '';

    // 別ブロックで AI 改善 → LLM コスト集計の setState で全ビューが再描画される
    await runBlockImprovement(page, '2');
    await expect(context).toContainText('累積 $0.1305');

    // 再描画後もメッセージが同じ内容で残っていること
    await expect(status).toHaveText(savedMessage);
    expect(savedMessage).toMatch(SAVED_MESSAGE_RE);
  });

  test('編集メモは打鍵中に編集フォームを壊さず、再描画後も残る', async ({ page }) => {
    await setupEditScenario(page);
    await page.goto(APP_URL);

    // 鉛筆編集フォームと AI 指示欄を開いたまま、メモを打鍵する
    const row1 = page.locator('.edit__block-row[data-block-id="1"]');
    const row2 = page.locator('.edit__block-row[data-block-id="2"]');
    await row1.locator('.edit__block-edit-toggle').click();
    await expect(row1.locator('.edit__block-edit-input')).toBeVisible();
    await row2.locator('.edit__block-improve').click();
    await expect(row2.locator('.edit__block-ai-instruction')).toBeVisible();

    const note = page.locator('input.edit__note-input');
    await note.click();
    await note.pressSequentially('MeSH 追加の検討メモ', { delay: 30 });

    // 打鍵は setStateSilently（購読者へ通知しない）で store に入るので、そもそも
    // 再描画が起きない。開いているフォームは閉じない。
    await expect(row1.locator('.edit__block-edit-input')).toBeVisible();
    await expect(row2.locator('.edit__block-ai-instruction')).toBeVisible();
    await expect(note).toHaveValue('MeSH 追加の検討メモ');

    // フォーカスを外しても（PR #43 修正前の change イベントと違い）もう再描画は
    // 起きないため、開いたフォームはそのまま残る。
    await page.locator('h2').first().click();
    await expect(note).toHaveValue('MeSH 追加の検討メモ');
    await expect(row2.locator('.edit__block-ai-instruction')).toBeVisible();

    // ここで初めて AI 改善を実際に実行し、LLM コスト集計の setState による本物の
    // 全ビュー再描画を誘発してもメモが残ることを見る。row2 の指示フォームは開いた
    // ままなので送信ボタンを直接押す（runBlockImprovement は「閉じた状態から開く」
    // 前提のヘルパなので、既に開いているこのケースでは使わない）。
    await row2.locator('.edit__block-ai-submit').click();
    await expect(row2.locator('.edit__block-rationale')).toContainText('ECLS', {
      timeout: 15_000,
    });
    await expect(note).toHaveValue('MeSH 追加の検討メモ');
  });

  test('保存後に md を編集し直すと「保存しました」は消える', async ({ page }) => {
    await setupEditScenario(page);
    await page.goto(APP_URL);

    await page.locator('.edit__actions button').click();
    const status = page.locator('p.edit__status');
    await expect(status).toHaveText(SAVED_MESSAGE_RE, { timeout: 15_000 });

    // 未保存の編集が生まれた時点で、直前の保存ステータスは現在の内容を説明しない
    await editBlockInline(page, '1', '"ARDS"[tiab] OR "ARF"[tiab]');
    await expect(status).toHaveText('');
    await expect(page.locator('.edit__actions button')).toBeEnabled();
  });

  /**
   * PR #43 で新たに入った回帰の再発防止テスト（修正確認済み）。
   *
   * 直っていた当時、編集メモは `change`（blur / Enter）で store へ入っており、その
   * setState は同期的に全ビュー再描画を起こし、editView は `container.innerHTML = ''` で
   * DOM を作り直していた。メモ欄から直接ボタンを押すと、押し下げ（mousedown）で
   * blur → change → 再描画 が走り、mousedown を受けたボタンが DOM から外れる。離した先は
   * **別ノード**になるためブラウザは click を合成せず、1 回目の押下が丸ごと飲まれていた。
   * 実測イベント列: mousedown:BUTTON → change:INPUT → mouseup:BUTTON（click 無し）。
   *
   * 症状は issue #42 と同じ「押しても何も起きない」で、保存だけでなく
   * 「AI に改善させる」「鉛筆」でも同様に 1 回目が効かなかった。
   *
   * 修正: 編集メモを `input` イベントの打鍵ごとに store.setStateSilently（購読者へ通知しない
   * ＝再描画を起こさない）で書き込むようにし、「打鍵が再描画を誘発する」経路そのものを
   * 無くした（src/app/store.ts の `setStateSilently` / `FormulaEditNote` doc コメント参照）。
   */
  test('編集メモを打った直後に保存を押すと 1 回目のクリックで保存が始まる', async ({ page }) => {
    await setupEditScenario(page);
    await page.goto(APP_URL);

    // 実ユーザーの操作: メモを書いて、そのまま保存を押す（間にどこもクリックしない）
    const note = page.locator('input.edit__note-input');
    await note.click();
    await note.pressSequentially('#1 の同義語を追加', { delay: 20 });
    await page.locator('.edit__actions button').click();

    await expect(page.locator('p.edit__status')).toHaveText(SAVED_MESSAGE_RE, {
      timeout: 10_000,
    });
  });

  test('保存失敗はエラー行に出て、ステータスは空・ボタンは再度押せる', async ({ page }) => {
    await setupEditScenario(page, { failAppendTabs: ['FormulaVersions'] });
    await page.goto(APP_URL);

    await editBlockInline(page, '1', '"ARDS"[tiab] OR "ALI"[tiab]');
    const saveBtn = page.locator('.edit__actions button');
    await saveBtn.click();

    const error = page.locator('p.edit__error');
    await expect(error).toContainText('HTTP 500', { timeout: 15_000 });
    await expect(error).toContainText('FormulaVersions への追記に失敗しました（stub）');
    await expect(page.locator('p.edit__status')).toHaveText('');
    await expect(saveBtn).toBeEnabled();
  });
});
