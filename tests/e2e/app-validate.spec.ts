/**
 * #/validate 画面スモーク（Tier 2 + Tier 3 a11y）。
 * docs/ui-deep-test-plan.md Phase B。
 */

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario, FULL_APP_STATE } from './fixtures/scenarios/fullState';

const APP_URL = '/app/app.html#/validate';

/**
 * 検証フル実行（line_hits + final_query + mesh）で未捕捉 PMID が 1 件出るように
 * NCBI / Sheets / Drive / LLM の fetch をすべてモックする。
 * - SeedPapers には PMID 444 を 1 件登録 → final_query で必ず未捕捉になるよう captured esearch は空
 * - efetch（mesh 用 / 漏れ分析用）は 444 の書誌を返す
 * - generativelanguage（Gemini）は interpret-result の JSON を返す
 */
async function routeFullValidation(page: Page): Promise<void> {
  const seedHeader = [
    'pmid',
    'title',
    'year',
    'source',
    'ingest_format',
    'original_db',
    'is_valid',
    'exclusion_reason',
    'original_payload_ref',
    'user_decision',
    'decided_at',
    'decided_by',
    'note',
  ];
  const seedRow = ['444', 'Missed seed', '2020', 'initial', 'pmid_direct', '', 'true', '', '', '', '', '', ''];

  const efetchXml = [
    '<?xml version="1.0"?><PubmedArticleSet>',
    '<PubmedArticle><MedlineCitation><PMID>444</PMID>',
    '<Article><ArticleTitle>Acute lung injury support</ArticleTitle>',
    '<Abstract><AbstractText>A trial of ECMO in acute lung injury.</AbstractText></Abstract></Article>',
    '<MeshHeadingList><MeshHeading><DescriptorName>Acute Lung Injury</DescriptorName></MeshHeading></MeshHeadingList>',
    '</MedlineCitation></PubmedArticle></PubmedArticleSet>',
  ].join('');

  // Sheets: SeedPapers の読み出しだけ seed 行を返し、それ以外（append 等）は空 200
  await page.route('**/sheets.googleapis.com/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/values/SeedPapers')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ values: [seedHeader, seedRow] }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // Drive: アップロード / メタデータは適当な成功レスポンス
  await page.route('**/www.googleapis.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'drive-file-1', webViewLink: 'https://drive/x' }),
    });
  });

  // NCBI E-utilities
  await page.route('**/eutils.ncbi.nlm.nih.gov/**', async (route) => {
    const url = route.request().url();
    if (url.includes('efetch.fcgi')) {
      await route.fulfill({ status: 200, contentType: 'text/xml', body: efetchXml });
      return;
    }
    if (url.includes('esearch.fcgi')) {
      // captured クエリ（seed の [uid] を含む）は空 idlist を返し、444 を未捕捉にする
      if (url.includes('uid')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ esearchresult: { count: '0', idlist: [] } }),
        });
        return;
      }
      // mesh tree 解決の db=mesh esearch
      if (url.includes('db=mesh')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ esearchresult: { idlist: [] } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ esearchresult: { count: '100', idlist: [] } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // Gemini: interpret-result の JSON
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

test.describe('app-validate (#/validate)', () => {
  test('formula 無し: guard プレースホルダ', async ({ page }) => {
    await injectAppStub(page, fullStateScenario({
      preloadedState: {
        ...(await import('./fixtures/scenarios/fullState')).FULL_APP_STATE,
        currentFormulaVersionId: null,
      },
    }));
    await page.goto(APP_URL);

    await expect(page.locator('#app-content .view__placeholder')).toBeVisible();
  });

  test('formula 有り: 検証ボタン・status / error 領域が並ぶ', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);

    const btn = page.locator('.validate__actions button');
    await expect(btn).toHaveText(/検証/);
    await expect(page.locator('.validate__status')).toHaveCount(1);
    await expect(page.locator('.validate__error')).toHaveCount(1);
    // 初期は results は空
    await expect(page.locator('.validate__results')).toBeEmpty();
  });

  test('未捕捉 PMID 検証 → AI 原因分析ボタン → LLM モック応答が表示される', async ({ page }) => {
    await routeFullValidation(page);
    await injectAppStub(
      page,
      fullStateScenario({
        preloadedState: FULL_APP_STATE,
        extraStorage: { 'apiKeys.gemini': 'dummy-key' },
      })
    );
    await page.goto(APP_URL);

    // 検証を実行
    await page.locator('.validate__actions button').click();

    // 未捕捉 PMID 444 と分析ボタンが出る
    await expect(page.locator('.validate__missed')).toContainText('444');
    const analyzeBtn = page.locator('.validate__analyze-missed');
    await expect(analyzeBtn).toBeVisible();

    // AI 原因分析を実行 → LLM モック応答が表示される
    await analyzeBtn.click();
    const item = page.locator('.validate__analysis-item');
    await expect(item).toContainText('PMID 444');
    await expect(item).toContainText('推定ブロック: #1');
    await expect(item).toContainText('acute lung injury');
    await expect(page.locator('.validate__analysis-terms li')).toContainText(
      'acute lung injury'
    );
  });

  test('a11y: axe violation zero', async ({ page }) => {
    await injectAppStub(page, fullStateScenario());
    await page.goto(APP_URL);
    await expect(page.locator('.validate__actions button')).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
