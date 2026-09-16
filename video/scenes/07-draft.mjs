/**
 * 第 7 章「検索式を作成・自動調整する」
 *
 * 目安件数・反復上限を設定し、初期式作成 → 実測・調整 → 最終レビュー → 採用保存を見せる。
 * 最後に「検証のみ再実行」で件数・捕捉率・MeSH の結果を出し、読み方は第 8 章へ渡す。
 *
 * demoLatency=1 は暫定値。旧生成パイプラインの実測係数はこの導線には使えない。
 * 原稿の TTS を作り直した後、録画を回した状態で各 cue の尺と待ち時間を調整すること。
 *
 * セレクタの注意: 主操作は `.optimization__start`、保存後の検証は `.draft__revalidate`。
 * 未生成時は `.draft__actions` 自体が無い。反復上限は「詳細設定」の中にある。
 */

import { hoverSlow, smoothWheel } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';

/** 実行中の再描画で消える要素は、存在する間だけホバーする。 */
async function hoverIfVisible(page, locator, options) {
    if (await locator.isVisible().catch(() => false)) {
        await hoverSlow(page, locator, options);
        return true;
    }
    return false;
}

/** 処理待ちの間も進捗をなぞり、静止したままの待ちを避ける。 */
async function waitWithProgress(ctx, done, progressSelectors, errorSelector, what) {
    const deadline = Date.now() + 300000;
    while (!(await done.isVisible())) {
        const error = ctx.page.locator(errorSelector);
        if (await error.isVisible()) {
            const message = (await error.textContent()).trim();
            if (message) throw new Error(`[07-draft] ${what}: ${message}`);
        }
        if (Date.now() > deadline) {
            throw new Error(`[07-draft] ${what}が 300 秒たっても完了しませんでした`);
        }
        for (const selector of progressSelectors) {
            await hoverIfVisible(ctx.page, ctx.page.locator(selector), { durationMs: 700 });
            await ctx.sleep(500);
        }
    }
}

export default {
    id: '07',
    slug: 'draft',
    title: '検索式を作成・自動調整する',
    narration: '07-draft',

    async run(ctx) {
        const durations = loadCueDurations('07-draft');

        await ctx.openExtensionPage('app/app.html?demoSeed=07-draft&demoLatency=1#/draft');
        await ctx.page.locator('.optimization__start').waitFor({ state: 'visible', timeout: 20000 });
        await ctx.sleep(800);

        // --- cue 01: この画面は何をするところか（実行前）---
        ctx.cue(1);
        const cue1StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#app-content h2'), { durationMs: 900 });
        await ctx.sleep(1300);
        await hoverSlow(ctx.page, ctx.page.locator('#app-context'), { durationMs: 900 });
        await ctx.sleep(1600);
        await hoverSlow(ctx.page, ctx.page.locator('.optimization__start'), { durationMs: 1000 });
        await ctx.sleep(2000);
        await hoverSlow(ctx.page, ctx.page.locator('#app-sidebar .app__nav-list button').filter({ hasText: 'シード論文' }), { durationMs: 900 });
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        // --- cue 02: 設定して自動調整を開始 ---
        ctx.cue(2);
        const cue2StartedAt = Date.now();
        const hits = ctx.page.getByLabel('目安件数', { exact: true });
        await hoverSlow(ctx.page, hits, { durationMs: 600 });
        await hits.fill('100');
        await ctx.page.locator('.optimization__setup summary').click();
        const iterations = ctx.page.getByLabel('反復上限');
        await hoverSlow(ctx.page, iterations, { durationMs: 600 });
        await iterations.fill('1');
        const runButton = ctx.page.locator('.optimization__start');
        await hoverSlow(ctx.page, runButton, { durationMs: 600 });
        await runButton.click();
        await ctx.page.locator('.optimization__status').waitFor({ state: 'visible', timeout: 30000 });
        await hoverSlow(ctx.page, ctx.page.locator('.optimization__stages'), { durationMs: 800 });
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);

        // --- cue 03: 実測値と試行履歴 ---
        ctx.cue(3);
        const cue3StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('.optimization__metrics'), { durationMs: 900 });
        await ctx.sleep(1500);
        await hoverIfVisible(ctx.page, ctx.page.locator('.optimization__history'), { durationMs: 900 });
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);
        await waitWithProgress(ctx, ctx.page.locator('.optimization__review'),
            ['.optimization__stages', '.optimization__metrics', '.optimization__history'],
            '.optimization__setup [role="alert"]', '自動調整');

        // --- cue 04: 最終レビュー。目安達成や捕捉率を決め打ちしない ---
        ctx.cue(4);
        const cue4StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('.optimization__review h3'), { durationMs: 800 });
        const sections = ctx.page.locator('.optimization__review-section');
        for (let i = 0; i < await sections.count(); i++) {
            await hoverSlow(ctx.page, sections.nth(i), { durationMs: 700 });
            await ctx.sleep(1000);
        }
        await sleepRemainder(ctx, cue4StartedAt, durations['04'] * 1000 + 500);

        // --- cue 05: 最終候補を採用して保存 ---
        ctx.cue(5);
        const cue5StartedAt = Date.now();
        const adopt = ctx.page.getByRole('button', { name: '採用して保存', exact: true });
        if (!(await adopt.isEnabled())) {
            throw new Error('[07-draft] 採用できる候補がありません。最終レビューを確認してください');
        }
        await hoverSlow(ctx.page, adopt, { durationMs: 700 });
        await adopt.click();
        const saved = ctx.page.locator('.optimization__save-status').filter({ hasText: '保存しました' });
        await waitWithProgress(ctx, saved, ['.optimization__save-status'], '.optimization__save-error', '採用保存');
        await hoverSlow(ctx.page, saved, { durationMs: 800 });
        await sleepRemainder(ctx, cue5StartedAt, durations['05'] * 1000 + 500);

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

        // --- cue 07: 保存した式を検証し、結果の読み方は次章へ ---
        ctx.cue(7);
        const cue7StartedAt = Date.now();
        const revalidate = ctx.page.locator('.draft__revalidate');
        await hoverSlow(ctx.page, revalidate, { durationMs: 700 });
        await revalidate.click();
        await waitWithProgress(ctx, ctx.page.locator('.draft__validate-status'),
            ['.draft__status', '.draft__block-hits'], '.draft__error', '検証');
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
