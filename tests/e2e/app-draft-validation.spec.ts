/**
 * #/draft に統合された検証結果表示のスモーク（Tier 2 + Tier 3 a11y）。
 *
 * 検証は生成完了後に自動実行され、結果は store.validationResult に保存される。
 * 本 spec では validationResult を preload した状態で draft view を開き、
 * 行ごとヒット数 / 捕捉率 / 未捕捉 PMID と「AI で原因を分析する」フローを検証する。
 * （生成 → 自動検証の貫通は LLM フルモック待ちの J1 ジャーニーで別途カバーする）
 */

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario, FULL_APP_STATE } from './fixtures/scenarios/fullState';
import type { AppState } from '../../src/app/store';

const APP_URL = '/app/app.html#/draft';

/** 未捕捉 PMID 444 を 1 件含む検証結果（現在の formula バージョンに紐づく）。 */
const VALIDATION_RESULT: NonNullable<AppState['validationResult']> = {
  formulaVersionId: 'fv-20260420-01',
  summary: {
    lineHits: [
      { blockId: '1', expression: '"ARDS"[tiab]', expandedQuery: '"ARDS"[tiab]', hitCount: 1200, error: null },
      { blockId: '2', expression: '"ECMO"[tiab]', expandedQuery: '"ECMO"[tiab]', hitCount: 800, error: null },
      { blockId: '3', expression: '#1 AND #2', expandedQuery: '("ARDS"[tiab]) AND ("ECMO"[tiab])', hitCount: 100, error: null },
    ],
    finalQuery: {
      finalQuery: '("ARDS"[tiab]) AND ("ECMO"[tiab])',
      totalHits: 100,
      captureRate: 0,
      capturedPmids: [],
      missedPmids: ['444'],
    },
    finalQueryError: null,
    mesh: [],
    meshFrequency: [{ descriptor: 'Acute Lung Injury', count: 1 }],
    meshError: null,
    meshHierarchy: [],
    meshMermaid: 'flowchart TD',
    meshHierarchyError: null,
    eligibleSeedCount: 1,
    totalSeedCount: 1,
    loggedValidationIds: ['vlog-1'],
  },
};

/**
 * 「AI で原因を分析する」用に efetch（444 の書誌）と Gemini（interpret-result）をモックする。
 */
async function routeMissedAnalysis(page: Page): Promise<void> {
  // LLM ロガーが LLMApiLog 追記 / payload アップロードで叩く Sheets / Drive を成功で返す
  await page.route('**/sheets.googleapis.com/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/www.googleapis.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'drive-file-1', webViewLink: 'https://drive/x' }),
    });
  });

  const efetchXml = [
    '<?xml version="1.0"?><PubmedArticleSet>',
    '<PubmedArticle><MedlineCitation><PMID>444</PMID>',
    '<Article><ArticleTitle>Acute lung injury support</ArticleTitle>',
    '<Abstract><AbstractText>A trial of ECMO in acute lung injury.</AbstractText></Abstract></Article>',
    '<MeshHeadingList><MeshHeading><DescriptorName>Acute Lung Injury</DescriptorName></MeshHeading></MeshHeadingList>',
    '</MedlineCitation></PubmedArticle></PubmedArticleSet>',
  ].join('');

  await page.route('**/eutils.ncbi.nlm.nih.gov/**', async (route) => {
    const url = route.request().url();
    if (url.includes('efetch.fcgi')) {
      await route.fulfill({ status: 200, contentType: 'text/xml', body: efetchXml });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.route('**/generativelanguage.googleapis.com/**', async (route) => {
    const skillJson = JSON.stringify({
      analyses: [
        {
          pmid: '444',
          cause: 'acute lung injury という表現が #1 に無いため取りこぼしています。',
          suggested_terms: ['"acute lung injury"[tiab]'],
          related_block: '1',
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
}

test.describe('app-draft 検証結果（#/draft）', () => {
  test('検証結果あり: 行ごとヒット数・捕捉率・未捕捉 PMID が表示される', async ({ page }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, validationResult: VALIDATION_RESULT },
      })
    );
    await page.goto(APP_URL);

    await expect(page.locator('.validate__line-hits')).toContainText('#1: 1200 件');
    await expect(page.locator('.validate__final')).toContainText('全体ヒット数: 100');
    await expect(page.locator('.validate__missed')).toContainText('444');
    await expect(page.locator('.validate__mesh')).toContainText('Acute Lung Injury');
  });

  test('未捕捉 PMID → AI 原因分析ボタン → LLM モック応答が表示される', async ({ page }) => {
    await routeMissedAnalysis(page);
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, validationResult: VALIDATION_RESULT },
        extraStorage: { 'apiKeys.gemini': 'dummy-key' },
      })
    );
    await page.goto(APP_URL);

    const analyzeBtn = page.locator('.validate__analyze-missed');
    await expect(analyzeBtn).toBeVisible();
    await analyzeBtn.click();

    const item = page.locator('.validate__analysis-item');
    await expect(item).toContainText('PMID 444');
    await expect(item).toContainText('推定ブロック: #1');
    await expect(item).toContainText('acute lung injury');
    await expect(page.locator('.validate__analysis-terms li')).toContainText('acute lung injury');
  });

  test('行の in-band 構文エラーは「0 件」ではなくエラー表示になる（fix-plan 1-1）', async ({ page }) => {
    const withLineError: NonNullable<AppState['validationResult']> = {
      formulaVersionId: VALIDATION_RESULT.formulaVersionId,
      summary: {
        ...VALIDATION_RESULT.summary,
        lineHits: [
          ...VALIDATION_RESULT.summary.lineHits.slice(0, 2),
          {
            blockId: '3',
            expression: 'xyzzy[tiabb]',
            expandedQuery: '',
            hitCount: 0,
            error: '構文エラー: 不明なフィールドタグ [tiabb]',
          },
        ],
      },
    };
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, validationResult: withLineError },
      })
    );
    await page.goto(APP_URL);

    const errorLine = page.locator('.validate__line-error');
    await expect(errorLine).toContainText('#3: エラー — 構文エラー');
    await expect(errorLine).toContainText('[tiabb]');
    // 「0 件」とは表示されない
    await expect(errorLine).not.toContainText('0 件');
  });

  test('a11y: axe violation zero（検証結果表示時）', async ({ page }) => {
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: { ...FULL_APP_STATE, validationResult: VALIDATION_RESULT },
      })
    );
    await page.goto(APP_URL);
    await expect(page.locator('.validate__results')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
