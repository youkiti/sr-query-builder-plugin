/**
 * 第 2 章「準備 — API キーを登録する」
 *
 * 撮る画面は `app/app.html#/settings`（options.html ではない）。
 * options.html には UI 上の導線が存在せず（popup の「設定を開く」も #/settings を開く。
 * src/popup/bootstrap.ts の openOptions 参照）、利用者がたどり着けない画面を
 * 「これが設定画面です」と説明するのは §4 の章立ての注意 3 に反するため。
 * この判断で video/REQUIREMENTS.md §4 / §8-5 の記述も実装に合わせて修正済み。
 *
 * 見せるプロバイダは Gemini のみ（§10 の未決事項の決着）。OpenRouter のカードは
 * 画面に映るので 1 文だけ触れるが、操作はしない。
 *
 * demoLatency=8: プラン判定プローブ（LLM 1 回 = 0.6s × 8 ≒ 4.8s）を
 * 「確認中...」バッジが読める長さにするため。
 *
 * API キーは type="password" でマスクされるが、入力するのは実キーではなく
 * デモ用のダミー文字列（§8-5 の映り込みチェック）。
 */

import { hoverSlow, smoothWheel } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';

/** 画面に映るダミー文字列。実在のキーではない */
const DUMMY_GEMINI_KEY = 'AIzaSyDEMO-0000-not-a-real-key-000000';
const DUMMY_NCBI_KEY = '0123456789demo0000000000000000000000';

export default {
    id: '02',
    slug: 'setup',
    title: '準備 — API キーを登録する',
    narration: '02-setup',

    async run(ctx) {
        const durations = loadCueDurations('02-setup');

        await ctx.openExtensionPage('app/app.html?demoLatency=8#/settings');
        await ctx.page.locator('#settings-save').waitFor({ state: 'visible', timeout: 20000 });
        await ctx.sleep(800);

        // --- cue 01: BYOK の考え方 ---
        ctx.cue(1);
        const cue1StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#app-content h2'), { durationMs: 900 });
        await ctx.sleep(1200);
        await hoverSlow(ctx.page, ctx.page.locator('#settings-gemini-card'), { durationMs: 1000 });
        await ctx.sleep(1500);
        await smoothWheel(ctx.page, 220, { steps: 10, stepDelayMs: 110 });
        await ctx.sleep(1500);
        await smoothWheel(ctx.page, -220, { steps: 10, stepDelayMs: 110 });
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        // --- cue 02: Google AI Studio で鍵を発行する ---
        ctx.cue(2);
        const cue2StartedAt = Date.now();
        // カード見出しと「APIキーを取得」リンク（実際にクリックはしない。外部サイトへ出るため）
        await hoverSlow(ctx.page, ctx.page.locator('#settings-gemini-card'), { durationMs: 900 });
        await ctx.sleep(1000);
        const getKeyLink = ctx.page.locator('#settings-gemini-card a').first();
        if (await getKeyLink.count()) {
            await hoverSlow(ctx.page, getKeyLink, { durationMs: 900 });
            await ctx.sleep(1400);
        }
        await hoverSlow(ctx.page, ctx.page.locator('#settings-gemini-key'), { durationMs: 800 });
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);

        // --- cue 03: 伏せ字で入力する ---
        ctx.cue(3);
        const cue3StartedAt = Date.now();
        await ctx.page.locator('#settings-gemini-key').click();
        // 1 文字ずつ打って「伏せ字になる」ことを画面で見せる
        await ctx.page.locator('#settings-gemini-key').pressSequentially(DUMMY_GEMINI_KEY, { delay: 55 });
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);

        // --- cue 04: 保存 → プラン判定 → バッジ ---
        ctx.cue(4);
        const cue4StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#settings-save'), { durationMs: 700 });
        await ctx.page.locator('#settings-save').click();
        // 「確認中...」→「有料プラン」。demoLatency=8 で約 5 秒かかる
        await ctx.page.locator('#settings-gemini-tier-badge')
            .filter({ hasText: 'プラン' })
            .waitFor({ state: 'visible', timeout: 30000 });
        await hoverSlow(ctx.page, ctx.page.locator('#settings-gemini-tier-badge'), { durationMs: 900 });
        await sleepRemainder(ctx, cue4StartedAt, durations['04'] * 1000 + 500);

        // --- cue 05: モデル選択と OpenRouter ---
        ctx.cue(5);
        const cue5StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#settings-llm-model'), { durationMs: 900 });
        await ctx.sleep(2200);
        await hoverSlow(ctx.page, ctx.page.locator('#settings-openrouter-card'), { durationMs: 1000 });
        await sleepRemainder(ctx, cue5StartedAt, durations['05'] * 1000 + 500);

        // --- cue 06: NCBI キー（任意）→ 保存 ---
        ctx.cue(6);
        const cue6StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#settings-ncbi-key'), { durationMs: 800 });
        await ctx.page.locator('#settings-ncbi-key').click();
        await ctx.page.locator('#settings-ncbi-key').pressSequentially(DUMMY_NCBI_KEY, { delay: 30 });
        await ctx.sleep(700);
        await hoverSlow(ctx.page, ctx.page.locator('#settings-save'), { durationMs: 700 });
        await ctx.page.locator('#settings-save').click();
        await ctx.page.locator('.settings__status').filter({ hasText: '保存しました' })
            .waitFor({ state: 'visible', timeout: 30000 });
        await hoverSlow(ctx.page, ctx.page.locator('.settings__status'), { durationMs: 800 });
        await sleepRemainder(ctx, cue6StartedAt, durations['06'] * 1000 + 500);
    },
};
