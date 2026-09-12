/**
 * OAuth の案内と、API エラー後も画面が残り同じ操作で取得を再開できることを守る。
 * expand の候補取得を共通スタブで通し、対象 API だけ後勝ちの route で失敗させる。
 * 自動リトライも失敗させて利用者向けエラーを確認した後、fallback で成功スタブへ戻す。
 * docs/ui-deep-test-plan.md Phase E の target 表ではなく、現実装のエラー表示を検査する。
 */

import { test, expect } from '@playwright/test';
import { injectChromeStub } from './fixtures/chromeStub';
import { setupExpandCandidates, CANDIDATE_PMIDS } from './fixtures/scenarios/expandCandidates';

test.describe('journey-errors (J5, popup レイヤ)', () => {
  test('OAuth 失効: authed=false で popup 起動 → login ボタンが見える', async ({ page }) => {
    await injectChromeStub(page, { authed: false, email: '', recent: [] });
    await page.goto('/popup/popup.html');

    await expect(page.locator('#login-button')).toBeVisible();
    await expect(page.locator('#popup-status')).toContainText(/ログインが必要/);
    // 未認証でも projects セクションはクラッシュせず隠れる
    await expect(page.locator('#popup-projects')).toBeHidden();
  });

  test('再認証後の切替: authed=true で reload → projects が出る', async ({ page }) => {
    await injectChromeStub(page, { authed: true, email: 'me@x', recent: [] });
    await page.goto('/popup/popup.html');

    await expect(page.locator('#popup-projects')).toBeVisible();
    await expect(page.locator('#login-button')).toBeHidden();
  });
});

test.describe('journey-errors (app の API エラー復帰)', () => {
  const cases = [
    {
      name: 'Sheets 403',
      url: '**/sheets.googleapis.com/**/values/SeedPapers*',
      status: 403,
      error: 'Google API failed: HTTP 403',
      attempts: 1,
    },
    {
      name: 'NCBI 429',
      url: '**/eutils.ncbi.nlm.nih.gov/**/esearch.fcgi*',
      status: 429,
      error: 'esearch failed: HTTP 429',
      attempts: 6,
    },
    {
      name: 'LLM 500',
      url: '**/generativelanguage.googleapis.com/**',
      status: 500,
      error: 'Gemini API failed: HTTP 500',
      attempts: 3,
    },
  ];

  for (const scenario of cases) {
    test(`${scenario.name}: エラー表示後に再取得して候補を表示できる`, async ({ page }) => {
      // NCBI の既定バックオフ（1 + 2 + 4 + 8 + 16 秒）も実際に待つ。
      test.setTimeout(70_000);
      await setupExpandCandidates(page);
      let failing = true;
      let failedRequests = 0;
      let recoveredRequests = 0;
      await page.route(scenario.url, async (route) => {
        if (failing) {
          failedRequests += 1;
          await route.fulfill({
            status: scenario.status,
            contentType: 'application/json',
            body: JSON.stringify({ error: { message: `${scenario.name}（stub）` } }),
          });
        } else {
          recoveredRequests += 1;
          await route.fallback();
        }
      });
      await page.goto('/app/app.html#/expand');
      const fetchButton = page.getByRole('button', { name: '境界事例を取得', exact: true });
      await fetchButton.click();

      const error = page.locator('.expand__error');
      await expect(error).toContainText(scenario.error, { timeout: 45_000 });
      await expect(error).toBeVisible();
      await expect(error).toHaveAttribute('aria-live', 'polite');
      expect(failedRequests).toBe(scenario.attempts);
      await expect(fetchButton).toBeEnabled();
      await expect(page.locator('#app-content h2')).toBeVisible();
      await expect(page.locator('.expand__candidate')).toHaveCount(0);

      failing = false;
      await fetchButton.click();
      await expect(page.locator('.expand__candidate')).toHaveCount(5, { timeout: 20_000 });
      await expect(page.locator('.expand__candidate').first()).toContainText(CANDIDATE_PMIDS[0]!);
      expect(recoveredRequests).toBeGreaterThan(0);
      await expect(error).toHaveText('');
      await expect(fetchButton).toBeEnabled();
    });
  }
});
