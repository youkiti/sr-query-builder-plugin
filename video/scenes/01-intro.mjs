/**
 * 第 1 章「イントロ — この拡張でできること」
 *
 * タイトルカード（file://）→ 完成済みプロジェクトのホーム画面（?demoSeed=11-export）。
 * §4 の「画面に映らないものを説明しない」に従い、サイドナビの 10 項目・ヘッダーの
 * バージョン表示など、実際に映っているものだけを語る。
 *
 * イントロは完成状態を先に見せて「こういうものが作れる」を伝える役なので、
 * まっさらではなく 11-export プリセット（検索式・検証結果まで埋まった状態）を使う。
 * fetch は起動時の seed 適用でしか走らないため demoLatency は 0（無効）。
 *
 * セグメントは分けない。タイトルカードもホーム画面も同じ page で goto するだけで、
 * 新しいタブを開かないため（ctx.openExtensionPage は現ページを goto する）。
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hoverSequence, hoverSlow } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TITLE_CARD = pathToFileURL(path.resolve(__dirname, '..', 'assets', 'title-card.html'));

/** タイトルカードに焼くバージョン。package.json と揃える */
const VERSION = '0.2.0';

export default {
    id: '01',
    slug: 'intro',
    title: 'イントロ — この拡張でできること',
    narration: '01-intro',

    async run(ctx) {
        const durations = loadCueDurations('01-intro');

        // --- cue 01: タイトルカード ---
        await ctx.page.goto(`${TITLE_CARD}?version=${VERSION}`);
        await ctx.page.locator('.headline').waitFor({ state: 'visible', timeout: 15000 });
        await ctx.sleep(800);

        ctx.cue(1);
        const cue1StartedAt = Date.now();
        // タイトルカードは静止画なので、カーソルだけ画面中央へゆっくり寄せて動きを作る。
        await hoverSlow(ctx.page, ctx.page.locator('.brand-row'), { durationMs: 1600, steps: 24 });
        await ctx.sleep(600);
        await hoverSlow(ctx.page, ctx.page.locator('.subtext'), { durationMs: 1400, steps: 20 });
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        // --- cue 02: ホーム画面（完成済みプロジェクト）---
        await ctx.openExtensionPage('app/app.html?demoSeed=11-export&demoLatency=0#/home');
        await ctx.page.locator('#app-sidebar .app__nav-list button').first()
            .waitFor({ state: 'visible', timeout: 20000 });
        // ヘッダーの Protocol / Formula / 累積コストが出そろうまで待つ
        await ctx.page.locator('#app-context').filter({ hasText: 'Protocol' })
            .waitFor({ state: 'visible', timeout: 20000 });
        await ctx.sleep(800);

        ctx.cue(2);
        const cue2StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#app-content h2'), { durationMs: 900 });
        await ctx.sleep(700);
        await hoverSlow(ctx.page, ctx.page.locator('.home__summary'), { durationMs: 800 });
        await ctx.sleep(900);
        // ヘッダー右上のプロジェクト名 → バージョン・累積コスト
        await hoverSlow(ctx.page, ctx.page.locator('#app-status'), { durationMs: 900 });
        await ctx.sleep(1100);
        await hoverSlow(ctx.page, ctx.page.locator('#app-context'), { durationMs: 800 });
        await ctx.sleep(1200);
        await hoverSlow(ctx.page, ctx.page.locator('dl.home__status'), { durationMs: 900 });
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);

        // --- cue 03: サイドナビ 10 項目 ---
        ctx.cue(3);
        const cue3StartedAt = Date.now();
        const navButtons = ctx.page.locator('#app-sidebar .app__nav-list button');
        const navCount = await navButtons.count();
        const navLocators = [];
        for (let i = 0; i < navCount; i++) navLocators.push(navButtons.nth(i));
        // ナレーション（約 18 秒）に対して 10 項目。1 項目あたり移動 + 静止で約 1.5 秒。
        await hoverSequence(ctx.page, navLocators, { holdMs: 800, moveMs: 700 });
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);

        // --- cue 04: 3 部作での位置づけ ---
        ctx.cue(4);
        const cue4StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#app-home-link'), { durationMs: 900 });
        await ctx.sleep(1000);
        await hoverSlow(ctx.page, ctx.page.locator('.home__switch-project'), { durationMs: 900 });
        await ctx.sleep(1000);
        await hoverSlow(ctx.page, ctx.page.locator('#app-settings-link'), { durationMs: 900 });
        await sleepRemainder(ctx, cue4StartedAt, durations['04'] * 1000 + 500);
    },
};
