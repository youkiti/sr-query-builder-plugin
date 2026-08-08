/**
 * 第 3 章「プロジェクトを作る・開く」
 *
 * popup（プロジェクト選択画面）→ 作成 → 新しいタブで開くメインビュー、まで。
 *
 * ## この章に固有の 3 つの注意
 *
 * 1. **storageSeed で Gemini キーを先に入れる。**
 *    `openAppOrRedirect`（src/popup/bootstrap.ts）は Gemini キーが未設定だと
 *    app.html ではなく `#/settings` へ飛ばす。record.mjs はシーンごとに使い捨ての
 *    プロファイルを作るので、第 2 章で入れた値は残っていない。実測で確認済み。
 *
 * 2. **popup はページ拡大が要る。**
 *    `.popup { width: 360px }` 固定で、しかも manifest に default_popup が無く
 *    service worker が chrome.tabs.create でフルタブとして開くため（吹き出しではない）、
 *    1920 幅では左上に細い列として映る。`applyPageZoom(1.8)` で 648x836 になる。
 *    **zoom はナビゲーションのたびにリセットされる**ので goto の直後に必ず呼び直す。
 *
 * 3. **新規タブは newSegment で追う。**
 *    `ctx.openExtensionPage` は現ページを goto するだけで新しいタブを作らない。
 *    作成ボタンが開く新規タブへ録画対象を移すには ctx.newSegment(page) が要る。
 *
 * デモの identity は自動ログイン済みなので「Google でログイン」ボタンは
 * hidden で映らない。ナレーションは「初回はこの画面にボタンが表示されます」と
 * 説明する形にしてあり、映っていないものを「これが」とは呼ばない（§4 注意 3）。
 */

import { hoverSlow } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';
import { applyPageZoom } from './lib/zoom.mjs';

const PROJECT_TITLE = 'ARDS/ECMO 生存率 SR（デモ・架空データ）';
const POPUP_ZOOM = 1.8;

export default {
    id: '03',
    slug: 'project',
    title: 'プロジェクトを作る・開く',
    narration: '03-project',

    // 未設定だと作成後に #/settings へリダイレクトされてしまうため、先に入れておく。
    // 値はデモ用のダミー（実キーではない）。
    storageSeed: {
        'apiKeys.gemini': 'AIzaSyDEMO-0000-not-a-real-key-000000',
        'gemini.detectedTier': 'paid',
        'llm.model': 'gemini-3.5-flash',
    },

    async run(ctx) {
        const durations = loadCueDurations('03-project');

        await ctx.openExtensionPage('popup/popup.html?demoLatency=2');
        await applyPageZoom(ctx.page, POPUP_ZOOM);
        await ctx.page.locator('#popup-create-title').waitFor({ state: 'visible', timeout: 20000 });
        // ログイン状態の解決（#popup-projects の表示）を待つ
        await ctx.page.locator('#popup-email').filter({ hasText: '@' })
            .waitFor({ state: 'visible', timeout: 20000 });
        await ctx.sleep(800);

        // --- cue 01: この画面は何か・初回のログイン ---
        ctx.cue(1);
        const cue1StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('.popup__title'), { durationMs: 900 });
        await ctx.sleep(1400);
        await hoverSlow(ctx.page, ctx.page.locator('#popup-email'), { durationMs: 900 });
        await ctx.sleep(1600);
        await hoverSlow(ctx.page, ctx.page.locator('#popup-status'), { durationMs: 900 });
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        // --- cue 02: プロジェクト = スプレッドシート + Drive フォルダ ---
        ctx.cue(2);
        const cue2StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#popup-create-form'), { durationMs: 1000 });
        await ctx.sleep(1600);
        await hoverSlow(ctx.page, ctx.page.locator('#popup-create-title'), { durationMs: 900 });
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);

        // --- cue 03: タイトルを入れて作成 ---
        ctx.cue(3);
        const cue3StartedAt = Date.now();
        await ctx.page.locator('#popup-create-title').click();
        await ctx.page.locator('#popup-create-title').pressSequentially(PROJECT_TITLE, { delay: 70 });
        await ctx.sleep(600);

        const submitButton = ctx.page.locator('#popup-create-form button[type="submit"]');
        await hoverSlow(ctx.page, submitButton, { durationMs: 700 });

        // 作成ボタンが開く新規タブを拾う。openExtensionPage では追えない経路。
        const browserContext = ctx.page.context();
        const [appPage] = await Promise.all([
            browserContext.waitForEvent('page', { timeout: 60000 }),
            submitButton.click(),
        ]);
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);

        // --- cue 04: 新しいタブで開いたメインビュー ---
        await appPage.waitForLoadState('domcontentloaded');
        await appPage.locator('#app-sidebar .app__nav-list button').first()
            .waitFor({ state: 'visible', timeout: 20000 });
        // ここから録画対象を新規タブへ切り替える（segment-1 が始まる）
        ctx.newSegment(appPage);
        await ctx.sleep(800);

        ctx.cue(4);
        const cue4StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('#app-content h2'), { durationMs: 900 });
        await ctx.sleep(1200);
        await hoverSlow(ctx.page, ctx.page.locator('#app-status'), { durationMs: 900 });
        await ctx.sleep(1200);
        // グレーアウトしている先の項目をなぞる
        const disabledNav = ctx.page.locator('#app-sidebar .app__nav-list button.is-disabled');
        const disabledCount = await disabledNav.count();
        for (let i = 0; i < Math.min(disabledCount, 3); i++) {
            await hoverSlow(ctx.page, disabledNav.nth(i), { durationMs: 600 });
            await ctx.sleep(500);
        }
        await sleepRemainder(ctx, cue4StartedAt, durations['04'] * 1000 + 500);
    },
};
