/**
 * 第 5 章「検索式ブロックを承認する」
 *
 * AI が抽出した 3 ブロック（#1 ARDS / #2 ECMO / #3 RCT フィルタ）を確認し、
 * 結合式 `#1 AND #2 AND #3` を確かめて承認するまで。
 *
 * セレクタの注意: `.blocks__btn-secondary` は「＋ ブロックを追加」「全 AND に戻す」
 * 「下書きとして保存」の 3 か所で共有されている。承認ボタンだけは
 * `.blocks__btn-primary` でユニークに取れる。
 *
 * demoLatency=3: 承認時の Google スプレッドシート への書き込みに間を持たせ、
 * ボタンを押してから次画面へ移るまでの「保存している感」を出すため。
 */

import { hoverSlow, smoothWheel } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';

export default {
    id: '05',
    slug: 'blocks',
    title: '検索式ブロックを承認する',
    narration: '05-blocks',

    async run(ctx) {
        const durations = loadCueDurations('05-blocks');

        await ctx.openExtensionPage('app/app.html?demoSeed=05-blocks&demoLatency=3#/blocks');
        await ctx.page.locator('button.blocks__btn-primary').waitFor({ state: 'visible', timeout: 20000 });
        await ctx.page.locator('li.blocks__item').first().waitFor({ state: 'visible', timeout: 20000 });
        await ctx.sleep(800);

        // --- cue 01: ブロックとは何か ---
        ctx.cue(1);
        const cue1StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#app-content h2'), { durationMs: 900 });
        await ctx.sleep(1100);
        await hoverSlow(ctx.page, ctx.page.locator('.blocks__lede'), { durationMs: 1000 });
        await ctx.sleep(1600);
        // 画面内ステッパー（確認 → 結合式 → 承認）をなぞる
        const steps = ctx.page.locator('ol.blocks__stepper li');
        const stepCount = await steps.count();
        for (let i = 0; i < stepCount; i++) {
            await hoverSlow(ctx.page, steps.nth(i), { durationMs: 650 });
            await ctx.sleep(700);
        }
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        // --- cue 02: 抽出された 3 ブロック ---
        ctx.cue(2);
        const cue2StartedAt = Date.now();
        const items = ctx.page.locator('li.blocks__item');
        const itemCount = await items.count();
        for (let i = 0; i < itemCount; i++) {
            await hoverSlow(ctx.page, items.nth(i).locator('.blocks__item-id'), { durationMs: 700 });
            await ctx.sleep(400);
            await hoverSlow(ctx.page, items.nth(i).locator('.blocks__badge'), { durationMs: 600 });
            await ctx.sleep(900);
        }
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);

        // --- cue 03: ブロック名と説明。説明が効く ---
        ctx.cue(3);
        const cue3StartedAt = Date.now();
        await hoverSlow(ctx.page, items.first().locator('.blocks__label-input'), { durationMs: 800 });
        await ctx.sleep(1400);
        await hoverSlow(ctx.page, items.first().locator('.blocks__desc'), { durationMs: 900 });
        await ctx.sleep(2000);
        await hoverSlow(ctx.page, items.nth(1).locator('.blocks__desc'), { durationMs: 900 });
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);

        // --- cue 04: 結合式 ---
        ctx.cue(4);
        const cue4StartedAt = Date.now();
        await smoothWheel(ctx.page, 420, { steps: 14, stepDelayMs: 85 });
        await ctx.sleep(500);
        await hoverSlow(ctx.page, ctx.page.locator('.blocks__combination-preview'), { durationMs: 1000 });
        await ctx.sleep(1800);
        await hoverSlow(ctx.page, ctx.page.locator('.blocks__combination-input'), { durationMs: 900 });
        await ctx.sleep(1600);
        await hoverSlow(ctx.page, ctx.page.locator('.blocks__combination-status'), { durationMs: 800 });
        await sleepRemainder(ctx, cue4StartedAt, durations['04'] * 1000 + 500);

        // --- cue 05: 承認 ---
        ctx.cue(5);
        const cue5StartedAt = Date.now();
        const approve = ctx.page.locator('button.blocks__btn-primary');
        await hoverSlow(ctx.page, approve, { durationMs: 800 });
        await approve.click();
        // 承認が通れば #/seeds へ遷移する
        await ctx.page.waitForFunction(() => window.location.hash === '#/seeds', { timeout: 60000 });
        await ctx.page.locator('textarea.seeds__pmid-input').waitFor({ state: 'visible', timeout: 20000 });
        await sleepRemainder(ctx, cue5StartedAt, durations['05'] * 1000 + 500);
    },
};
