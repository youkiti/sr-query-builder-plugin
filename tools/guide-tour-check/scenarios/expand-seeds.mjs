import { defineScenario } from '../lib/scenario.mjs';
import { startTour, goNav } from '../lib/tour.mjs';

const TARGET = name => `[data-tour="${name}"]`;
// デモのコーパスで、境界事例として include する文献（それ以外は exclude にする）。
const INCLUDE_PMID = '90000006';
const FETCH_TIMEOUT = 120000;

export default defineScenario({
    name: 'expand-seeds',
    title: '境界事例を実際に取得し、キー操作で全件を判定して、更新提案を出す',
    async run(run) {
        // 検索式が検証済みで、シード論文が登録された状態から始める。
        await run.open('09-expand');
        await startTour(run, 'expand-seeds');
        await run.step('open-expand', 'nav-expand');
        await goNav(run, 'expand');
        await run.step('fetch-candidates', 'expand-fetch');
        await run.click(TARGET('expand-fetch'));
        await run.step('judge-candidates', 'expand-candidates', { timeout: FETCH_TIMEOUT });

        // 判定は、説明のとおりキー操作（i / e）で行う。判定すると自動で次の未判定へ移り、全件の判定が終わると更新提案が出る。
        await run.action('候補をキー操作で判定する', async () => {
            const cards = run.page.locator('li.expand__candidate');
            const total = await cards.count();
            for (let i = 0; i < total; i++) {
                const card = cards.nth(i);
                const pmid = await card.getAttribute('data-pmid');
                await run.page.keyboard.press(pmid === INCLUDE_PMID ? 'i' : 'e');
                await card.locator('.expand__candidate-status').filter({ hasText: '保存しました' }).waitFor({ timeout: 30000 });            }
        });
        await run.next();
        await run.step('update-proposals', 'expand-proposals', { timeout: FETCH_TIMEOUT });
        await run.next();
        await run.step('finish', 'tour-list');
        await run.finish('expand-seeds');
    },
});
