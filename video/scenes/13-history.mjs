/**
 * 第 13 章「バージョン履歴と設定・困ったときは」
 *
 * `#/history` の 2 バージョン → 読み込み → `#/settings` のカスタムモデル追加、まで。
 *
 * ## 章 02 と重複させない（§4 の章立ての注意 1）
 *
 * 章 02 は「初回セットアップとして API キーを入れる」だけを扱った。この章では
 * **章 02 が触れていない要素だけ**を見せる: カスタムモデルの追加（`#settings-custom-model-id`
 * / `#settings-custom-model-label` / 追加ボタン / `#settings-custom-models-list`）。
 * API キー欄・tier バッジ・保存ボタンには触れない。
 *
 * ## セレクタの注意
 *
 * - `.history__item` 等は 2 行ぶんあるので `li.history__item[data-version-id="v2-demo"]` で絞る
 * - 「このバージョンを読み込む」を押すと store が更新されて一覧が再描画され、
 *   `.history__status` が一瞬 `履歴を読み込み中…` に戻る（onList の再実行）
 * - 設定の「追加」ボタンは id が無い。`.settings__custom-model-form button` で取る
 *   （`#settings-save` とは別物）
 * - **差分（diff）表示は無い。** あるのは `pre.history__preview`（先頭 10 行）だけ
 *
 * demoLatency=0: `#/settings` を開くと Gemini のプラン判定が走る（tier 未保存 +
 * キーあり）。章 02 と同じ「確認中...」の絵が出てしまうので、待たせず一瞬で終わらせる。
 */

import { hoverSlow } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';

export default {
    id: '13',
    slug: 'history',
    title: 'バージョン履歴と設定・困ったときは',
    narration: '13-history',

    async run(ctx) {
        const durations = loadCueDurations('13-history');

        await ctx.openExtensionPage('app/app.html?demoSeed=13-history&demoLatency=0#/history');
        await ctx.page.locator('li.history__item').first().waitFor({ state: 'visible', timeout: 25000 });
        await ctx.sleep(800);

        const v2 = ctx.page.locator('li.history__item[data-version-id="v2-demo"]');
        const v1 = ctx.page.locator('li.history__item[data-version-id="v1-demo"]');

        // --- cue 01: 2 つのバージョンと、そこに残る情報 ---
        ctx.cue(1);
        const cue1StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('p.history__status'), { durationMs: 800 });
        await ctx.sleep(1000);
        await hoverSlow(ctx.page, v2.locator('p.history__head'), { durationMs: 900 });
        await ctx.sleep(1400);
        await hoverSlow(ctx.page, v2.locator('span.history__badge'), { durationMs: 700 });
        await ctx.sleep(900);
        await hoverSlow(ctx.page, v2.locator('p.history__note'), { durationMs: 900 });
        await ctx.sleep(1000);
        await hoverSlow(ctx.page, v1.locator('p.history__head'), { durationMs: 800 });
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        // --- cue 02: プレビューと読み込み ---
        ctx.cue(2);
        const cue2StartedAt = Date.now();
        await hoverSlow(ctx.page, v1.locator('pre.history__preview'), { durationMs: 900 });
        await ctx.sleep(1400);
        const loadBtn = v1.locator('button.history__load');
        await hoverSlow(ctx.page, loadBtn, { durationMs: 700 });
        await loadBtn.click();
        // 再描画で一覧が作り直され、読み込み中バッジが v1 側へ移る
        await ctx.page.locator('li.history__item[data-version-id="v1-demo"] span.history__badge')
            .waitFor({ state: 'visible', timeout: 20000 })
            .catch(() => {});
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);

        // --- cue 03: 設定のカスタムモデル追加（章 02 で扱っていない部分） ---
        await ctx.openExtensionPage('app/app.html?demoSeed=13-history&demoLatency=0#/settings');
        await ctx.page.locator('#settings-custom-model-id').waitFor({ state: 'visible', timeout: 25000 });
        await ctx.sleep(600);

        ctx.cue(3);
        const cue3StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#settings-llm-model'), { durationMs: 800 });
        await ctx.sleep(1200);
        const modelId = ctx.page.locator('#settings-custom-model-id');
        await hoverSlow(ctx.page, modelId, { durationMs: 700 });
        await modelId.click();
        await modelId.pressSequentially('meta-llama/llama-3.3-70b', { delay: 55 });
        await ctx.sleep(500);
        const addBtn = ctx.page.locator('.settings__custom-model-form button');
        await hoverSlow(ctx.page, addBtn, { durationMs: 600 });
        await addBtn.click();
        await ctx.page.locator('#settings-custom-models-list .settings__custom-model-item')
            .first()
            .waitFor({ state: 'visible', timeout: 20000 })
            .catch(() => {});
        await hoverSlow(ctx.page, ctx.page.locator('#settings-custom-models-list'), { durationMs: 800 });
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);

        // --- cue 04: 困ったときはヘルプページへ ---
        ctx.cue(4);
        const cue4StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('button.settings__back-btn'), { durationMs: 800 });
        await ctx.sleep(1000);
        await hoverSlow(ctx.page, ctx.page.locator('#app-home-link'), { durationMs: 800 });
        await sleepRemainder(ctx, cue4StartedAt, durations['04'] * 1000 + 500);
    },
};
