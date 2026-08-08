/**
 * 第 14 章「アウトロ」
 *
 * エンドカード（`video/assets/end-card.html`）を出して締める。章 01 のタイトルカードと
 * 同じく `file://` で開く（`ctx.openExtensionPage` は拡張ページ専用なので使わない）。
 *
 * ## 注意
 *
 * - **エンドカードにバージョン表記は無い。** ヘッダーコメントには `?version=x.y.z` で
 *   差し込むと書いてあるが、`title-card.html` と違って反映用の要素もスクリプトも
 *   実装されていない。付けても何も起きないので付けない。
 * - **Chrome ウェブストアの行は意図的に入っていない**（掲載 URL 未確定のため）。
 *   ナレーションで「ストアから入れてください」と言うと画面と食い違うので言わない。
 * - 静止画なので、`hoverSlow` でカーソルを動かし続けないと §8-4 の静止画検査に
 *   引っかかる。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hoverSlow } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const END_CARD = pathToFileURL(path.resolve(__dirname, '..', 'assets', 'end-card.html'));

export default {
    id: '14',
    slug: 'outro',
    title: 'アウトロ',
    narration: '14-outro',

    async run(ctx) {
        const durations = loadCueDurations('14-outro');

        await ctx.page.goto(END_CARD.href);
        await ctx.page.locator('.thanks').waitFor({ state: 'visible', timeout: 15000 });
        await ctx.sleep(800);

        // --- cue 01: まとめ ---
        ctx.cue(1);
        const cue1StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('.brand-row'), { durationMs: 1400, steps: 20 });
        await ctx.sleep(1200);
        await hoverSlow(ctx.page, ctx.page.locator('.thanks'), { durationMs: 1400, steps: 20 });
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        // --- cue 02: ヘルプ / GitHub / クレジット ---
        ctx.cue(2);
        const cue2StartedAt = Date.now();
        const linkRows = ctx.page.locator('.links > div');
        const rowCount = await linkRows.count();
        for (let i = 0; i < rowCount; i++) {
            await hoverSlow(ctx.page, linkRows.nth(i), { durationMs: 900, steps: 16 });
            await ctx.sleep(1600);
        }
        await hoverSlow(ctx.page, ctx.page.locator('.credit'), { durationMs: 900, steps: 16 });
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);
    },
};
