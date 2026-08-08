/**
 * 第 4 章「研究プロトコルを入力する」
 *
 * 手入力でプロトコル全文を貼り、解析 → #/blocks へ自動遷移するまで。
 *
 * **.docx には触れない。** `fflate` ベースで実装済みだが（`src/features/protocol/docxText.ts`）、
 * 本動画では収録スコープを絞る判断として扱わない（§4 章立ての注意 4）。
 * 入力形式のラジオは「手入力」「ファイルアップロード (.md / .docx)」の 2 択で、
 * .md と .docx は同じラジオに同居する。ラベルは映るが、原稿では
 * 「Markdown ファイル」とだけ言い、.docx を操作も説明もしない。
 *
 * demoLatency=8: extract-protocol は LLM 1 回なので等倍だと 0.6 秒で終わってしまい、
 * 進捗インジケータが映らない。8 倍で約 6.9 秒かかり、
 * 「AI がプロトコルを読み取り中…」→「AI がブロック候補を抽出中…」の
 * 2 段階が両方とも画面に出る（実測で確認済み）。
 */

import { hoverSlow } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';

/** 画面に貼り付けるプロトコル本文（架空。§6-3 の筋書きに合わせた ARDS/ECMO の例） */
const PROTOCOL_TEXT = `# 研究プロトコル

## リサーチクエスチョン
成人 ARDS に対する ECMO は生存率を改善するか

## PICO
- P: 成人（18 歳以上）の急性呼吸窮迫症候群（ARDS）患者
- I: 体外式膜型人工肺（ECMO）
- C: 通常の人工呼吸管理
- O: 院内死亡・28 日死亡

## 組入基準
- ランダム化比較試験
- 18 歳以上の成人を対象とした研究

## 除外基準
- 小児を対象とした研究
- 症例報告・総説・レター`;

export default {
    id: '04',
    slug: 'protocol',
    title: '研究プロトコルを入力する',
    narration: '04-protocol',

    async run(ctx) {
        const durations = loadCueDurations('04-protocol');

        await ctx.openExtensionPage('app/app.html?demoSeed=04-protocol&demoLatency=8#/protocol');
        await ctx.page.locator('button.protocol__submit').waitFor({ state: 'visible', timeout: 20000 });
        await ctx.sleep(800);

        // --- cue 01: この画面の役割と入力方式 ---
        ctx.cue(1);
        const cue1StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#app-content h2'), { durationMs: 900 });
        await ctx.sleep(1100);
        await hoverSlow(ctx.page, ctx.page.locator('.protocol__lead'), { durationMs: 1000 });
        await ctx.sleep(1400);
        await hoverSlow(ctx.page, ctx.page.locator('label.protocol__source-option').first(), { durationMs: 800 });
        await ctx.sleep(900);
        await hoverSlow(ctx.page, ctx.page.locator('label.protocol__source-option').nth(1), { durationMs: 800 });
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        // --- cue 02: 入力欄の説明 ---
        ctx.cue(2);
        const cue2StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('textarea#inline'), { durationMs: 1000 });
        await ctx.sleep(2500);
        await hoverSlow(ctx.page, ctx.page.locator('.protocol__hint').first(), { durationMs: 900 });
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);

        // --- cue 03: 本文を打ち込む（PICO の中身を語りながら）---
        ctx.cue(3);
        const cue3StartedAt = Date.now();
        await ctx.page.locator('textarea#inline').click();
        // ナレーション約 30 秒。全文を打つと長すぎるので、見出しだけ実打鍵して
        // 残りは一括投入し、最後にゆっくりスクロールして全体を見せる。
        await ctx.page.locator('textarea#inline').pressSequentially(PROTOCOL_TEXT.slice(0, 90), { delay: 42 });
        await ctx.page.locator('textarea#inline').fill(PROTOCOL_TEXT);
        await ctx.sleep(900);
        await hoverSlow(ctx.page, ctx.page.locator('textarea#inline'), { durationMs: 900 });
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);

        // --- cue 04: ファイルアップロードという選択肢 ---
        ctx.cue(4);
        const cue4StartedAt = Date.now();
        // ラジオを切り替えてファイル選択欄を見せ、手入力へ戻す（本文は保持される）
        await ctx.page.locator('input[name="sourceMode"][value="file"]').check();
        await ctx.page.locator('input#file').waitFor({ state: 'visible', timeout: 10000 });
        await hoverSlow(ctx.page, ctx.page.locator('label.protocol__file'), { durationMs: 1000 });
        await ctx.sleep(2400);
        await ctx.page.locator('input[name="sourceMode"][value="manual"]').check();
        await ctx.page.locator('textarea#inline').waitFor({ state: 'visible', timeout: 10000 });
        await sleepRemainder(ctx, cue4StartedAt, durations['04'] * 1000 + 500);

        // --- cue 05: 解析ボタン → 進捗 2 段階 ---
        ctx.cue(5);
        const cue5StartedAt = Date.now();
        // ラジオを戻した際に本文が消えていないことを確認してから押す
        if (!(await ctx.page.locator('textarea#inline').inputValue())) {
            await ctx.page.locator('textarea#inline').fill(PROTOCOL_TEXT);
        }
        await hoverSlow(ctx.page, ctx.page.locator('button.protocol__submit'), { durationMs: 800 });
        await ctx.page.locator('button.protocol__submit').click();
        await ctx.page.locator('#protocol-progress').waitFor({ state: 'visible', timeout: 15000 });
        await hoverSlow(ctx.page, ctx.page.locator('#protocol-progress'), { durationMs: 900 });
        await sleepRemainder(ctx, cue5StartedAt, durations['05'] * 1000 + 500);

        // --- cue 06: #/blocks へ自動遷移 ---
        await ctx.page.waitForFunction(() => window.location.hash === '#/blocks', { timeout: 60000 });
        await ctx.page.locator('button.blocks__btn-primary').waitFor({ state: 'visible', timeout: 20000 });
        await ctx.sleep(600);

        ctx.cue(6);
        const cue6StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#app-content h2'), { durationMs: 900 });
        await ctx.sleep(1000);
        await hoverSlow(ctx.page, ctx.page.locator('ol.blocks__list'), { durationMs: 1000 });
        await sleepRemainder(ctx, cue6StartedAt, durations['06'] * 1000 + 500);
    },
};
