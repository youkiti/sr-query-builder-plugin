/**
 * 第 6 章「シード論文を登録する」
 *
 * 架空 PMID 90000001〜90000005 を貼り付けて登録し、詳細カードを開くところまで。
 *
 * **include / exclude / maybe の判定はこの章では扱わない。** `#/seeds` に判定 UI は
 * 無く（実装を確認済み）、境界事例の判定は `#/expand`（第 9 章）の担当。
 * この章は「登録・確認・有効無効の切り替え」までで切る。
 *
 * セレクタの注意: `.seeds__primary` は「登録」と「アップロードして登録」の
 * 2 か所にあるので、fieldset で絞る。
 *
 * demoLatency=2: esearch / efetch 5 件ぶんの往復に間を持たせ、
 * 「ingest 中…」が読める長さにするため（等倍だと 2.9 秒で終わる）。
 */

import { hoverSlow, smoothWheel } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';

/** 架空 PMID（§6-2 の映り込みルール。実在論文の PMID は使わない） */
const SEED_PMIDS = ['90000001', '90000002', '90000003', '90000004', '90000005'];

export default {
    id: '06',
    slug: 'seeds',
    title: 'シード論文を登録する',
    narration: '06-seeds',

    async run(ctx) {
        const durations = loadCueDurations('06-seeds');

        await ctx.openExtensionPage('app/app.html?demoSeed=06-seeds&demoLatency=2#/seeds');
        await ctx.page.locator('textarea.seeds__pmid-input').waitFor({ state: 'visible', timeout: 20000 });
        await ctx.sleep(800);

        // --- cue 01: シード論文とは何か ---
        ctx.cue(1);
        const cue1StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#app-content h2'), { durationMs: 900 });
        await ctx.sleep(1300);
        await hoverSlow(ctx.page, ctx.page.locator('.seeds__list-empty'), { durationMs: 900 });
        await ctx.sleep(1800);
        await hoverSlow(ctx.page, ctx.page.locator('textarea.seeds__pmid-input'), { durationMs: 1000 });
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        // --- cue 02: PMID を貼り付ける ---
        ctx.cue(2);
        const cue2StartedAt = Date.now();
        await ctx.page.locator('textarea.seeds__pmid-input').click();
        await ctx.page.locator('textarea.seeds__pmid-input')
            .pressSequentially(SEED_PMIDS.join('\n'), { delay: 65 });
        await ctx.sleep(600);
        // ファイルアップロードという代替手段も見せる
        await hoverSlow(ctx.page, ctx.page.locator('input.seeds__file'), { durationMs: 900 });
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);

        // --- cue 03: 登録 → 結果 ---
        ctx.cue(3);
        const cue3StartedAt = Date.now();
        const registerButton = ctx.page.locator('fieldset.seeds__section').first()
            .locator('.seeds__primary');
        await hoverSlow(ctx.page, registerButton, { durationMs: 700 });
        await registerButton.click();
        await ctx.page.locator('li.seeds__list-item').first()
            .waitFor({ state: 'visible', timeout: 60000 });
        await hoverSlow(ctx.page, ctx.page.locator('.seeds__status'), { durationMs: 900 });
        await ctx.sleep(1200);
        await hoverSlow(ctx.page, ctx.page.locator('.seeds__summary'), { durationMs: 900 });
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);

        // --- cue 04: 詳細を開いて中身を確認する ---
        ctx.cue(4);
        const cue4StartedAt = Date.now();
        await smoothWheel(ctx.page, 320, { steps: 12, stepDelayMs: 85 });
        await ctx.sleep(400);
        const expandButton = ctx.page.locator('button.seeds__list-expand').first();
        await hoverSlow(ctx.page, expandButton, { durationMs: 700 });
        await expandButton.click();
        await ctx.page.locator('.seeds__article-title').first()
            .waitFor({ state: 'visible', timeout: 30000 });
        await ctx.sleep(700);
        await hoverSlow(ctx.page, ctx.page.locator('.seeds__article-title').first(), { durationMs: 900 });
        await ctx.sleep(1200);
        const meshList = ctx.page.locator('.seeds__article-mesh').first();
        if (await meshList.count()) {
            await hoverSlow(ctx.page, meshList, { durationMs: 900 });
            await ctx.sleep(1000);
        }
        // 有効/無効のチェックボックス
        await hoverSlow(ctx.page, ctx.page.locator('input.seeds__list-enabled').first(), { durationMs: 800 });
        await sleepRemainder(ctx, cue4StartedAt, durations['04'] * 1000 + 500);

        // --- cue 05: 次は検索式の生成 ---
        ctx.cue(5);
        const cue5StartedAt = Date.now();
        const draftNav = ctx.page.locator('#app-sidebar .app__nav-list button')
            .filter({ hasText: '検索式（生成・検証）' });
        await hoverSlow(ctx.page, draftNav, { durationMs: 900 });
        await sleepRemainder(ctx, cue5StartedAt, durations['05'] * 1000 + 500);
    },
};
