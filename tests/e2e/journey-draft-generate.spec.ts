/**
 * J8: #/draft の「生成して検証する」を**実操作で**通す回帰テスト。
 *
 * 既存の app-draft.spec.ts / app-draft-validation.spec.ts は preload した state を
 * 描画できるかを見る静的な確認で、ボタンを押して
 * 「ブロック設計 → MeSH → フリーワード → 行ごとヒット数 → 保存 → 捕捉率検証」が
 * 一周する経路（docs/ui-deep-test-plan.md の J1）は自動テストに無かった。
 * PR #43 の store 追加（formulaSave / formulaEditNote）が他フローを巻き込んでいないことを
 * 確かめるため、実際に押して検証結果が出るところまで確認する。
 *
 * 外部 API はすべて `tests/e2e/fixtures/apiStubs.ts` の共通スタブで止める。1 フロー中に
 * LLM をブロック数 × 3 skill（block-designer / mesh-suggester / freeword-designer）呼ぶので、
 * プロンプトに載るスキーマ名で応答を出し分ける（apiStubs.ts 側の責務）。
 */

import { test, expect, type Page } from '@playwright/test';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario, FULL_APP_STATE } from './fixtures/scenarios/fullState';
import {
  registerSheetsStub,
  registerDriveStub,
  registerNcbiStub,
  registerGeminiStub,
} from './fixtures/apiStubs';

const APP_URL = '/app/app.html#/draft';

/** シード 1 件（捕捉率の分母になる）。SeedPapers タブの列順は SHEET_HEADERS 準拠。 */
const SEED_PMID = '20000001';

const EFETCH_XML = `<?xml version="1.0"?><PubmedArticleSet>
<PubmedArticle><MedlineCitation><PMID>${SEED_PMID}</PMID>
<Article><ArticleTitle>ECMO for ARDS in adults</ArticleTitle>
<Journal><JournalIssue><Year>2024</Year></JournalIssue></Journal>
<Abstract><AbstractText>Randomised trial of ECMO in adult ARDS.</AbstractText></Abstract></Article>
<MeshHeadingList><MeshHeading><DescriptorName>Respiratory Distress Syndrome</DescriptorName></MeshHeading></MeshHeadingList>
</MedlineCitation></PubmedArticle>
</PubmedArticleSet>`;

const BLOCK_DESIGNER_RESPONSE = {
  concept_summary: 'ARDS / ECMO の概念ブロック',
  mesh_requirements: ['Respiratory Distress Syndrome'],
  freeword_requirements: ['ARDS'],
  rationale: '主要概念を MeSH とフリーワードの両輪で拾う',
};

const MESH_SUGGESTER_RESPONSE = {
  suggestions: [
    {
      descriptor: 'Respiratory Distress Syndrome',
      tag_syntax: '"Respiratory Distress Syndrome"[Mesh]',
      rationale: '主要 MeSH',
    },
  ],
};

const FREEWORD_DESIGNER_RESPONSE = {
  freewords: [{ query: '"ARDS"[tiab]', rationale: '略語での表記' }],
};

async function setupDraftScenario(page: Page): Promise<void> {
  // SeedPapers は include 判定済みのシードを 1 件返す（捕捉率検証の対象になる）。
  // 他タブは apiStubs 既定の { values: [] } に任せる。
  await registerSheetsStub(page, {
    tabs: {
      SeedPapers: [
        ['seed_id', 'pmid', 'title', 'source', 'is_valid', 'user_decision'],
        ['seed-1', SEED_PMID, 'ECMO for ARDS in adults', 'initial', 'TRUE', 'include'],
      ],
    },
  });

  await registerDriveStub(page);

  await registerNcbiStub(page, {
    efetchXml: EFETCH_XML,
    // シード PMID を含む問い合わせは捕捉扱いにする（捕捉率 100%）
    esearch: (decodedUrl) =>
      decodedUrl.includes(SEED_PMID)
        ? { count: '1', idlist: [SEED_PMID] }
        : { count: '250', idlist: [] },
  });

  await registerGeminiStub(page, {
    responses: {
      'block-designer': BLOCK_DESIGNER_RESPONSE,
      'mesh-suggester': MESH_SUGGESTER_RESPONSE,
      'freeword-designer': FREEWORD_DESIGNER_RESPONSE,
    },
  });

  await injectAppStub(
    page,
    fullStateScenario({
      preloadedState: { ...FULL_APP_STATE, currentFormulaMarkdown: null },
      extraStorage: { 'apiKeys.gemini': 'dummy-key' },
    })
  );
}

test.describe('journey-draft-generate (J8 回帰)', () => {
  test('「生成する」→ 検索式が組み上がり、行ごとヒット数と捕捉率まで出る', async ({ page }) => {
    await setupDraftScenario(page);
    await page.goto(APP_URL);

    const generateBtn = page.locator('.draft__actions button').first();
    await expect(generateBtn).toBeEnabled();
    await generateBtn.click();

    // 生成完了: 検索式が描画される
    await expect(page.locator('.draft__formula')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.draft__formula')).toContainText('Respiratory Distress Syndrome');
    await expect(page.locator('.draft__error')).toHaveText('');

    // 続けて自動実行される検証の結果（行ごとヒット数 / 全体ヒット数）まで出る
    await expect(page.locator('.validate__line-hits')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.validate__final')).toContainText('全体ヒット数');

    // 生成物は FormulaVersions に保存され、context の Formula が付く
    await expect(page.locator('#app-context')).toContainText('Formula');
  });
});
