/**
 * 第 9 章「対話的シード拡張（実験的機能）」
 *
 * 「境界事例を取得」→ 3 件を判定 → ラウンド完了で再検証 + 更新提案、まで。
 *
 * ## 絵が成立する条件（実装を読んで確定させたもの）
 *
 * 1. **3 件すべてを判定し切らないとラウンド完了ブロックが出ない**
 *    （`expandView.ts` の `checkRoundComplete` は `items.every(isDecided)`）。
 *    `.expand__round-summary`（再検証結果）も `.expand__proposals`（更新提案）も出ない。
 * 2. **1 件以上 include しないと更新提案が空になる**
 *    （`buildUpdateProposals` は include した論文だけを集計対象にする）。
 *    → 90000006 を include、残り 2 件を exclude する。90000006 は ECMO ブロックの
 *      拡張語（MeSH と "extracorporeal life support"）が両方マッチするので
 *      「ブロック #2（1 件回収）」が確実に出る。
 * 3. **抄録はフォーカス中のカードにしか表示されない**（CSS の
 *    `.expand__candidate--focused` 制御）。「本文が読める」と言う cue では
 *    そのカードにフォーカスがある状態にしておく。
 *
 * ## セレクタの注意
 *
 * 進捗トラッカーは `.expand__tracker` だが、**中身のチップは `draft__` のクラスを
 * 再利用している**（`.draft__step` / `.draft__progressbar` 等）。expandView が
 * draft の視覚プリミティブを共用する設計なので、ここで `draft__` が出るのは正しい。
 *
 * 判定ボタンは class を持たず `button[data-decision="include"]` のみ。3 カード × 3 個 =
 * 9 個あるので、必ず `li.expand__candidate[data-pmid="…"]` でスコープする。
 *
 * demoLatency=4: 取得パイプラインは LLM 2 回 + eutils 数回で等倍 3.1 秒。
 * 6 段階の進捗を読ませたいので 4 倍（約 12 秒）にする。
 */

import { hoverSlow, smoothWheel } from './lib/gestures.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';

/** include する候補（ECMO ブロックの更新提案を確実に出すため） */
const INCLUDE_PMID = '90000006';

async function hoverIfVisible(page, locator, options) {
    if (await locator.isVisible().catch(() => false)) {
        await hoverSlow(page, locator, options);
    }
}

export default {
    id: '09',
    slug: 'expand',
    title: '対話的シード拡張（実験的機能）',
    narration: '09-expand',

    async run(ctx) {
        const durations = loadCueDurations('09-expand');

        await ctx.openExtensionPage('app/app.html?demoSeed=09-expand&demoLatency=4#/expand');
        await ctx.page.locator('.expand__actions button').waitFor({ state: 'visible', timeout: 25000 });
        await ctx.sleep(800);

        // --- cue 01: 実験的機能であることと、何をする画面か ---
        ctx.cue(1);
        const cue1StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('p.expand__dev'), { durationMs: 1000 });
        await ctx.sleep(1800);
        await hoverSlow(ctx.page, ctx.page.locator('p.expand__lead'), { durationMs: 1000 });
        await sleepRemainder(ctx, cue1StartedAt, durations['01'] * 1000 + 500);

        // --- cue 02: 取得ボタン → 6 段階の進捗 ---
        ctx.cue(2);
        const cue2StartedAt = Date.now();
        const fetchBtn = ctx.page.locator('.expand__actions button');
        await hoverSlow(ctx.page, fetchBtn, { durationMs: 700 });
        await fetchBtn.click();
        await ctx.page.locator('.expand__tracker').waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
        // チップ（プロトコル取得 → … → AI 選定）を順になぞる。実行が先に終わっても
        // 詰まらないよう存在チェック付きで触る。
        const chips = ctx.page.locator('.expand__tracker .draft__step');
        const chipCount = await chips.count();
        for (let i = 0; i < chipCount; i++) {
            await hoverIfVisible(ctx.page, chips.nth(i), { durationMs: 500 });
            await ctx.sleep(400);
        }
        await hoverIfVisible(ctx.page, ctx.page.locator('p.expand__status'), { durationMs: 700 });
        await sleepRemainder(ctx, cue2StartedAt, durations['02'] * 1000 + 500);

        // --- 取得完了を待つ（カーソルを動かしたまま）---
        const candidates = ctx.page.locator('li.expand__candidate');
        const deadline = Date.now() + 120000;
        while ((await candidates.count()) === 0) {
            if (Date.now() > deadline) {
                throw new Error('[09-expand] 境界事例の取得が 120 秒たっても完了しませんでした');
            }
            await hoverIfVisible(ctx.page, ctx.page.locator('p.expand__status'), { durationMs: 600 });
            await ctx.sleep(500);
        }
        await ctx.sleep(600);

        // --- cue 03: 取得結果と候補カード ---
        ctx.cue(3);
        const cue3StartedAt = Date.now();
        await hoverSlow(ctx.page, ctx.page.locator('p.expand__status'), { durationMs: 800 });
        await ctx.sleep(1600);
        await hoverSlow(ctx.page, candidates.first().locator('.expand__candidate-head'), { durationMs: 800 });
        await ctx.sleep(1000);
        await hoverSlow(ctx.page, candidates.first().locator('.expand__candidate-reason'), { durationMs: 800 });
        await ctx.sleep(1400);
        // 抄録はフォーカス中のカードにだけ出る。1 件目は初期フォーカス済み。
        await hoverIfVisible(ctx.page, candidates.first().locator('.expand__candidate-abstract-body'), { durationMs: 800 });
        await sleepRemainder(ctx, cue3StartedAt, durations['03'] * 1000 + 500);

        // --- cue 04: include / exclude / maybe で 3 件を判定 ---
        ctx.cue(4);
        const cue4StartedAt = Date.now();
        const total = await candidates.count();
        for (let i = 0; i < total; i++) {
            const card = candidates.nth(i);
            const pmid = await card.getAttribute('data-pmid');
            const decision = pmid === INCLUDE_PMID ? 'include' : 'exclude';
            const btn = card.locator(`button[data-decision="${decision}"]`);
            await hoverSlow(ctx.page, btn, { durationMs: 600 });
            await btn.click();
            // 「include として保存しました」等が出るのを待つ
            await card.locator('.expand__candidate-status')
                .filter({ hasText: '保存しました' })
                .waitFor({ state: 'visible', timeout: 30000 })
                .catch(() => {});
            await ctx.sleep(700);
        }
        await sleepRemainder(ctx, cue4StartedAt, durations['04'] * 1000 + 500);

        // --- cue 05: ラウンド完了 → 再検証結果と更新提案 ---
        await ctx.page.locator('.expand__round-summary').waitFor({ state: 'visible', timeout: 120000 }).catch(() => {});
        await ctx.sleep(500);

        ctx.cue(5);
        const cue5StartedAt = Date.now();
        await smoothWheel(ctx.page, 400, { steps: 12, stepDelayMs: 85 });
        await ctx.sleep(400);
        await hoverIfVisible(ctx.page, ctx.page.locator('.expand__round-summary'), { durationMs: 900 });
        await ctx.sleep(2200);
        await hoverIfVisible(ctx.page, ctx.page.locator('section.expand__proposals h3'), { durationMs: 800 });
        await ctx.sleep(1200);
        await hoverIfVisible(ctx.page, ctx.page.locator('p.expand__proposal-head').first(), { durationMs: 800 });
        await sleepRemainder(ctx, cue5StartedAt, durations['05'] * 1000 + 500);

        // --- cue 06: 採用は次章の #/edit で ---
        ctx.cue(6);
        const cue6StartedAt = Date.now();
        await hoverIfVisible(ctx.page, ctx.page.locator('ul.expand__proposal-terms li').first(), { durationMs: 800 });
        await ctx.sleep(1200);
        await hoverSlow(
            ctx.page,
            ctx.page.locator('#app-sidebar .app__nav-list button').filter({ hasText: '検索式編集' }),
            { durationMs: 900 }
        );
        await sleepRemainder(ctx, cue6StartedAt, durations['06'] * 1000 + 500);
    },
};
