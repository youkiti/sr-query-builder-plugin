/**
 * 第 10 章「検索式を編集して新しいバージョンを保存する」
 *
 * AI 改善提案の採用 → 新バージョンとして保存 → 履歴で確認、まで。
 *
 * ## AI 改善提案は issue #39 の修正で実演できるようになった
 *
 * 以前は「改善案を取得」を押しても提案もエラーも出なかった（LLM コスト集計の `setState` が
 * 全ビュー再描画を起こし、`.then()` の書き込み先 DOM が切り離されていた）。修正で
 * `blockImprovement` / `formulaEditDraft` が store に載り、再描画に耐えるようになったため、
 * §4 が当初から想定していた「AI 改善を実演する」構成に戻してある。
 *
 * ## 「保存しました」は issue #42 の修正で画面に残るようになった
 *
 * 以前は `p.edit__status` の「保存しました（version_id: …）」が保存完了の再描画で消えていた
 * （提案と編集中 md は #39 で store 化されたが、保存ステータスはローカル DOM のままだった）。
 * `formulaSave` / `formulaEditNote` の store 化で残るようになったので、完了判定には
 * ステータス文言そのものを使う。証拠としての履歴（増えた行）はそのまま見せる。
 *
 * ## 「編集 → 再検証で 100%」はライブで実演できない（実装の制約。#39 とは別）
 *
 * `#/draft` の「再生成して再検証する」は `blocksDraft` から LLM で作り直す処理で、
 * `currentFormulaMarkdown` を入力に取らないため手編集の内容が失われる。検証だけを
 * 再実行する導線も無い。よって cue 06 では `11-export` プリセット（v2-demo・捕捉率 100%）
 * へ切り替えて「保存済みの新バージョンではこうなる」と見せる。
 *
 * なお AI 提案が返す式は `buildBlockExpressions({ ecmo: [ECMO_MESH_ADDITION] })` 由来で、
 * **v2-demo の #2 と文字列まで一致する**（`src/demo/llmFixtures.ts`。回帰テストで固定済み）。
 * 章 10 で採用した式と、章 11 で映る式が別表記に見えないようにするため。
 *
 * ## セレクタの注意
 *
 * - 鉛筆 `.edit__block-edit-toggle` は CSS で通常は不可視。行を hover して初めて現れる
 * - 各種 `.edit__block-*` は 4 行ぶんあるので `li.edit__block-row[data-block-id="2"]` で絞る
 * - 提案パネルは `.edit__block-rationale`（理由）/ `.edit__block-diff-before` /
 *   `.edit__block-diff-after` / `.edit__block-accept` / `.edit__block-reject`
 *
 * demoLatency=6: 改善提案は LLM 1 回で等倍 1 秒弱。「改善提案を取得中…」を読ませるため
 * 6 倍（実測 5.9 秒）にする。
 */

import { hoverSlow } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';

export default {
    id: '10',
    slug: 'edit',
    title: '検索式を編集して新しいバージョンを保存する',
    narration: '10-edit',

    async run(ctx) {
        const durations = loadCueDurations('10-edit');

        await ctx.openExtensionPage('app/app.html?demoSeed=10-edit&demoLatency=6#/edit');
        await ctx.page.locator('.edit__actions button').waitFor({ state: 'visible', timeout: 25000 });
        await ctx.sleep(800);

        const block2 = ctx.page.locator('li.edit__block-row[data-block-id="2"]');

        // --- cue 01: 直し方は二通り（鉛筆 / AI） ---
        ctx.cue(1);
        const cue1StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('p.edit__lead'), { durationMs: 1000 });
        await ctx.sleep(1400);
        // 鉛筆は行を hover しないと現れない
        await hoverSlow(ctx.page, block2.locator('pre.edit__block-current'), { durationMs: 800 });
        await ctx.sleep(600);
        await hoverSlow(ctx.page, block2.locator('button.edit__block-edit-toggle'), { durationMs: 700 });
        await ctx.sleep(1000);
        await hoverSlow(ctx.page, block2.locator('button.edit__block-improve'), { durationMs: 800 });
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        // --- cue 02: AI に改善させる → 指示欄 → 改善案を取得 ---
        ctx.cue(2);
        const cue2StartedAt = Date.now();
        const improveBtn = block2.locator('button.edit__block-improve');
        await hoverSlow(ctx.page, improveBtn, { durationMs: 600 });
        await improveBtn.click();
        const instruction = block2.locator('textarea.edit__block-ai-instruction');
        await instruction.waitFor({ state: 'visible', timeout: 15000 });
        await ctx.sleep(1200);
        await hoverSlow(ctx.page, instruction, { durationMs: 900 });
        await ctx.sleep(3200);
        const submitBtn = block2.locator('button.edit__block-ai-submit');
        await hoverSlow(ctx.page, submitBtn, { durationMs: 700 });
        await submitBtn.click();
        // 「改善提案を取得中…」を映す
        await block2.locator('p.edit__block-pending').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);

        // --- 提案の到着を待つ（カーソルを動かしたまま） ---
        const accept = block2.locator('button.edit__block-accept');
        const deadline = Date.now() + 90000;
        while (!(await accept.isVisible().catch(() => false))) {
            if (Date.now() > deadline) {
                throw new Error('[10-edit] 改善提案が 90 秒たっても表示されませんでした');
            }
            await hoverSlow(ctx.page, block2.locator('p.edit__block-pending'), { durationMs: 600 }).catch(() => {});
            await ctx.sleep(400);
        }
        await ctx.sleep(500);

        // --- cue 03: 理由と Before / After ---
        ctx.cue(3);
        const cue3StartedAt = Date.now();
        await hoverSlow(ctx.page, block2.locator('p.edit__block-rationale'), { durationMs: 1000 });
        await ctx.sleep(3400);
        await hoverSlow(ctx.page, block2.locator('.edit__block-diff-before'), { durationMs: 900 });
        await ctx.sleep(1600);
        await hoverSlow(ctx.page, block2.locator('.edit__block-diff-after'), { durationMs: 900 });
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);

        // --- cue 04: 採用（破棄も指しておく）→ 式に反映 ---
        ctx.cue(4);
        const cue4StartedAt = Date.now();
        await hoverSlow(ctx.page, block2.locator('button.edit__block-reject'), { durationMs: 700 });
        await ctx.sleep(900);
        await hoverSlow(ctx.page, accept, { durationMs: 700 });
        await accept.click();
        await block2.locator('pre.edit__block-current')
            .filter({ hasText: '[Mesh]' })
            .waitFor({ state: 'visible', timeout: 20000 })
            .catch(() => {});
        await ctx.sleep(800);
        await hoverSlow(ctx.page, block2.locator('pre.edit__block-current'), { durationMs: 900 });
        await ctx.sleep(2000);
        // 「鉛筆で手直しもできる」の指し先
        await hoverSlow(ctx.page, block2.locator('button.edit__block-edit-toggle'), { durationMs: 800 });
        await sleepRemainder(ctx, cue4StartedAt, durations['04'] * 1000 + 500);

        // --- cue 05: 編集メモ → 新バージョンとして保存 → 履歴で確認 ---
        ctx.cue(5);
        const cue5StartedAt = Date.now();
        const note = ctx.page.locator('input.edit__note-input');
        await hoverSlow(ctx.page, note, { durationMs: 600 });
        await note.click();
        await note.pressSequentially('ブロック #2 に MeSH タグを追加', { delay: 60 });
        await ctx.sleep(500);
        const saveVersion = ctx.page.locator('.edit__actions button');
        await hoverSlow(ctx.page, saveVersion, { durationMs: 700 });
        await saveVersion.click();
        // 「保存しました（version_id: …）」は store 保持なので再描画後も残る（#42）
        const savedStatus = ctx.page.locator('p.edit__status');
        await savedStatus
            .filter({ hasText: '保存しました' })
            .waitFor({ state: 'visible', timeout: 30000 })
            .catch(() => {});
        await hoverSlow(ctx.page, savedStatus, { durationMs: 700 });
        await ctx.sleep(500);
        // 保存の証拠は履歴に増えた行そのもの。アプリ内遷移（リロード無し）で開く
        await ctx.page.locator('#app-sidebar .app__nav-list button').filter({ hasText: '履歴' }).click();
        await ctx.page.locator('li.history__item').first()
            .waitFor({ state: 'visible', timeout: 25000 })
            .catch(() => {});
        await hoverSlow(ctx.page, ctx.page.locator('li.history__item').first(), { durationMs: 900 });
        await sleepRemainder(ctx, cue5StartedAt, durations['05'] * 1000 + 500);

        // --- cue 06: 保存済みの新バージョン（v2-demo）での検証結果 ---
        await ctx.openExtensionPage('app/app.html?demoSeed=11-export&demoLatency=0#/draft');
        await ctx.page.locator('.validate__final').waitFor({ state: 'visible', timeout: 25000 });
        await ctx.sleep(700);

        ctx.cue(6);
        const cue6StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('p.draft__info'), { durationMs: 800 });
        await ctx.sleep(1200);
        const finalParas = ctx.page.locator('.validate__final > p');
        await hoverSlow(ctx.page, finalParas.nth(1), { durationMs: 900 }); // 捕捉率
        await ctx.sleep(2200);
        await hoverSlow(ctx.page, ctx.page.locator('.draft__formula'), { durationMs: 900 });
        await sleepRemainder(ctx, cue6StartedAt, durations['06'] * 1000 + 500);
    },
};
