/**
 * J7: #/expand の「境界事例を取得」を**実操作で**通す回帰テスト。
 *
 * 既存の app-expand.spec.ts は preload した state を描画できるかを見る静的な確認に留まり、
 * ボタンを押して margin 探索（拡張式 NOT 現式 → esearch → efetch → AI 選定）が
 * 一周する経路は自動テストに無かった。PR #43 の store 追加（formulaSave /
 * formulaEditNote）が他フローを巻き込んでいないことを確かめるため、実際に押して
 * 候補が並ぶところまで確認する。
 *
 * 外部 API はすべて `tests/e2e/fixtures/apiStubs.ts` の共通スタブで止める
 * （LLM 2 回 / esearch 2 回 / efetch 1 回）。
 */

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario, FULL_APP_STATE } from './fixtures/scenarios/fullState';
import {
  registerSheetsStub,
  registerDriveStub,
  registerNcbiStub,
  registerGeminiStub,
} from './fixtures/apiStubs';

const APP_URL = '/app/app.html#/expand';

/** margin（拡張式の外側）で拾う 2 件。どちらもシード未登録の新規 PMID。 */
const MARGIN_PMIDS = ['30000001', '30000002'];

const EFETCH_XML = `<?xml version="1.0"?><PubmedArticleSet>
<PubmedArticle><MedlineCitation><PMID>30000001</PMID>
<Article><ArticleTitle>Venovenous ECLS for severe hypoxaemic respiratory failure</ArticleTitle>
<Journal><JournalIssue><Year>2024</Year></JournalIssue></Journal>
<Abstract><AbstractText>A cohort of adults receiving extracorporeal life support.</AbstractText></Abstract></Article>
<MeshHeadingList><MeshHeading><DescriptorName>Respiratory Insufficiency</DescriptorName></MeshHeading></MeshHeadingList>
</MedlineCitation></PubmedArticle>
<PubmedArticle><MedlineCitation><PMID>30000002</PMID>
<Article><ArticleTitle>Acute lung injury and extracorporeal support in adults</ArticleTitle>
<Journal><JournalIssue><Year>2023</Year></JournalIssue></Journal>
<Abstract><AbstractText>Registry analysis of acute lung injury.</AbstractText></Abstract></Article>
<MeshHeadingList><MeshHeading><DescriptorName>Acute Lung Injury</DescriptorName></MeshHeading></MeshHeadingList>
</MedlineCitation></PubmedArticle>
</PubmedArticleSet>`;

/** expand-query-for-recall skill の応答: ブロックごとの拡張語（更新提案の元） */
const EXPAND_ADDITIONS_RESPONSE = {
  blocks: [
    {
      id: '1',
      additions: [
        {
          term: '"Respiratory Insufficiency"[Mesh]',
          axis: 'mesh',
          rationale: 'MeSH を一段上へ広げる',
        },
      ],
    },
    {
      id: '2',
      additions: [{ term: '"ECLS"[tiab]', axis: 'freeword', rationale: '略語の表記ゆれを拾う' }],
    },
  ],
};

/** pick-boundary-cases skill の応答: margin の中から境界事例っぽい 2 件を選定 */
const PICK_BOUNDARY_CASES_RESPONSE = {
  picks: [
    { pmid: '30000001', reason: 'ECLS 表記のため現式では拾えていない境界事例。' },
    { pmid: '30000002', reason: 'acute lung injury 表記で ARDS 語に一致しない。' },
  ],
};

/**
 * margin モードへ分岐させるための有効 seed 1 件（margin の候補 PMID とは重複しない）。
 * fetchBoundaryCandidates は有効 seed が 0 件だと inside モードに落ちるため、margin 探索を
 * 検証するテストではこの行を SeedPapers に置いておく必要がある。
 *
 * 列は `src/domain/sheetsSchema.ts` の SHEET_HEADERS.SeedPapers の**固定順**に合わせること
 * （seedRepository.ts の fromRow はシート上の実際のヘッダテキストではなく、この固定順で
 * 列位置を決め打ちして読む。1 行目はヘッダとして読み飛ばされるだけで内容は見ない）。
 */
/** src/domain/sheetsSchema.ts の SHEET_HEADERS.SeedPapers と同じ固定順。1 行目は読み飛ばされるだけだが揃えておく */
const SEED_PAPERS_HEADER = [
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

const EXISTING_SEED_PMID = '10000000';
const EXISTING_SEED_ROW = [
  EXISTING_SEED_PMID, // pmid
  'Existing seed', // title
  '2020', // year
  'initial', // source
  'pmid_direct', // ingest_format
  '', // original_db
  'TRUE', // is_valid
  '', // exclusion_reason
  '', // original_payload_ref
  '', // user_decision（null 扱い = 対象。initial 行では未判定でも有効）
  '', // decided_at
  '', // decided_by
  '', // note
];

/**
 * expand が叩く外部 API 一式をモックする。
 * Gemini は 1 フロー中に 2 つの skill（expand-query-for-recall / pick-boundary-cases）を
 * 呼ぶので、apiStubs.ts の registerGeminiStub がプロンプト本文に載るスキーマ名で
 * 応答を出し分ける。
 */
async function setupExpandScenario(page: Page): Promise<void> {
  // 有効 seed を 1 件置いて margin モードへ（margin の候補 30000001/2 とは重複しない PMID）。
  // 他タブは apiStubs 既定に任せる。
  await registerSheetsStub(page, {
    tabs: {
      SeedPapers: [SEED_PAPERS_HEADER, EXISTING_SEED_ROW],
    },
  });

  await registerDriveStub(page);

  await registerNcbiStub(page, {
    efetchXml: EFETCH_XML,
    // margin クエリ（拡張式 NOT 現式）だけ idlist を返す。現式単体は件数のみ。
    esearch: (decodedUrl) =>
      decodedUrl.includes('NOT')
        ? { count: '12', idlist: MARGIN_PMIDS }
        : { count: '100', idlist: [] },
  });

  await registerGeminiStub(page, {
    responses: {
      'expand-query-for-recall': EXPAND_ADDITIONS_RESPONSE,
      'pick-boundary-cases': PICK_BOUNDARY_CASES_RESPONSE,
    },
    usage: { promptTokenCount: 500, candidatesTokenCount: 200 },
  });

  await injectAppStub(
    page,
    fullStateScenario({
      preloadedState: { ...FULL_APP_STATE },
      extraStorage: { 'apiKeys.gemini': 'dummy-key' },
    })
  );
}

test.describe('journey-expand-boundary (J7 回帰)', () => {
  test('「境界事例を取得」→ margin 探索が一周して候補と更新提案が並ぶ', async ({ page }) => {
    await setupExpandScenario(page);
    await page.goto(APP_URL);

    const fetchBtn = page.locator('.expand__actions button');
    await expect(fetchBtn).toHaveText('境界事例を取得');
    await fetchBtn.click();

    // AI 選定まで通ると候補が 2 件並ぶ
    const candidates = page.locator('.expand__candidate');
    await expect(candidates).toHaveCount(2, { timeout: 20_000 });
    await expect(candidates.first()).toContainText('30000001');
    await expect(page.locator('.expand__candidate-reason').first()).toContainText('ECLS');
    await expect(page.locator('.expand__error')).toHaveText('');

    // LLM を 2 回通っているのでコストも積み上がっている（= 全ビュー再描画も起きている）
    await expect(page.locator('#app-context')).not.toContainText('累積 $0.1200');
  });

  test('候補に include 判定を付けると SeedPapers へ登録される', async ({ page }) => {
    await setupExpandScenario(page);
    await page.goto(APP_URL);

    await page.locator('.expand__actions button').click();
    const firstCandidate = page.locator('.expand__candidate').first();
    await expect(firstCandidate).toBeVisible({ timeout: 20_000 });

    const includeBtn = firstCandidate.locator('.expand__candidate-actions button').first();
    await includeBtn.click();
    await expect(firstCandidate.locator('.expand__candidate-status')).not.toHaveText('', {
      timeout: 10_000,
    });
  });
});

// ---------------------------------------------------------------------------
// inside モード（有効 seed 0 件の初期シードブートストラップ。issue #53）
// ---------------------------------------------------------------------------

/** inside（現式の内側）で拾う候補 1 件。SeedPapers が空なので新規候補になる。 */
const INSIDE_PMID = '40000001';

const INSIDE_EFETCH_XML = `<?xml version="1.0"?><PubmedArticleSet>
<PubmedArticle><MedlineCitation><PMID>${INSIDE_PMID}</PMID>
<Article><ArticleTitle>ECMO for adult ARDS: a core RCT</ArticleTitle>
<Journal><JournalIssue><Year>2022</Year></JournalIssue></Journal>
<Abstract><AbstractText>A randomised trial squarely matching the RQ.</AbstractText></Abstract></Article>
<MeshHeadingList><MeshHeading><DescriptorName>Extracorporeal Membrane Oxygenation</DescriptorName></MeshHeading></MeshHeadingList>
</MedlineCitation></PubmedArticle>
</PubmedArticleSet>`;

/** pick-seed-candidates skill の応答: 内側の候補から代表例を選定 */
const PICK_SEED_CANDIDATES_RESPONSE = {
  picks: [{ pmid: INSIDE_PMID, reason: '組入基準に明確に合致する代表例。' }],
};

async function setupInsideExpandScenario(page: Page): Promise<void> {
  // SeedPapers はヘッダのみ（有効 seed 0 件）→ inside モードに入る。
  await registerSheetsStub(page, {
    tabs: { SeedPapers: [SEED_PAPERS_HEADER] },
  });

  await registerDriveStub(page);

  await registerNcbiStub(page, {
    efetchXml: INSIDE_EFETCH_XML,
    // inside モードは現式そのものを 1 回 esearch するだけ（margin の NOT クエリは投げない）。
    esearch: () => ({ count: '40', idlist: [INSIDE_PMID] }),
  });

  await registerGeminiStub(page, {
    responses: { 'pick-seed-candidates': PICK_SEED_CANDIDATES_RESPONSE },
    usage: { promptTokenCount: 400, candidatesTokenCount: 100 },
  });

  await injectAppStub(
    page,
    fullStateScenario({
      preloadedState: { ...FULL_APP_STATE },
      extraStorage: { 'apiKeys.gemini': 'dummy-key' },
    })
  );
}

test.describe('journey-expand-boundary inside モード（有効 seed 0 件のブートストラップ）', () => {
  test('「境界事例を取得」→ inside 探索が一周して初期シード候補が並ぶ', async ({ page }) => {
    await setupInsideExpandScenario(page);
    await page.goto(APP_URL);

    const fetchBtn = page.locator('.expand__actions button');
    await fetchBtn.click();

    const candidates = page.locator('.expand__candidate');
    await expect(candidates).toHaveCount(1, { timeout: 20_000 });
    await expect(candidates.first()).toContainText(INSIDE_PMID);
    await expect(page.locator('.expand__candidate-reason').first()).toContainText('組入基準');
    await expect(page.locator('.expand__error')).toHaveText('');

    // inside モードであることを示すバナーとステータスが出る（margin 特有の文言は出ない）
    await expect(page.locator('.expand__inside-banner')).toBeVisible();
    await expect(page.locator('.expand__status')).toContainText('初期シード候補');
  });

  test('a11y: inside モードの結果表示でも axe violation はゼロ', async ({ page }) => {
    await setupInsideExpandScenario(page);
    await page.goto(APP_URL);

    await page.locator('.expand__actions button').click();
    await expect(page.locator('.expand__candidate')).toHaveCount(1, { timeout: 20_000 });

    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  });
});
