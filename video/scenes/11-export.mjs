/**
 * 第 11 章「各データベースへ変換・エクスポートする」
 *
 * PubMed リンク → 4 DB へ変換 → 各 details を開く → .md ダウンロード →
 * Methods 文案のコピー、まで。
 *
 * ## セレクタの注意
 *
 * - `.export__result` / `.export__download` / `.export__formula` / `.export__warnings`
 *   は**各 4 個**。必ず `details.export__result[data-db="central"]` のように
 *   `data-db` でスコープする（`central` / `dialog` / `clinicaltrials` / `ictrp`）。
 * - `details` は**変換後に閉じた状態で出る**（`open` 属性なし）。`summary` を
 *   クリックして開く操作が要る。
 * - `.export__methods-copy` は英語版・日本語版の 2 個。`filter({ hasText: … })` で絞る。
 *
 * ## 押してはいけないもの
 *
 * `p.export__pubmed-link a` は実際の PubMed へ出る外部リンク（`target=_blank`）。
 * ホバーだけにする。押すと新規タブが開き、ネットワーク未接続のエラーページが録画に入る。
 *
 * クリップボードは `clipboardWrite` 権限が無いので失敗しうるが、収録環境で
 * 「英語版の文案をコピーしました。」が出ることを事前に実測済み。
 *
 * demoLatency=3: 4 DB 変換は Sheets への追記 4 件で等倍 2.6 秒。「変換中…」を
 * 読ませるため 3 倍（約 8 秒）にする。
 */

import { hoverSlow, smoothWheel } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';

/** 変換結果の details を開く順（画面の並び順に合わせる） */
const DB_KEYS = ['central', 'dialog', 'clinicaltrials', 'ictrp'];

export default {
    id: '11',
    slug: 'export',
    title: '各データベースへ変換・エクスポートする',
    narration: '11-export',

    async run(ctx) {
        const durations = loadCueDurations('11-export');

        await ctx.openExtensionPage('app/app.html?demoSeed=11-export&demoLatency=3#/export');
        await ctx.page.locator('.export__actions button').waitFor({ state: 'visible', timeout: 25000 });
        await ctx.sleep(800);

        // --- cue 01: PubMed で直接開くリンク（押さない） ---
        ctx.cue(1);
        const cue1StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#app-content h2'), { durationMs: 800 });
        await ctx.sleep(1100);
        await hoverSlow(ctx.page, ctx.page.locator('p.export__pubmed-link'), { durationMs: 1000 });
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        // --- cue 02: 4 DB へ変換して保存 ---
        ctx.cue(2);
        const cue2StartedAt = Date.now();
        const convertBtn = ctx.page.locator('.export__actions button');
        await hoverSlow(ctx.page, convertBtn, { durationMs: 700 });
        await convertBtn.click();
        await ctx.page.locator('details.export__result').first()
            .waitFor({ state: 'visible', timeout: 60000 });
        await hoverSlow(ctx.page, ctx.page.locator('p.export__status'), { durationMs: 800 });
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);

        // --- cue 03: 4 つの details を順に開く ---
        ctx.cue(3);
        const cue3StartedAt = Date.now();
        for (const db of DB_KEYS) {
            const details = ctx.page.locator(`details.export__result[data-db="${db}"]`);
            if (!(await details.count())) continue;
            const summary = details.locator('summary');
            await hoverSlow(ctx.page, summary, { durationMs: 500 });
            await summary.click();
            await ctx.sleep(900);
        }
        // 変換後の式と警告を見せる
        const dialogFormula = ctx.page.locator('details.export__result[data-db="dialog"] pre.export__formula');
        if (await dialogFormula.count()) {
            await hoverSlow(ctx.page, dialogFormula, { durationMs: 800 });
            await ctx.sleep(900);
        }
        const anyWarning = ctx.page.locator('ul.export__warnings').first();
        if (await anyWarning.count()) {
            await hoverSlow(ctx.page, anyWarning, { durationMs: 800 });
        }
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);

        // --- cue 04: .md ダウンロード（ホバーのみ。押しても画面は変わらない） ---
        ctx.cue(4);
        const cue4StartedAt = Date.now();
        const dl = ctx.page.locator('details.export__result[data-db="central"] a.export__download');
        if (await dl.count()) {
            await hoverSlow(ctx.page, dl, { durationMs: 900 });
        }
        await sleepRemainder(ctx, cue4StartedAt, durations['04'] * 1000 + 500);

        // --- cue 05: Methods 文案の英語版・日本語版 ---
        ctx.cue(5);
        const cue5StartedAt = Date.now();
        await smoothWheel(ctx.page, 520, { steps: 14, stepDelayMs: 85 });
        await ctx.sleep(500);
        await hoverSlow(ctx.page, ctx.page.locator('.export__methods-text[lang="en"]'), { durationMs: 900 });
        await ctx.sleep(1800);
        await hoverSlow(ctx.page, ctx.page.locator('.export__methods-text[lang="ja"]'), { durationMs: 900 });
        await ctx.sleep(1400);
        const copyEn = ctx.page.locator('.export__methods-copy').filter({ hasText: '英語版' });
        await hoverSlow(ctx.page, copyEn, { durationMs: 600 });
        await copyEn.click();
        await ctx.page.locator('p.export__methods-status')
            .filter({ hasText: 'コピー' })
            .waitFor({ state: 'visible', timeout: 15000 })
            .catch(() => {});
        await hoverSlow(ctx.page, ctx.page.locator('p.export__methods-status'), { durationMs: 700 });
        await sleepRemainder(ctx, cue5StartedAt, durations['05'] * 1000 + 500);
    },
};
