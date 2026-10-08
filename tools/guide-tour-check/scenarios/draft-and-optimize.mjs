import { defineScenario } from '../lib/scenario.mjs';
import { startTour, goNav } from '../lib/tour.mjs';

const TARGET = name => `[data-tour="${name}"]`;
// 自動調整の完了までは、デモの通信の差し替えでも数十秒かかる。
const RUN_TIMEOUT = 240000;

export default defineScenario({
    name: 'draft-and-optimize',
    title: '自動調整を実際に走らせ、設定・履歴・最終レビュー・保留候補・補助操作をたどる',
    async run(run) {
        // 承認済みのプロトコルとシード論文があり、検索式がまだ無い状態から始める。
        await run.open('07-draft');
        await startTour(run, 'draft-and-optimize');
        await run.step('open-draft', 'nav-draft');
        await goNav(run, 'draft');
        await run.step('optimize-settings', 'draft-optimize-settings');
        await run.next();
        await run.step('optimize-start', 'draft-optimize-start');
        await run.click(TARGET('draft-optimize-start'));
        await run.step('optimize-history', 'draft-optimize-history', { timeout: RUN_TIMEOUT });
        await run.next();
        await run.step('optimize-review', 'draft-optimize-review', { timeout: RUN_TIMEOUT });
        await run.next();
        const held = await run.page.locator(`${TARGET('draft-held-candidates')}:visible`).count();
        if (held > 0) await run.step('held-candidates', 'draft-held-candidates');
        else await run.waitingStep('held-candidates', 'デモの自動調整では保留候補が出ない');
        // 検証・補助操作は、現在の検索式があるときだけ出る。最終レビューから採用して保存する。
        await run.action('最終レビューの「採用して保存」を押して保存する', async () => {
            await run.page.getByRole('button', { name: '採用して保存', exact: true }).click();
            await run.page.locator('.optimization__save-status').filter({ hasText: '保存しました' }).waitFor({ timeout: 60000 });
        });
        await run.next();
        await run.step('revalidate', 'draft-secondary-actions');
        await run.next();
        await run.step('finish', 'tour-list');
        await run.finish('draft-and-optimize');
    },
});
