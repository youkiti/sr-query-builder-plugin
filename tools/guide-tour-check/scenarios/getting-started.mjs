import { defineScenario } from '../lib/scenario.mjs';
import { startTour, goNav } from '../lib/tour.mjs';

const PROTOCOL_TEXT = [
    '# 研究プロトコル',
    '## リサーチクエスチョン',
    '成人 ARDS に対する ECMO は生存率を改善するか',
    '## PICO',
    '- P: 成人（18 歳以上）の急性呼吸窮迫症候群（ARDS）患者',
    '- I: 体外式膜型人工肺（ECMO）',
    '- C: 通常の人工呼吸管理',
    '- O: 院内死亡・28 日死亡',
    '## 組入基準',
    '- ランダム化比較試験',
    '## 除外基準',
    '- 小児を対象とした研究',
].join('\n');

export default defineScenario({
    name: 'getting-started',
    title: 'プロトコルの入力・解析からブロック承認・シード論文の登録まで（途中で読み込み直して再開を確かめ、移動の手順は 2 周目で撮る）',
    async run(run) {
        // 1 周目: 未入力のプロジェクトから、実際に解析・承認して進める。
        await run.open('04-protocol');
        await startTour(run, 'getting-started');
        await run.step('welcome', 'nav');
        await run.next();
        await run.step('open-protocol', 'nav-protocol');
        await goNav(run, 'protocol');
        await run.step('enter-protocol', 'protocol-form');

        // 再開位置の保存を待ってから読み込み直し、同じ手順から続くことを確かめる。
        await run.action('再開位置の保存を待ってページを再読み込みする', async () => {
            await run.page.waitForFunction(async () => {
                const items = await chrome.storage.local.get('guide_progress');
                return items.guide_progress?.active?.tourId === 'getting-started' &&
                    items.guide_progress.active.stepId === 'enter-protocol';
            });
            await run.page.reload();
        });
        await run.step('enter-protocol', 'protocol-form');

        await run.action('プロトコル本文を入力して解析する', async () => {
            await run.page.locator('textarea#inline').fill(PROTOCOL_TEXT);
            await run.page.locator('button.protocol__submit').click();
            // 解析が終わるとブロック承認へ自動で移る（そのため「ブロック承認を開く」の手順は 1 周目では出ない）。
            await run.page.waitForURL('**#/blocks', { timeout: 60000 });
        });
        await run.step('review-blocks', 'blocks-list');
        await run.next();
        await run.step('review-filters', 'blocks-filters');
        await run.next();
        await run.step('approve-blocks', 'blocks-approve');
        await run.click('[data-tour="blocks-approve"]');
        // 承認すると、保存のあとシード論文へ自動で移る（「シード論文を開く」の手順は 1 周目では出ない）。
        await run.action('承認の保存が終わりシード論文へ移る', () => run.page.waitForURL('**#/seeds', { timeout: 60000 }));
        await run.step('add-seeds', 'seeds-form');
        await run.action('シード論文の PMID を登録する', async () => {
            await run.page.locator('textarea.seeds__pmid-input').fill('90000001\n90000002\n90000003');
            await run.page.locator('fieldset', { has: run.page.locator('textarea.seeds__pmid-input') })
                .locator('button.seeds__primary').click();
            await run.page.locator('ul.seeds__list > li').first().waitFor({ timeout: 30000 });
        });
        await run.next();
        await run.step('finish', 'tour-list');
        await run.finish('getting-started');

        // 2 周目: 前提が整ったので、移動を促す手順（ブロック承認・シード論文を開く）を撮る。
        await goNav(run, 'home');
        await startTour(run, 'getting-started');
        await run.step('welcome', 'nav');
        await run.next();
        await run.step('open-blocks', 'nav-blocks');
        await goNav(run, 'blocks');
        await run.step('review-blocks', 'blocks-list');
        await run.next();
        await run.step('review-filters', 'blocks-filters');
        await run.next();
        await run.step('open-seeds', 'nav-seeds');
        await goNav(run, 'seeds');
        await run.step('add-seeds', 'seeds-form');
        await run.next();
        await run.step('finish', 'tour-list');
        await run.finish('getting-started');
    },
});
