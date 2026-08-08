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
 * ## demoLatency=5.6 の根拠
 *
 * 実行中に流れるナレーションは cue 02〜05 の 4 本で合計 62.5 秒。ここがずれると、
 * ナレーションが「いま生成中です」と言っているのに画面が終わっている（または逆に、
 * 喋り終わったあと無音で進捗バーを眺める）ことになる。
 *
 * **係数は「録画を回した状態」で測ること。** 素の Playwright で測ると 1920x1080 の
 * 録画ぶんの CPU 負荷が乗らず、収録時より速く出る。録画ありの実測は
 * 係数 2.4 で 29.9 秒 / 3.4 で 39.8 秒（傾き ≒ 9.9 秒／係数 1、切片 ≒ 6 秒）で、
 * 62.5 秒に合わせると 5.6 倍。
 *
 * 実 API でも LLM 9 回ぶんで 30〜60 秒はかかるので、映像としても妥当な範囲。
 * なお多少ずれても破綻しないよう、cue 05 のあとに「カーソルを動かしたまま待つ」
 * ループを置いてある（下記）。
 *
 * セレクタの注意: 「生成して検証する」ボタンには id も class も無い。
 * `.draft__actions button` で取る（この div の子はこのボタン 1 つだけ）。
 * また `li.draft__block-hit` は**実行中のみ描画される**ので、完了後には消える。
 */

import { hoverSlow, smoothWheel } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';

/**
 * 「いま画面にあれば」ホバーする。
 *
 * この章は実行中のトラッカーやライブ表示（`li.draft__block-hit` 等）をなぞるが、
 * それらは**実行が終わると DOM から消える**。消えた要素に `hoverSlow` を掛けると
 * `scrollIntoViewIfNeeded` → `locator.hover()` の既定 30 秒タイムアウトで詰まり、
 * 1 つの cue が 90 秒スタックした（実測）。`isVisible()` は待たずに即返るので、
 * 実行の進み具合が多少ずれても収録が破綻しない。
 */
async function hoverIfVisible(page, locator, options) {
    if (await locator.isVisible().catch(() => false)) {
        await hoverSlow(page, locator, options);
        return true;
    }
    return false;
}

export default {
    id: '07',
    slug: 'draft',
    title: '検索式を生成して検証する',
    narration: '07-draft',

    async run(ctx) {
        const durations = loadCueDurations('07-draft');

        await ctx.openExtensionPage('app/app.html?demoSeed=07-draft&demoLatency=5.6#/draft');
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
        await hoverIfVisible(ctx.page, genPhase.locator('.draft__phase-label'), { durationMs: 800 });
        await ctx.sleep(1000);
        // ブロック 1 の 4 つのチップ（骨格 / MeSH / フリーワード / 件数）をなぞる
        const firstBlockSteps = genPhase.locator('.draft__step-block').first().locator('.draft__step');
        const chipCount = await firstBlockSteps.count();
        for (let i = 0; i < chipCount; i++) {
            await hoverIfVisible(ctx.page, firstBlockSteps.nth(i), { durationMs: 600 });
            await ctx.sleep(800);
        }
        await ctx.sleep(1200);
        await hoverIfVisible(ctx.page, ctx.page.locator('.draft__status'), { durationMs: 800 });
        await ctx.sleep(1500);
        await hoverIfVisible(ctx.page, ctx.page.locator('.draft__progressbar'), { durationMs: 800 });
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);

        // --- cue 04: ブロックごとのヒット数がライブで埋まる ---
        ctx.cue(4);
        const cue4StartedAt = Date.now();
        const blockHits = ctx.page.locator('li.draft__block-hit');
        const hitCount = await blockHits.count();
        for (let i = 0; i < hitCount; i++) {
            await hoverIfVisible(ctx.page, blockHits.nth(i), { durationMs: 700 });
            await ctx.sleep(1400);
        }
        await hoverIfVisible(ctx.page, ctx.page.locator('.draft__block-hits'), { durationMs: 900 });
        await sleepRemainder(ctx, cue4StartedAt, durations['04'] * 1000 + 500);

        // --- cue 05: 検証フェーズ ---
        ctx.cue(5);
        const cue5StartedAt = Date.now();
        const validationPhase = ctx.page.locator('.draft__phase').nth(1);
        if (await validationPhase.count()) {
            await hoverIfVisible(ctx.page, validationPhase.locator('.draft__phase-label'), { durationMs: 800 });
            await ctx.sleep(900);
            const valChips = validationPhase.locator('.draft__step');
            const valCount = await valChips.count();
            for (let i = 0; i < valCount; i++) {
                await hoverIfVisible(ctx.page, valChips.nth(i), { durationMs: 550 });
                await ctx.sleep(600);
            }
        }
        await hoverIfVisible(ctx.page, ctx.page.locator('.draft__status'), { durationMs: 800 });
        await sleepRemainder(ctx, cue5StartedAt, durations['05'] * 1000 + 500);

        // --- 実行が終わるのを待つ（カーソルを動かしたまま）---
        // 係数を合わせても収録機の負荷しだいで数秒〜十数秒ずれる。ここで素朴に
        // waitFor すると、その間だけカーソルが止まって静止画に見える
        // （§8-4 の md5 検査に引っかかる）。待つあいだも画面をなぞり続ける。
        const doneMarker = ctx.page.locator('.draft__validate-status');
        const waitDeadline = Date.now() + 180000;
        while (!(await doneMarker.isVisible().catch(() => false))) {
            if (Date.now() > waitDeadline) {
                throw new Error('[07-draft] 生成・検証が 180 秒たっても完了しませんでした');
            }
            await hoverIfVisible(ctx.page, ctx.page.locator('.draft__progressbar'), { durationMs: 700 });
            await ctx.sleep(500);
            await hoverIfVisible(ctx.page, ctx.page.locator('.draft__status'), { durationMs: 700 });
            await ctx.sleep(500);
        }

        // --- cue 06: 完成した検索式 ---
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
