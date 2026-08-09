/**
 * 第 8 章「検証結果を読む — 捕捉率と MeSH」
 *
 * 第 7 章で走らせた検証の**結果の読み方**だけを扱う（§4 の「07 と 08 を分ける理由」）。
 * 実行はしない。`08-validation` プリセットは v1-demo と検証結果（捕捉率 80%・
 * 未捕捉 90000005）を事前投入済みなので、開いた時点で結果パネルが出ている。
 *
 * ## この章で出ないもの（章 07 の担当）
 *
 * `.draft__tracker` / `.draft__step*` / `li.draft__block-hit` は**実行中しか描画されない**。
 * 開いただけのこの章では存在しないので、触らない。
 *
 * ## 押してはいけないボタン
 *
 * `.draft__actions button` は既存 formula があるので文言が `再生成して再検証する` になる。
 * **押すと 60 秒級の再生成が始まり、検証結果パネルごと消える。** 言及するだけで押さない。
 *
 * ## セレクタの注意
 *
 * `.validate__final` の「全体ヒット数」「捕捉率」は**どちらもクラスが無い `<p>`**。
 * `.validate__final > p` の nth(0) / nth(1) で取る。
 * `.validate__missed li` は先頭が見出し行（`未捕捉 PMID:`）なので nth(1) 以降が PMID。
 *
 * demoLatency=6: 「AI で原因を分析する」は LLM 1 回なので等倍だと 0.6 秒で終わり、
 * 「原因を分析中…」が読めない。6 倍で約 3.6 秒。
 */

import { hoverSlow, smoothWheel } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';

export default {
    id: '08',
    slug: 'validation',
    title: '検証結果を読む — 捕捉率と MeSH',
    narration: '08-validation',

    async run(ctx) {
        const durations = loadCueDurations('08-validation');

        await ctx.openExtensionPage('app/app.html?demoSeed=08-validation&demoLatency=6#/draft');
        await ctx.page.locator('.validate__results').waitFor({ state: 'visible', timeout: 25000 });
        await ctx.sleep(800);

        // --- cue 01: どのバージョンの結果を見ているか ---
        ctx.cue(1);
        const cue1StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('p.draft__info'), { durationMs: 900 });
        await ctx.sleep(1200);
        await hoverSlow(ctx.page, ctx.page.locator('p.draft__validate-status'), { durationMs: 900 });
        await ctx.sleep(1000);
        await smoothWheel(ctx.page, 260, { steps: 12, stepDelayMs: 90 });
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        // --- cue 02: 行ごとのヒット数 ---
        ctx.cue(2);
        const cue2StartedAt = Date.now();
        const lineHits = ctx.page.locator('.validate__line-hits li');
        const lineCount = await lineHits.count();
        for (let i = 0; i < lineCount; i++) {
            await hoverSlow(ctx.page, lineHits.nth(i), { durationMs: 600 });
            await ctx.sleep(1100);
        }
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);

        // --- cue 03: 全体ヒット数 → 捕捉率 → 未捕捉 PMID ---
        ctx.cue(3);
        const cue3StartedAt = Date.now();
        const finalParas = ctx.page.locator('.validate__final > p');
        await hoverSlow(ctx.page, finalParas.nth(0), { durationMs: 800 }); // 全体ヒット数
        await ctx.sleep(1600);
        await hoverSlow(ctx.page, finalParas.nth(1), { durationMs: 800 }); // 捕捉率
        await ctx.sleep(2600);
        // 未捕捉 PMID。nth(0) は「未捕捉 PMID:」の見出し行なので nth(1) が実際の PMID
        const missed = ctx.page.locator('.validate__missed li');
        if ((await missed.count()) > 1) {
            await hoverSlow(ctx.page, missed.nth(1), { durationMs: 800 });
        }
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);

        // --- cue 04: AI で原因を分析する ---
        ctx.cue(4);
        const cue4StartedAt = Date.now();
        const analyzeBtn = ctx.page.locator('button.validate__analyze-missed');
        await hoverSlow(ctx.page, analyzeBtn, { durationMs: 700 });
        await analyzeBtn.click();
        // 「原因を分析中…」→ 結果リスト
        await ctx.page.locator('li.validate__analysis-item').first()
            .waitFor({ state: 'visible', timeout: 60000 });
        await ctx.sleep(600);
        await hoverSlow(ctx.page, ctx.page.locator('p.validate__analysis-pmid').first(), { durationMs: 800 });
        await ctx.sleep(1400);
        await hoverSlow(ctx.page, ctx.page.locator('p.validate__analysis-cause').first(), { durationMs: 800 });
        await ctx.sleep(1600);
        const terms = ctx.page.locator('ul.validate__analysis-terms li').first();
        if (await terms.count()) {
            await hoverSlow(ctx.page, terms, { durationMs: 800 });
        }
        await sleepRemainder(ctx, cue4StartedAt, durations['04'] * 1000 + 500);

        // --- cue 05: Seed の MeSH と階層（図ではなく Mermaid のソース）---
        ctx.cue(5);
        const cue5StartedAt = Date.now();
        await smoothWheel(ctx.page, 420, { steps: 14, stepDelayMs: 85 });
        await ctx.sleep(500);
        const meshItems = ctx.page.locator('.validate__mesh > ul > li');
        const meshCount = Math.min(await meshItems.count(), 3);
        for (let i = 0; i < meshCount; i++) {
            await hoverSlow(ctx.page, meshItems.nth(i), { durationMs: 550 });
            await ctx.sleep(700);
        }
        await hoverSlow(ctx.page, ctx.page.locator('p.validate__mesh-hierarchy-note'), { durationMs: 800 });
        await ctx.sleep(1200);
        await hoverSlow(ctx.page, ctx.page.locator('pre.validate__mesh-mermaid'), { durationMs: 900 });
        await sleepRemainder(ctx, cue5StartedAt, durations['05'] * 1000 + 500);
    },
};
