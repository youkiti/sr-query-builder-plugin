/**
 * 候補が並んだ expand 画面で、キーボードの移動・連続判定・保存後の自動前進を守る。
 * 現式の inside 探索で 5 件を取得し、外部 API は共通スタブで固定する。
 * SeedPapers の values:append だけ後から録音用ハンドラで上書きし、送信した行を検査する。
 * 保存完了の表示を待って次のキーを送り、通信中の同じカードへ判定を重ねない。
 */

import { test, expect } from '@playwright/test';
import { SHEET_HEADERS } from '../../src/domain/sheetsSchema';
import { setupExpandCandidates, CANDIDATE_PMIDS } from './fixtures/scenarios/expandCandidates';

test('候補を n/p で移動し、i/i/i/e/m を順に保存できる', async ({ page }) => {
  await setupExpandCandidates(page);
  const appended: Array<Array<string | number | boolean>> = [];
  // 実 URL は /values/<range>:append。LLMApiLog 等の append は共通スタブへ戻す。
  await page.route('**/sheets.googleapis.com/**/values/*:append*', async (route) => {
    if (!decodeURIComponent(route.request().url()).includes('/values/SeedPapers!')) {
      await route.fallback();
      return;
    }
    expect(route.request().method()).toBe('POST');
    const body = route.request().postDataJSON() as { values: Array<Array<string | number | boolean>> };
    appended.push(...body.values);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/app/app.html#/expand');
  await page.getByRole('button', { name: '境界事例を取得', exact: true }).click();

  const cards = page.locator('.expand__candidate');
  const list = page.locator('.expand__candidates');
  const active = page.locator('.expand__candidate--focused');
  await expect(cards).toHaveCount(5, { timeout: 20_000 });
  await list.focus();
  await expect(list).toBeFocused();
  await expect(active).toContainText(CANDIDATE_PMIDS[0]!);

  await page.keyboard.press('n');
  await expect(active).toContainText(CANDIDATE_PMIDS[1]!);
  await page.keyboard.press('p');
  await expect(active).toContainText(CANDIDATE_PMIDS[0]!);
  expect(appended).toHaveLength(0);

  const decisions = [
    ['i', 'include'], ['i', 'include'], ['i', 'include'], ['e', 'exclude'], ['m', 'maybe'],
  ] as const;
  for (const [index, [key, decision]] of decisions.entries()) {
    await expect(active).toContainText(CANDIDATE_PMIDS[index]!);
    await expect(list).toBeFocused();
    await page.keyboard.press(key);
    await expect(cards.nth(index).locator('.expand__candidate-status'))
      .toHaveText(`${decision} として保存しました`);
    await expect(cards.nth(index)).toHaveClass(/expand__candidate--decided/);
    expect(appended).toHaveLength(index + 1);
  }

  const header = SHEET_HEADERS.SeedPapers;
  expect(appended.map((row) => ({
    pmid: row[header.indexOf('pmid')],
    source: row[header.indexOf('source')],
    decision: row[header.indexOf('user_decision')],
  }))).toEqual(CANDIDATE_PMIDS.map((pmid, index) => ({
    pmid,
    source: 'interactive',
    decision: decisions[index]![1],
  })));
  await expect(page.locator('.expand__error')).toHaveText('');
});

for (const [decision, key] of [['include', 'i'], ['exclude', 'e'], ['maybe', 'm']] as const) {
  test(`長い候補の下側で ${decision} をクリックし、本文クリック後もキーで判定できる`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await setupExpandCandidates(page, 'Adults with ARDS received ECMO in a randomised trial.\n'.repeat(60));
    await page.goto('/app/app.html#/expand');
    await page.getByRole('button', { name: '境界事例を取得', exact: true }).click();
    const cards = page.locator('.expand__candidate');
    await expect(cards).toHaveCount(5, { timeout: 20_000 });
    expect(await page.locator('.expand__candidates').evaluate((el) => el.getBoundingClientRect().height))
      .toBeGreaterThan(720);

    // 下のカードを開き、長い抄録の末尾にある判定ボタンまでスクロールする。
    await page.keyboard.press('n');
    const button = cards.nth(1).getByRole('button', { name: decision, exact: true });
    await button.scrollIntoViewIfNeeded();
    const beforeClick = await page.evaluate(() => window.scrollY);
    expect(beforeClick).toBeGreaterThan(720);
    // フォーカス時点も記録し、保存後のスクロールだけでは隠れる一瞬の飛びを検出する。
    await page.locator('.expand__candidates').evaluate((list) => {
      list.addEventListener('focus', () => {
        list.setAttribute('data-scroll-at-focus', String(window.scrollY));
      }, { once: true });
    });
    await button.click();
    const focusScroll = Number(await page.locator('.expand__candidates').getAttribute('data-scroll-at-focus'));
    expect(Math.abs(focusScroll - beforeClick)).toBeLessThan(2);
    await expect(cards.nth(1).locator('.expand__candidate-status')).toHaveText(`${decision} として保存しました`);

    const expectReadingPosition = async (index: number): Promise<void> => {
      const card = cards.nth(index);
      await expect(card).toHaveClass(/expand__candidate--focused/);
      await expect.poll(() => card.evaluate((el) => {
        const head = el.querySelector('.expand__candidate-head')!.getBoundingClientRect();
        const body = el.querySelector('.expand__candidate-abstract-body')!.getBoundingClientRect();
        const top = el.getBoundingClientRect().top;
        const margin = parseFloat(getComputedStyle(el).scrollMarginTop);
        return Math.abs(top - margin) < 2 && head.top >= 0 && head.bottom < innerHeight &&
          body.top >= 0 && body.top + 24 < innerHeight;
      })).toBe(true);
    };
    await expectReadingPosition(2);
    await cards.nth(2).locator('.expand__candidate-abstract-body').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press(key);
    await expect(cards.nth(2).locator('.expand__candidate-status')).toHaveText(`${decision} として保存しました`);
    await expectReadingPosition(3);
  });
}

test('余白へフォーカスが外れても移動でき、入力欄の操作とルート離脱後は判定しない', async ({ page }) => {
  await setupExpandCandidates(page);
  await page.goto('/app/app.html#/expand');
  await page.getByRole('button', { name: '境界事例を取得', exact: true }).click();
  const cards = page.locator('.expand__candidate');
  await expect(cards).toHaveCount(5, { timeout: 20_000 });
  await page.getByRole('heading', { name: '対話的シード拡張', exact: true }).click();
  await expect(page.locator('.expand__candidates')).not.toBeFocused();
  for (const [key, index] of [['n', 1], ['p', 0], ['ArrowDown', 1], ['ArrowUp', 0]] as const) {
    await page.keyboard.press(key);
    await expect(cards.nth(index)).toHaveClass(/expand__candidate--focused/);
  }
  await page.locator('.expand__inside-specific').focus();
  for (const key of ['i', 'e', 'm', 'n', 'p', 'ArrowDown', 'ArrowUp']) await page.keyboard.press(key);
  await expect(cards.nth(0)).toHaveClass(/expand__candidate--focused/);
  await expect(page.locator('.expand__candidate--decided')).toHaveCount(0);

  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && decodeURIComponent(request.url()).includes('/values/SeedPapers!')) {
      writes.push(request.url());
    }
  });
  await page.evaluate(() => { window.location.hash = '#/settings'; });
  await expect(cards).toHaveCount(0);
  await page.keyboard.press('i');
  // 次の描画まで待ち、離脱前の候補が反応して保存リクエストを出さないことを確認する。
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(writes).toEqual([]);
});
