/**
 * 第 12 章「完了画面と抄録のダウンロード案内」
 *
 * `#/done` は `11-export` プリセットから到達できる（done のガードは
 * `currentFormulaVersionId !== null` のみで、v2-demo が hydrate 済み）。
 * 12 章専用の demoSeed プリセットは無い。
 *
 * ## 絶対にクリックしないもの
 *
 * この画面のリンクは**すべて実サイトへの外部リンク**（`target=_blank`）:
 * PubMed / Cochrane CENTRAL / Dialog / ClinicalTrials.gov / ICTRP。
 * 押すと新規タブが開き、ネットワーク未接続のエラーページが録画に入る。**ホバーのみ**。
 *
 * nbib のダウンロードは実装されていない（`done__note` の文章での案内だけ。
 * CLAUDE.md の「作らない」に明記）。ナレーションも「案内する」に留めてある。
 *
 * fetch は起動時の seed 適用しか走らないので demoLatency=0。
 */

import { hoverSlow, smoothWheel } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';

export default {
    id: '12',
    slug: 'done',
    title: '完了画面と抄録のダウンロード案内',
    narration: '12-done',

    async run(ctx) {
        const durations = loadCueDurations('12-done');

        await ctx.openExtensionPage('app/app.html?demoSeed=11-export&demoLatency=0#/done');
        await ctx.page.locator('p.done__lead').waitFor({ state: 'visible', timeout: 25000 });
        await ctx.sleep(800);

        // --- cue 01: ここで拡張の役割は終わり ---
        ctx.cue(1);
        const cue1StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#app-content h2'), { durationMs: 800 });
        await ctx.sleep(1000);
        await hoverSlow(ctx.page, ctx.page.locator('p.done__lead'), { durationMs: 1000 });
        await ctx.sleep(1300);
        await hoverSlow(ctx.page, ctx.page.locator('p.done__pubmed-link'), { durationMs: 900 });
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        // --- cue 02: 4 つのデータベースへのリンク（押さない） ---
        ctx.cue(2);
        const cue2StartedAt = Date.now();
        const links = ctx.page.locator('ul.done__links li');
        const linkCount = await links.count();
        for (let i = 0; i < linkCount; i++) {
            await hoverSlow(ctx.page, links.nth(i), { durationMs: 500 });
            await ctx.sleep(450);
        }
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);

        // --- cue 03: nbib の書き出し案内 ---
        ctx.cue(3);
        const cue3StartedAt = Date.now();
        await smoothWheel(ctx.page, 220, { steps: 10, stepDelayMs: 90 });
        await ctx.sleep(400);
        await hoverSlow(ctx.page, ctx.page.locator('p.done__note'), { durationMs: 1000 });
        await ctx.sleep(1800);
        // 次のツールへ引き継ぐ、という締め。サイドナビの完了を指しておく
        await hoverSlow(
            ctx.page,
            ctx.page.locator('#app-sidebar .app__nav-list button').filter({ hasText: '完了' }),
            { durationMs: 800 }
        );
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);
    },
};
