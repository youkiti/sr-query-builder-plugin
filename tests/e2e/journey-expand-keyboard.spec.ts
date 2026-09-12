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
