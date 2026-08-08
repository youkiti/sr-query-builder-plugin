/**
 * 第 10 章「検索式を編集して新しいバージョンを保存する」
 *
 * 第 9 章で出た更新提案を手で式に反映し、新バージョンとして保存するまで。
 *
 * ## AI 改善提案は扱わない（意図的）
 *
 * 「AI に改善させる」→「改善案を取得」は **issue #39 の不具合で提案が表示されない**
 * （LLM コスト更新による全ビュー再描画で、提案の描画先 DOM が破棄される）。
 * 機能が失敗する絵をチュートリアルに載せないという原則（README の DO / DON'T）に従い、
 * この章では**壊れていない手動編集の経路だけ**を扱う。#39 が解決したら AI 改善を
 * 追加収録して章を差し替える。
 *
 * ## 「編集 → 再検証で 100%」はライブで実演できない（実装の制約）
 *
 * `#/draft` の「再生成して再検証する」は `blocksDraft` から LLM で作り直す処理で、
 * `currentFormulaMarkdown` を入力に取らないため**手編集の内容が失われる**。
 * 検証だけを再実行する導線も無い。したがって cue 05 では `11-export` プリセット
 * （v2-demo・捕捉率 100% を事前投入済み）へ切り替えて「保存済みの新バージョンでは
 * こうなる」と見せる。ナレーションもその言い方に合わせてある。
 *
 * ## 「保存しました」は画面に残らない（#39 と同じ再描画が原因）
 *
 * `saveEditedFormula` の `setState` が `store.subscribe(render)` を叩いて**全ビューを
 * 描き直す**ため、`p.edit__status` に入った「保存しました（version_id: …）」は
 * 出た瞬間に破棄される（編集メモの入力欄も同時に空になる）。bootstrap.ts:470-475 の
 * コメントが同じ現象を記録しており、expand ビューはローカル DOM を使わず store に
 * 持たせることで回避している。
 *
 * **保存そのものは成功している**（実測: `user_edit` の新バージョンが親 v1-demo 付きで
 * FormulaVersions に追記される）。よってこのシーンは消える確認メッセージを待たず、
 * **アプリ内遷移で履歴を開き、増えた行そのものを証拠として見せる**。
 * 完了判定にはステータス文言ではなく「編集メモが再描画で空になること」を使う。
 *
 * ## セレクタの注意
 *
 * 鉛筆アイコン `.edit__block-edit-toggle` は **CSS で通常は不可視**、行の hover /
 * focus-within でだけ現れる。**必ず先に行をホバーしてからクリックする**。
 * 各種 `.edit__block-*` は 4 行ぶんあるので `li.edit__block-row[data-block-id="2"]` で絞る。
 *
 * demoLatency=1: この画面に多段の進捗表示は無く、伸ばす意味がない。等倍で 4〜6 秒。
 */

import { hoverSlow } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';

/** 第 9 章の更新提案どおり、ECMO ブロックへ MeSH タグを足した式 */
const EDITED_BLOCK_2 =
    '("ECMO"[tiab] OR "extracorporeal membrane oxygenation"[tiab] OR "Extracorporeal Membrane Oxygenation"[Mesh])';

export default {
    id: '10',
    slug: 'edit',
    title: '検索式を編集して新しいバージョンを保存する',
    narration: '10-edit',

    async run(ctx) {
        const durations = loadCueDurations('10-edit');

        await ctx.openExtensionPage('app/app.html?demoSeed=10-edit&demoLatency=1#/edit');
        await ctx.page.locator('.edit__actions button').waitFor({ state: 'visible', timeout: 25000 });
        await ctx.sleep(800);

        const block2 = ctx.page.locator('li.edit__block-row[data-block-id="2"]');

        // --- cue 01: この画面で何ができるか ---
        ctx.cue(1);
        const cue1StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('p.edit__lead'), { durationMs: 1000 });
        await ctx.sleep(1600);
        await hoverSlow(ctx.page, ctx.page.locator('ul.edit__block-list'), { durationMs: 900 });
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        // --- cue 02: 行をホバー → 鉛筆が出る → 押すと編集できる ---
        ctx.cue(2);
        const cue2StartedAt = Date.now();
        // 鉛筆は hover しないと現れないので、まず行の現式部分へカーソルを寄せる
        await hoverSlow(ctx.page, block2.locator('pre.edit__block-current'), { durationMs: 900 });
        await ctx.sleep(1100);
        const pencil = block2.locator('button.edit__block-edit-toggle');
        await hoverSlow(ctx.page, pencil, { durationMs: 700 });
        await ctx.sleep(600);
        await pencil.click();
        await block2.locator('textarea.edit__block-edit-input')
            .waitFor({ state: 'visible', timeout: 15000 });
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);

        // --- cue 03: 語を書き足して保存（画面の中だけ） ---
        ctx.cue(3);
        const cue3StartedAt = Date.now();
        const input = block2.locator('textarea.edit__block-edit-input');
        await input.click();
        await input.fill(EDITED_BLOCK_2);
        await ctx.sleep(700);
        const saveLine = block2.locator('button.edit__block-edit-save');
        await hoverSlow(ctx.page, saveLine, { durationMs: 600 });
        await saveLine.click();
        await block2.locator('pre.edit__block-current')
            .filter({ hasText: '[Mesh]' })
            .waitFor({ state: 'visible', timeout: 15000 })
            .catch(() => {});
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);

        // --- cue 04: 編集メモ → 新バージョンとして保存 ---
        ctx.cue(4);
        const cue4StartedAt = Date.now();
        const note = ctx.page.locator('input.edit__note-input');
        await hoverSlow(ctx.page, note, { durationMs: 700 });
        await note.click();
        await note.pressSequentially('ブロック #2 に MeSH タグを追加', { delay: 65 });
        await ctx.sleep(600);
        const saveVersion = ctx.page.locator('.edit__actions button');
        await hoverSlow(ctx.page, saveVersion, { durationMs: 700 });
        await saveVersion.click();
        // 「保存しました」は再描画で消えるので、代わりに編集メモが空に戻ったことを完了判定に使う
        await ctx.page.locator('input.edit__note-input')
            .filter({ hasNotText: /./ })
            .waitFor({ state: 'visible', timeout: 30000 })
            .catch(() => {});
        await ctx.page.waitForFunction(
            () => document.querySelector('input.edit__note-input')?.value === '',
            undefined,
            { timeout: 30000 }
        ).catch(() => {});
        await ctx.sleep(600);
        // 保存された証拠は履歴に出る行そのもの。アプリ内遷移（リロード無し）で開く
        await ctx.page.locator('#app-sidebar .app__nav-list button').filter({ hasText: '履歴' }).click();
        await ctx.page.locator('li.history__item').first()
            .waitFor({ state: 'visible', timeout: 25000 })
            .catch(() => {});
        await hoverSlow(ctx.page, ctx.page.locator('li.history__item').first(), { durationMs: 900 });
        await sleepRemainder(ctx, cue4StartedAt, durations['04'] * 1000 + 500);

        // --- cue 05: 保存済みの新バージョン（v2-demo）での検証結果 ---
        // ライブ再検証は実装上できないため、11-export プリセットの結果画面へ切り替える。
        await ctx.openExtensionPage('app/app.html?demoSeed=11-export&demoLatency=0#/draft');
        await ctx.page.locator('.validate__final').waitFor({ state: 'visible', timeout: 25000 });
        await ctx.sleep(700);

        ctx.cue(5);
        const cue5StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('p.draft__info'), { durationMs: 800 });
        await ctx.sleep(1200);
        const finalParas = ctx.page.locator('.validate__final > p');
        await hoverSlow(ctx.page, finalParas.nth(1), { durationMs: 900 }); // 捕捉率
        await ctx.sleep(2200);
        await hoverSlow(ctx.page, ctx.page.locator('.draft__formula'), { durationMs: 900 });
        await sleepRemainder(ctx, cue5StartedAt, durations['05'] * 1000 + 500);
    },
};
