import { defineScenario } from '../lib/scenario.mjs';
import { startTour, goNav } from '../lib/tour.mjs';

const TARGET = name => `[data-tour="${name}"]`;
const BLOCK = 'li.edit__block-row[data-block-id="2"]';

export default defineScenario({
    name: 'edit-and-export',
    title: 'AI の改善案でブロックを開いて直し、新バージョンとして保存し、4 DB へ変換して結果を見る',
    async run(run) {
        // 検索式の版があり、境界事例を include 済みの状態から始める。
        await run.open('10-edit');
        await startTour(run, 'edit-and-export');
        await run.step('open-edit', 'nav-edit');
        await goNav(run, 'edit');
        await run.step('edit-blocks', 'edit-blocks');

        // ブロックを AI の改善案で開いて採用する（開くとインスペクタが出て、保存も押せるようになる）。
        await run.action('ブロック #2 を AI の改善案で直す', async () => {
            const block = run.page.locator(BLOCK);
            await block.hover();
            await block.locator('button.edit__block-improve').click();
            await block.locator('button.edit__block-ai-submit').click();
            await block.locator('button.edit__block-accept').click({ timeout: 90000 });
        });
        await run.next();
        await run.step('inspect-block', 'edit-inspector');
        await run.next();
        await run.step('save-version', 'edit-save');
        await run.action('編集メモを書いて新バージョンとして保存する', async () => {
            await run.page.locator('input.edit__note-input').fill('ブロック #2 を改善');
            await run.page.locator(TARGET('edit-save')).click();
            await run.page.locator('p.edit__status').filter({ hasText: '保存しました' }).waitFor({ timeout: 60000 });
        });
        await run.step('open-export', 'nav-export');
        await goNav(run, 'export');
        await run.step('run-export', 'export-run');
        await run.action('4 DB へ変換して保存する', async () => {
            await run.page.locator(TARGET('export-run')).click();
            await run.page.locator('details.export__result').first().waitFor({ timeout: 90000 });
        });
        await run.next();
        await run.step('convert-databases', 'export-results');
        await run.next();
        await run.step('finish', 'tour-list');
        await run.finish('edit-and-export');
    },
});
