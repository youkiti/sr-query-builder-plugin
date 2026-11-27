/**
 * 論文の図にする画面（英語）を撮る。
 *
 * 撮るもの:
 * - review.png      自動調整の最終レビュー（src/app/views/queryOptimizationReview.ts）
 * - validation.png  採用して保存した式の検証結果（src/app/views/validationResults.ts）のうち、
 *                   行ごとの件数と、最終式の件数・シードの捕捉率
 * - combined-stacked.png  上の 2 枚を縦に積んだもの
 * - combined-columns.png  最終レビューを 2 段に分け、右の段の下に検証結果を置いたもの
 *
 * 出力先は tests/paper-figures/output/（git に入れない）。`PAPER_FIG_OUT` で変えられる。
 * ストア掲載用の hosted/screenshots/ には書かない。
 *
 * 実 API は叩かない。tests/shots/ と同じく tests/e2e/fixtures/appStub.ts のスタブに
 * 状態を流し込む。種データは fixtures.ts（英語の架空の例）。
 */

import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { injectAppStub } from '../e2e/fixtures/appStub';
import { paperScenario, reviewState, validatedState } from './fixtures';

const OUT_DIR = process.env.PAPER_FIG_OUT
  ? path.resolve(process.env.PAPER_FIG_OUT)
  : path.resolve(__dirname, 'output');

/** 日本語（ひらがな・カタカナ・漢字・全角記号）が残っていないことを確かめる */
const JAPANESE = /[、-ヿ一-鿿＀-￯]/;

test.beforeAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
});

function pngWidth(file: string): number {
  return readFileSync(file).readUInt32BE(16);
}

/** 文字が横に切れていない（要素の中身が枠からはみ出していない）ことを確かめる */
async function expectNoHorizontalOverflow(root: Locator): Promise<void> {
  const clipped = await root.evaluate((el) => {
    const bad: string[] = [];
    for (const node of [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))]) {
      if (node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== 'visible') {
        bad.push(`${node.tagName}.${node.className}`);
      }
    }
    return bad;
  });
  expect(clipped, '横にはみ出して切れている要素').toEqual([]);
}

/** ビューポートをページ全体の高さに広げる（下端に張り付く帯が本文に重ならないようにする） */
async function fitViewportToPage(page: Page): Promise<void> {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 1280, height: Math.ceil(height) + 40 });
  await page.waitForTimeout(200);
}

async function open(page: Page, state: Parameters<typeof paperScenario>[0]): Promise<void> {
  await injectAppStub(page, paperScenario(state));
  await page.goto('/app/app.html#/draft');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
}

test.describe('論文の図（英語の画面）', () => {
  test('review: 自動調整の最終レビュー', async ({ page }) => {
    await open(page, reviewState());
    const review = page.locator('.optimization__review');
    await expect(review).toBeVisible();
    await expect(review.locator('h3')).toHaveText(/^Final review/);
    await expect(review.locator('.optimization__candidate')).toHaveCount(3);
    await expect(review.getByRole('button', { name: 'Adopt and save' })).toBeEnabled();
    await expect(review.getByRole('button', { name: 'Edit and check' })).toBeEnabled();
    // 確認状況の小見出しは、英語表示でも状態と区分の間が全角コロン（U+FF1A）になる
    // （queryOptimizationReview.ts が言語によらず「：」でつなぐため）。画面はそのまま撮り、
    // ここではその 1 文字だけを除いて、ほかに日本語が残っていないことを確かめる。
    expect((await review.innerText()).replace(/：/g, ':')).not.toMatch(JAPANESE);
    await expectNoHorizontalOverflow(review);

    // 進捗の帯（.optimization__status）は画面の下端に張り付くので、そのまま要素を撮ると
    // レビューの途中に重なって写る。ビューポートをページ全体の高さに広げ、重ならない状態で撮る。
    await fitViewportToPage(page);
    const file = path.join(OUT_DIR, 'review.png');
    await review.screenshot({ path: file });
    expect(pngWidth(file)).toBeGreaterThanOrEqual(1600);

    // 2 段組の案のために、「式の外側の確認」の見出しの上で 2 つに切った版も撮る
    const box = (await review.boundingBox())!;
    const split = (await review.locator('h4', { hasText: 'Outside check and review of lost papers' }).boundingBox())!;
    const cut = split.y - 8;
    await page.screenshot({ path: path.join(OUT_DIR, 'review-part1.png'), fullPage: true,
      clip: { x: box.x, y: box.y, width: box.width, height: cut - box.y } });
    await page.screenshot({ path: path.join(OUT_DIR, 'review-part2.png'), fullPage: true,
      clip: { x: box.x, y: cut, width: box.width, height: box.y + box.height - cut } });
  });

  test('validation: 行ごとの件数とシードの捕捉率', async ({ page }) => {
    await open(page, validatedState());
    const status = page.locator('.draft__validate-status');
    const lineHits = page.locator('.validate__line-hits');
    const final = page.locator('.validate__final');
    await expect(status).toBeVisible();
    await expect(lineHits.locator('li')).toHaveCount(3);
    await expect(final).toContainText('Capture rate: 100.0% (8/8)');
    for (const part of [status, lineHits, final]) {
      expect(await part.innerText()).not.toMatch(JAPANESE);
      await expectNoHorizontalOverflow(part);
    }

    // 「検証完了」の行から、最終式の件数・捕捉率までを 1 枚に切り出す（その下の MeSH は入れない）
    await fitViewportToPage(page);
    const top = (await status.boundingBox())!;
    const bottom = (await final.boundingBox())!;
    const left = Math.min(top.x, bottom.x);
    const right = Math.max(top.x + top.width, bottom.x + bottom.width);
    const pad = 12;
    const file = path.join(OUT_DIR, 'validation.png');
    await page.screenshot({
      path: file,
      fullPage: true,
      clip: {
        // 幅は最終レビューの枠と同じ（本文の幅）にそろえ、1 枚にまとめたときに段がずれないようにする
        x: left - pad,
        y: top.y - pad,
        width: right - left,
        height: bottom.y + bottom.height - top.y + pad * 2,
      },
    });
    expect(pngWidth(file)).toBeGreaterThanOrEqual(1600);
  });

  test('combined: 2 枚を 1 枚にまとめる（縦積みの案と 2 段組の案）', async ({ page }) => {
    const img = (name: string): string =>
      `data:image/png;base64,${readFileSync(path.join(OUT_DIR, name)).toString('base64')}`;
    // 撮影は deviceScaleFactor 2 なので、CSS では半分の幅で置くと画素が 1:1 になる
    const tag = (name: string): string =>
      `<img src="${img(name)}" style="width:${pngWidth(path.join(OUT_DIR, name)) / 2}px">`;
    const style = `<style>
      body { margin: 0; background: #fff; font-family: Arial, Helvetica, sans-serif; }
      #fig { display: inline-flex; gap: 28px; padding: 20px; align-items: flex-start; }
      .col { display: flex; flex-direction: column; gap: 24px; }
      .label { font-size: 26px; font-weight: 700; margin: 0 0 8px; color: #111; }
      .label small { font-size: 16px; font-weight: 400; }
      img { display: block; border: 1px solid #b8bec6; }
    </style>`;
    const panel = (label: string, name: string): string =>
      `<div><p class="label">${label}</p>${tag(name)}</div>`;
    const layouts: Record<string, string> = {
      'combined-stacked.png':
        `<div id="fig"><div class="col">${panel('A', 'review.png')}${panel('B', 'validation.png')}</div></div>`,
      'combined-columns.png':
        `<div id="fig"><div class="col">${panel('A', 'review-part1.png')}</div>`
        + `<div class="col">${panel('A <small>(continued)</small>', 'review-part2.png')}${panel('B', 'validation.png')}</div></div>`,
    };
    for (const [name, body] of Object.entries(layouts)) {
      await page.setContent(`<!doctype html><html lang="en"><head>${style}</head><body>${body}</body></html>`);
      await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0));
      const fig = page.locator('#fig');
      const size = (await fig.boundingBox())!;
      await page.setViewportSize({ width: Math.ceil(size.width), height: Math.ceil(size.height) });
      const file = path.join(OUT_DIR, name);
      await fig.screenshot({ path: file });
      expect(pngWidth(file)).toBeGreaterThanOrEqual(1600);
    }
  });
});
