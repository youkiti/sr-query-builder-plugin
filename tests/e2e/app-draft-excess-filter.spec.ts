/**
 * #/draft の「検証のみ再実行」（fix-plan 2-2）と過大ヒット → フィルタ承認フロー
 * （fix-plan 2-1）の E2E。
 *
 * - 2-2: 検証フェーズ失敗後（draftRun=error/validating を preload）、「検証のみ再実行」
 *   ボタンで LLM を一切呼ばずに検証が回ることを確認する
 * - 2-1: 総ヒット数 10,001 件 stub → 候補提示 → 承認で式更新、見送りで式不変を確認する
 *
 * NCBI / Gemini / Sheets / Drive はすべて page.route でモックする。
 */

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario, FULL_APP_STATE } from './fixtures/scenarios/fullState';
import type { AppState } from '../../src/app/store';

const APP_URL = '/app/app.html#/draft';

/** 検証フェーズ失敗直後の draftRun（「検証のみ再実行」ボタンの表示条件） */
function validatingErrorRun(): NonNullable<AppState['draftRun']> {
  return {
    status: 'error',
    phase: 'validating',
    progressLabel: '',
    startedAtMs: Date.now(),
    error: 'NCBI 一時障害',
    blockHits: [],
  };
}

/**
 * 検証パイプラインが叩く外部 API をモックする。
 * - esearch は常に esearchCount 件を返す
 * - Gemini（design_filter）はフィルタ候補 1 件を返し、呼び出し回数を数える
 * 戻り値の配列に Gemini 呼び出し URL が録音される。
 */
async function routeValidationApis(page: Page, esearchCount: number): Promise<string[]> {
  const geminiCalls: string[] = [];

  await page.route('**/eutils.ncbi.nlm.nih.gov/**', async (route) => {
    const url = route.request().url();
    if (url.includes('efetch.fcgi')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/xml',
        body: '<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>',
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ esearchresult: { count: String(esearchCount), idlist: [] } }),
    });
  });

  // 検証内訳の Drive 退避（uploadValidationDetail）と LLM ログの payload 退避
  await page.route('**/www.googleapis.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'drive-file-1', webViewLink: 'https://drive/x' }),
    });
  });

  await page.route('**/generativelanguage.googleapis.com/**', async (route) => {
    geminiCalls.push(route.request().url());
    const skillJson = JSON.stringify({
      candidates: [
        {
          label: '英語論文に限定',
          expression: 'english[la]',
          rationale: '非英語の対象論文を取りこぼすリスクがあります。',
        },
      ],
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        candidates: [{ content: { parts: [{ text: skillJson }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    });
  });

  return geminiCalls;
}

test.describe('検証のみ再実行（fix-plan 2-2）', () => {
  test('検証フェーズ失敗後、再実行ボタンで LLM を呼ばずに検証が回る', async ({ page }) => {
    const geminiCalls = await routeValidationApis(page, 100);
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, draftRun: validatingErrorRun() },
      })
    );
    await page.goto(APP_URL);

    await expect(page.locator('.draft__error')).toContainText('検証に失敗しました');
    const revalidateBtn = page.locator('.draft__revalidate');
    await expect(revalidateBtn).toBeVisible();
    await revalidateBtn.click();

    // 検証結果（行ごとヒット数）が表示される = 検証が完走した
    await expect(page.locator('.validate__line-hits')).toBeVisible();
    await expect(page.locator('.validate__line-hits')).toContainText('#1: 100 件');
    // LLM（Gemini）は一度も呼ばれていない
    expect(geminiCalls).toHaveLength(0);
  });
});

test.describe('過大ヒット → フィルタ承認フロー（fix-plan 2-1）', () => {
  test('総ヒット 10,001 件で候補が提示され、承認すると式が更新・再検証される', async ({ page }) => {
    await routeValidationApis(page, 10001);
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, draftRun: validatingErrorRun() },
        extraStorage: { 'apiKeys.gemini': 'dummy-key' },
      })
    );
    await page.goto(APP_URL);

    await page.locator('.draft__revalidate').click();

    // 候補承認 UI が表示される（式はまだ変更されない）
    const excess = page.locator('.draft__excess');
    await expect(excess).toBeVisible();
    await expect(excess.locator('h3')).toContainText('10,001 件');
    await expect(excess).toContainText('英語論文に限定');
    await expect(excess).toContainText('english[la]');
    await expect(page.locator('.draft__formula')).not.toContainText('#Filter1');

    // 承認ボタンはチェックするまで無効
    const applyBtn = excess.locator('.draft__excess-apply');
    await expect(applyBtn).toBeDisabled();
    await excess.locator('.draft__excess-check').check();
    await expect(applyBtn).toBeEnabled();
    await applyBtn.click();

    // 式にフィルタブロックが追記され、結合行にも AND 参照が付く
    await expect(page.locator('.draft__formula')).toContainText('#Filter1');
    await expect(page.locator('.draft__formula')).toContainText('english[la]');
    await expect(page.locator('.draft__formula')).toContainText('AND #Filter1');
  });

  test('「見送る」では式は変更されず候補だけ消える', async ({ page }) => {
    const proposal: NonNullable<AppState['excessFilterProposal']> = {
      formulaVersionId: FULL_APP_STATE.currentFormulaVersionId as string,
      totalHits: 10001,
      candidates: [
        {
          label: '英語論文に限定',
          expression: 'english[la]',
          rationale: '非英語の対象論文を取りこぼすリスクがあります。',
        },
      ],
      error: null,
    };
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, excessFilterProposal: proposal },
      })
    );
    await page.goto(APP_URL);

    await expect(page.locator('.draft__excess')).toBeVisible();
    await page.locator('.draft__excess-dismiss').click();

    await expect(page.locator('.draft__excess')).toHaveCount(0);
    // 式は元のまま（フィルタは追加されていない）
    await expect(page.locator('.draft__formula')).not.toContainText('#Filter1');
    await expect(page.locator('.draft__formula')).toContainText('"ARDS"[tiab]');
  });

  test('a11y: axe violation zero（候補承認 UI 表示時）', async ({ page }) => {
    const proposal: NonNullable<AppState['excessFilterProposal']> = {
      formulaVersionId: FULL_APP_STATE.currentFormulaVersionId as string,
      totalHits: 10001,
      candidates: [
        {
          label: '英語論文に限定',
          expression: 'english[la]',
          rationale: '非英語の対象論文を取りこぼすリスクがあります。',
        },
      ],
      error: null,
    };
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, excessFilterProposal: proposal },
      })
    );
    await page.goto(APP_URL);
    await expect(page.locator('.draft__excess')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
