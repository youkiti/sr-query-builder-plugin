/**
 * OAuth の案内と、API エラー後も画面が残り同じ操作で取得を再開できることを守る。
 * expand の候補取得を共通スタブで通し、対象 API だけ後勝ちの route で失敗させる。
 * 自動リトライも失敗させて利用者向けエラーを確認した後、fallback で成功スタブへ戻す。
 * docs/ui-deep-test-plan.md Phase E の表のうち API エラー 3 行（issue #109 で実装済み）を検査する:
 * 403 は Picker 許可とシートを開く導線、429 は待機中の残り回数、500 は再試行の導線。
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
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
      panel: '.expand__error-panel--permission',
      guidance: '同じ操作を繰り返しても結果は変わりません',
      /** 許可エラーは Picker 許可の成功後に自動で再取得する */
      recoverFromPanel: false,
    },
    {
      name: 'NCBI 429',
      url: '**/eutils.ncbi.nlm.nih.gov/**/esearch.fcgi*',
      status: 429,
      error: 'esearch failed: HTTP 429',
      attempts: 6,
      panel: '.expand__error-panel--rate_limit',
      guidance: '呼び出しが集中しています',
      recoverFromPanel: true,
    },
    {
      name: 'LLM 500',
      url: '**/generativelanguage.googleapis.com/**',
      status: 500,
      error: 'Gemini API failed: HTTP 500',
      attempts: 3,
      panel: '.expand__error-panel--temporary',
      guidance: '一時的な障害の可能性があります',
      recoverFromPanel: true,
    },
  ];

  for (const scenario of cases) {
    test(`${scenario.name}: 分類に応じた案内を出し、復帰して候補を表示できる`, async ({ page }) => {
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

      if (scenario.name === 'NCBI 429') {
        // issue #109: 31 秒のバックオフを黙って待たない。待機中であることと残り回数を出す。
        const wait = page.locator('.expand__api-wait');
        await expect(wait).toContainText('自動で再試行します', { timeout: 20_000 });
        await expect(wait).toContainText('/ 6 回目');
        await expect(wait).toHaveAttribute('role', 'status');
      }

      const error = page.locator('.expand__error');
      await expect(error).toContainText(scenario.error, { timeout: 45_000 });
      await expect(error).toHaveAttribute('aria-live', 'polite');
      const panel = page.locator(scenario.panel);
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(scenario.guidance);
      await expect(panel).toHaveAttribute('role', 'alert');
      // 分類つき案内は issue #109 で足した新しい UI 状態なので、状態ごとに 1 本の慣習で axe を回す
      const a11y = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
      expect(a11y.violations).toEqual([]);
      expect(failedRequests).toBe(scenario.attempts);
      await expect(fetchButton).toBeEnabled();
      await expect(page.locator('#app-content h2')).toBeVisible();
      await expect(page.locator('.expand__candidate')).toHaveCount(0);

      const retry = panel.getByRole('button');
      if (scenario.recoverFromPanel) {
        await expect(retry).toHaveText('もう一度取得する');
      } else {
        // 拡張で利用中のアカウントを指定して Google 側の画面を開く
        const open = panel.locator('.expand__error-action--open');
        await expect(open).toHaveText('スプレッドシートを開く');
        await open.click();
        await expect.poll(() => page.evaluate(
          () => (window as unknown as { __appStubTabs: unknown[] }).__appStubTabs.length
        )).toBe(1);
        const opened = await page.evaluate(
          () => (window as unknown as { __appStubTabs: { url?: string }[] }).__appStubTabs
        );
        expect(opened).toEqual([
          { url: 'https://docs.google.com/spreadsheets/d/sheet-fixture-1/edit?authuser=tester%40example.com' },
        ]);
        await expect(page.locator('.expand__candidate')).toHaveCount(0);
      }

      failing = false;
      if (scenario.recoverFromPanel) {
        await retry.click();
      } else {
        await page.evaluate(() => {
          (window as unknown as { __appStubSendMessageResponse: unknown }).__appStubSendMessageResponse =
            { status: 'granted' };
        });
        await panel.locator('.expand__error-action--grant').click();
        const messages = await page.evaluate(
          () => (window as unknown as { __appStubMessages: { message: unknown }[] }).__appStubMessages
        );
        expect(messages.map((entry) => entry.message)).toContainEqual({
          type: 'sr-query-builder/picker-grant', spreadsheetId: 'sheet-fixture-1', openAppOnSuccess: false,
        });
      }
      await expect(page.locator('.expand__candidate')).toHaveCount(5, { timeout: 20_000 });
      await expect(page.locator('.expand__candidate').first()).toContainText(CANDIDATE_PMIDS[0]!);
      expect(recoveredRequests).toBeGreaterThan(0);
      await expect(error).toHaveText('');
      await expect(page.locator('.expand__error-panel')).toHaveCount(0);
      await expect(fetchButton).toBeEnabled();
    });
  }
});
