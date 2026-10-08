import path from 'node:path';
import { OUT_DIR } from './paths.mjs';

const TIMEOUT = 30000;
const CARD = '.guide-tour-card';

export class Run {
    constructor(name, page, extId, lang, extensionDir, warnings) {
        Object.assign(this, { name, page, extId, lang, extensionDir, warnings });
        this.stepId = 'setup';
        this.sequence = 0;
        this.settle = 0;
    }

    async shot(label = this.stepId, settle = false) {
        const file = path.join(OUT_DIR, `${this.name}-${String(++this.sequence).padStart(2, '0')}-${label}.png`);
        if (settle && this.settle > 0) await this.page.waitForTimeout(this.settle);
        await this.page.screenshot({ path: file, timeout: 10000 });
        return file;
    }

    async action(condition, fn) {
        try {
            return await fn();
        } catch (cause) {
            const attrs = await this.page.locator(CARD).evaluateAll(cards => cards.map(card => ({
                step: card.getAttribute('data-guide-step'),
                waiting: card.getAttribute('data-guide-waiting'),
            }))).catch(() => '取得失敗');
            const screenshot = await this.shot(`FAIL-${this.stepId}`).catch(error => `保存失敗: ${error.message}`);
            throw new Error(`シナリオ ${this.name} / 手順 ${this.stepId}\n` +
                `待っていた条件: ${condition}\nカード data-guide-step / data-guide-waiting: ${JSON.stringify(attrs)}\n` +
                `URL: ${this.page.url()}\n画像: ${screenshot}\n原因: ${cause.message ?? cause}`);
        }
    }

    async visible(selector, timeout = TIMEOUT) {
        await this.action(`${selector} が表示される`, () => this.page.locator(selector).first().waitFor({ state: 'visible', timeout }));
    }

    async click(selector) {
        await this.action(`${selector} を押せる`, () => this.page.locator(selector).click());
    }

    /** 表示言語を保存してから、デモの初期状態（seed）で指定の画面を開く。 */
    async open(seed, hash = '#/home') {
        await this.action('表示言語を設定して画面を開く', async () => {
            await this.page.goto(`chrome-extension://${this.extId}/options/options.html`);
            await this.page.evaluate(lang => chrome.storage.local.set({ uiLanguage: lang }), this.lang);
            const query = seed ? `?demoSeed=${seed}` : '';
            await this.page.goto(`chrome-extension://${this.extId}/app/app.html${query}${hash}`);
        });
        await this.visible('#app-open-tours[aria-controls="guide-tour-list"]');
        await this.visible('.home__summary, #app-content h2');
    }

    /** カードが出ていて、対象に枠が重なり、カードが画面内に収まっていることを確かめて画像を残す。 */
    async step(id, target, { timeout = TIMEOUT } = {}) {
        this.stepId = id;
        await this.action(`カードが ${id}、data-guide-waiting=false になり、対象 ${target} と強調枠が重なる`, async () => {
            await this.page.locator(`${CARD}[data-guide-step="${id}"][data-guide-waiting="false"]`).waitFor({ timeout });
            await this.page.waitForFunction(({ id, target }) => {
                const card = document.querySelector(`.guide-tour-card[data-guide-step="${id}"]`);
                const highlight = document.querySelector('.guide-tour-highlight');
                const element = [...document.querySelectorAll(`[data-tour="${target}"]`)]
                    .find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
                if (!card || !highlight || highlight.hidden || !element) return false;
                const c = card.getBoundingClientRect(), h = highlight.getBoundingClientRect(), t = element.getBoundingClientRect();
                return c.width > 0 && c.height > 0 && c.left >= 0 && c.top >= 0 && c.right <= innerWidth && c.bottom <= innerHeight &&
                    t.right > 0 && t.bottom > 0 && t.left < innerWidth && t.top < innerHeight &&
                    h.left < t.right && h.right > t.left && h.top < t.bottom && h.bottom > t.top;
            }, { id, target }, { timeout });
            const overlap = await this.page.evaluate(target => {
                const c = document.querySelector('.guide-tour-card').getBoundingClientRect();
                const element = [...document.querySelectorAll(`[data-tour="${target}"]`)]
                    .find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
                const t = element.getBoundingClientRect();
                return c.left < t.right && c.right > t.left && c.top < t.bottom && c.bottom > t.top;
            }, target);
            if (overlap) this.warnings.push(`${this.name} / ${id}: カードが対象 ${target} を覆っています`);
            await this.shot(this.stepId, true);
        });
        console.log(`  ${this.name}: ${id}`);
    }

    /**
     * 対象を出せない手順を、待機の状態のままカードだけ確かめて画像を残す。
     * 動画の素材としては弱いので、デモで再現できない手順にだけ使い、報告で見分けられるよう警告に載せる。
     */
    async waitingStep(id, reason) {
        this.stepId = id;
        await this.action(`カードが ${id} になる（対象は待機のまま撮る）`, async () => {
            await this.page.locator(`${CARD}[data-guide-step="${id}"]`).waitFor({ timeout: TIMEOUT });
            await this.shot(this.stepId, true);
        });
        this.warnings.push(`${this.name} / ${id}: 待機の状態で撮影しました（${reason}）`);
        console.log(`  ${this.name}: ${id}（待機）`);
    }

    async next() {
        await this.click(`${CARD} [data-guide-action="next"]`);
    }

    /** 最後の手順の「完了」を押し、一覧のそのツアーに「済み」が付くことを確かめる。 */
    async finish(tourId) {
        await this.next();
        await this.action('完了でカードが消える', () => this.page.locator(CARD).waitFor({ state: 'detached', timeout: TIMEOUT }));
        await this.click('#app-open-tours');
        await this.visible('#guide-tour-list');
        await this.action(`一覧の ${tourId} に済みが付く`, async () => {
            await this.page.waitForFunction(({ tourId, done }) => {
                const button = document.querySelector(`#guide-tour-list [data-guide-tour="${tourId}"]`);
                return button?.previousElementSibling?.previousElementSibling?.textContent?.endsWith(` — ${done}`);
            }, { tourId, done: this.lang === 'en' ? 'Done' : '済み' }, { timeout: TIMEOUT });
            await this.shot('done');
        });
    }
}
