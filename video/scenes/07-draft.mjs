/**
 * 第 7 章「検索式を生成して検証する」
 *
 * 「生成して検証する」を 1 回押して、20 ステップのトラッカーと
 * ブロックごとのヒット数のライブ表示を見せ、完成した検索式を読むところまで。
 *
 * **結果の読み方には踏み込まない。** 捕捉率・MeSH の解釈は第 8 章の担当
 * （§4 の「07 と 08 を分ける理由」）。この章は「操作して待つ」で切り、
 * 最後の cue で次章に渡す。
 *
 * ## demoLatency=5.4 の根拠
 *
 * 実行中に流れるナレーションは cue 02〜05 の 4 本で合計 62.3 秒。
 * 実測は係数 3 で 35.1 秒、係数 4 で 46.6 秒（傾き ≒ 11.5 秒／係数 1）なので、
 * 62 秒に合わせるには 5.4 倍が要る。ここがずれると、ナレーションが
 * 「いま生成中です」と言っているのに画面が終わっている（または逆）ことになる。
 * 実 API でも LLM 9 回ぶんで 30〜60 秒はかかるので、映像としても妥当な範囲。
 *
 * セレクタの注意: 「生成して検証する」ボタンには id も class も無い。
 * `.draft__actions button` で取る（この div の子はこのボタン 1 つだけ）。
 * また `li.draft__block-hit` は**実行中のみ描画される**ので、完了後には消える。
 */

import { hoverSlow, smoothWheel } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';

export default {
    id: '07',
    slug: 'draft',
    title: '検索式を生成して検証する',
    narration: '07-draft',

    async run(ctx) {
        const durations = loadCueDurations('07-draft');

        await ctx.openExtensionPage('app/app.html?demoSeed=07-draft&demoLatency=5.4#/draft');
        await ctx.page.locator('.draft__actions button').waitFor({ state: 'visible', timeout: 20000 });
        await ctx.sleep(800);

        // --- cue 01: この画面は何をするところか（実行前）---
        ctx.cue(1);
        const cue1StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#app-content h2'), { durationMs: 900 });
        await ctx.sleep(1300);
        await hoverSlow(ctx.page, ctx.page.locator('#app-context'), { durationMs: 900 });
        await ctx.sleep(1600);
        await hoverSlow(ctx.page, ctx.page.locator('.draft__actions button'), { durationMs: 1000 });
        await ctx.sleep(2000);
        await hoverSlow(ctx.page, ctx.page.locator('#app-sidebar .app__nav-list button').filter({ hasText: 'シード論文' }), { durationMs: 900 });
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        // --- cue 02: 押す。トラッカーが出る ---
        ctx.cue(2);
        const cue2StartedAt = Date.now();
        const runButton = ctx.page.locator('.draft__actions button');
        await hoverSlow(ctx.page, runButton, { durationMs: 600 });
        await runButton.click();
        await ctx.page.locator('.draft__tracker').waitFor({ state: 'visible', timeout: 30000 });
        await hoverSlow(ctx.page, ctx.page.locator('.draft__step-counter'), { durationMs: 800 });
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);

        // --- cue 03: 生成フェーズ。ブロックごとに 4 工程 ---
        ctx.cue(3);
        const cue3StartedAt = Date.now();
        const genPhase = ctx.page.locator('.draft__phase').first();
        await hoverSlow(ctx.page, genPhase.locator('.draft__phase-label'), { durationMs: 800 });
        await ctx.sleep(1000);
        // ブロック 1 の 4 つのチップ（骨格 / MeSH / フリーワード / 件数）をなぞる
        const firstBlockSteps = genPhase.locator('.draft__step-block').first().locator('.draft__step');
        const chipCount = await firstBlockSteps.count();
        for (let i = 0; i < chipCount; i++) {
            await hoverSlow(ctx.page, firstBlockSteps.nth(i), { durationMs: 600 });
            await ctx.sleep(800);
        }
        await ctx.sleep(1200);
        await hoverSlow(ctx.page, ctx.page.locator('.draft__status'), { durationMs: 800 });
        await ctx.sleep(1500);
        await hoverSlow(ctx.page, ctx.page.locator('.draft__progressbar'), { durationMs: 800 });
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);

        // --- cue 04: ブロックごとのヒット数がライブで埋まる ---
        ctx.cue(4);
        const cue4StartedAt = Date.now();
        const blockHits = ctx.page.locator('li.draft__block-hit');
        const hitCount = await blockHits.count();
        for (let i = 0; i < hitCount; i++) {
            await hoverSlow(ctx.page, blockHits.nth(i), { durationMs: 700 });
            await ctx.sleep(1400);
        }
        await hoverSlow(ctx.page, ctx.page.locator('.draft__block-hits'), { durationMs: 900 });
        await sleepRemainder(ctx, cue4StartedAt, durations['04'] * 1000 + 500);

        // --- cue 05: 検証フェーズ ---
        ctx.cue(5);
        const cue5StartedAt = Date.now();
        const validationPhase = ctx.page.locator('.draft__phase').nth(1);
        if (await validationPhase.count()) {
            await hoverSlow(ctx.page, validationPhase.locator('.draft__phase-label'), { durationMs: 800 });
            await ctx.sleep(900);
            const valChips = validationPhase.locator('.draft__step');
            const valCount = await valChips.count();
            for (let i = 0; i < valCount; i++) {
                await hoverSlow(ctx.page, valChips.nth(i), { durationMs: 550 });
                await ctx.sleep(600);
            }
        }
        await hoverSlow(ctx.page, ctx.page.locator('.draft__status'), { durationMs: 800 });
        await sleepRemainder(ctx, cue5StartedAt, durations['05'] * 1000 + 500);

        // --- cue 06: 完成した検索式 ---
        // ここまでで実行が終わっている想定。念のため完了を待ってから読み始める。
        await ctx.page.locator('.draft__validate-status').waitFor({ state: 'visible', timeout: 120000 });
        await ctx.page.locator('.draft__formula').waitFor({ state: 'visible', timeout: 30000 });
        await ctx.sleep(700);

        ctx.cue(6);
        const cue6StartedAt = Date.now();
        await smoothWheel(ctx.page, -400, { steps: 12, stepDelayMs: 80 });
        await ctx.sleep(500);
        const formulaLines = ctx.page.locator('.draft__block');
        const lineCount = await formulaLines.count();
        for (let i = 0; i < lineCount; i++) {
            await hoverSlow(ctx.page, formulaLines.nth(i), { durationMs: 700 });
            await ctx.sleep(1500);
        }
        // MeSH / フリーワードの凡例
        await hoverSlow(ctx.page, ctx.page.locator('.draft__legend'), { durationMs: 900 });
        await ctx.sleep(1400);
        const meshTerm = ctx.page.locator('.draft__term--mesh').first();
        if (await meshTerm.count()) {
            await hoverSlow(ctx.page, meshTerm, { durationMs: 700 });
            await ctx.sleep(1000);
        }
        const freewordTerm = ctx.page.locator('.draft__term--freeword').first();
        if (await freewordTerm.count()) {
            await hoverSlow(ctx.page, freewordTerm, { durationMs: 700 });
        }
        await sleepRemainder(ctx, cue6StartedAt, durations['06'] * 1000 + 500);

        // --- cue 07: 検証結果は次章へ ---
        ctx.cue(7);
        const cue7StartedAt = Date.now();
        await smoothWheel(ctx.page, 600, { steps: 16, stepDelayMs: 80 });
        await ctx.sleep(600);
        await hoverSlow(ctx.page, ctx.page.locator('.validate__line-hits'), { durationMs: 900 });
        await ctx.sleep(1600);
        await hoverSlow(ctx.page, ctx.page.locator('.validate__final'), { durationMs: 900 });
        await ctx.sleep(2000);
        const meshSection = ctx.page.locator('.validate__mesh');
        if (await meshSection.count()) {
            await smoothWheel(ctx.page, 400, { steps: 12, stepDelayMs: 80 });
            await hoverSlow(ctx.page, meshSection, { durationMs: 900 });
        }
        await sleepRemainder(ctx, cue7StartedAt, durations['07'] * 1000 + 500);
    },
};
