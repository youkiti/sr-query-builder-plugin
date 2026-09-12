/**
 * 自動調整の設定からライブ履歴・最終レビュー・一度だけの採用保存までを守る。
 * 件数は呼出し順ではなく式の内容で返し、語別計測や再検証が増えても同じ式の実測値を保つ。
 * Sheets は状態を持たせて作成種別・親版・検証ログを検査し、Drive / Gemini / NCBI /
 * MeSH RDF を全て開始前に stub する。進捗の axe は AI 応答を明示的に保留して測るため、
 * 実行速度に依存せず「実行中」の UI を検査できる。
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { SHEET_HEADERS } from '../../src/domain/sheetsSchema';
import { injectAppStub } from './fixtures/appStub';
import { fullStateScenario, FULL_APP_STATE } from './fixtures/scenarios/fullState';
import { registerSheetsStub, registerDriveStub, registerNcbiStub, registerGeminiStub, registerMeshRdfStub } from './fixtures/apiStubs';

const APP_URL = '/app/app.html#/draft';
const PMID = '20000001';
const INITIAL_MD = '## PubMed/MEDLINE\n\n```\n#1 "ARDS"[tiab] OR "broad"[tiab]\n#2 "ECMO"[tiab]\n#3 #1 AND #2\n```\n';

async function setup(page: Page, options: { hasSeeds: boolean; holdAi: boolean; heldLost?: number } = { hasSeeds: true, holdAi: false }) {
  const seed: Record<string, string> = { seed_id: 'seed-1', pmid: PMID, title: 'ARDS と ECMO',
    source: 'initial', is_valid: 'TRUE', user_decision: 'include' };
  const fake = await registerSheetsStub(page, { appendDelayMs: 300, tabs: {
    FormulaVersions: [[...SHEET_HEADERS.FormulaVersions],
      ['fv-20260420-01', '', '1', 'snapshot', INITIAL_MD, 'ai_draft', '2026-09-11T00:00:00Z', '', 'gemini-3.5-flash']],
    ValidationLog: [[...SHEET_HEADERS.ValidationLog]],
    SeedPapers: [[...SHEET_HEADERS.SeedPapers], ...(options.hasSeeds ? [SHEET_HEADERS.SeedPapers.map((key) => seed[key] ?? '')] : [])],
  } });
  await registerDriveStub(page);
  await registerMeshRdfStub(page);
  await registerNcbiStub(page, { esearch: (url) => {
    const query = new URL(url).searchParams.get('term')!;
    if (query.includes(') NOT (')) {
      const lost = options.heldLost !== undefined && query.split(') NOT (')[0]!.includes('broad');
      return { count: String(lost ? options.heldLost : 0), idlist: lost ? ['30000001'] : [] };
    }
    return url.includes(PMID) ? { count: '1', idlist: [PMID] }
      : { count: url.includes('broad') ? '250' : '50', idlist: [] };
  }, efetchXml: '<PubmedArticleSet><PubmedArticle><PMID>30000001</PMID><ArticleTitle>確認対象の研究</ArticleTitle><PubDate><Year>2024</Year></PubDate></PubmedArticle></PubmedArticleSet>' });
  await registerGeminiStub(page, { responses: { 'optimize-query': {
    target_block_id: '1', proposed_expression: '"ARDS"[tiab]', added_terms: [], removed_terms: ['"broad"[tiab]'],
    replaced_terms: [], rationale: '研究基準に合う ARDS を維持し、広すぎる語を削除しました。', measurement_ids: [], mesh_requests: [],
  } }, usage: { promptTokenCount: 1000, candidatesTokenCount: 1000 } });
  let release = (): void => {};
  if (options.holdAi) {
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/generativelanguage.googleapis.com/**', async (route) => { await gate; await route.fallback(); });
  }
  await injectAppStub(page, fullStateScenario({ preloadedState: { ...FULL_APP_STATE, currentFormulaMarkdown: INITIAL_MD },
    extraStorage: { 'apiKeys.gemini': 'dummy-key' } }));
  return { fake, release };
}

async function start(page: Page) {
  await page.goto(APP_URL);
  await expect(page.getByRole('button', { name: '検索式を作成・自動調整する' })).toBeEnabled();
  await page.getByLabel('最大件数', { exact: true }).fill('100');
  await page.getByText('詳細設定', { exact: true }).click();
  await page.getByLabel('反復上限').fill('1');
  await page.getByRole('button', { name: '検索式を作成・自動調整する' }).click();
}

async function expectReview(page: Page, label: string) {
  await expect(page.getByRole('heading', { name: `最終レビュー：${label}`, exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.optimization__final-formula')).toBeVisible();
}

test.describe('検索式の自動調整', () => {
  test.setTimeout(90_000);
  test('失う集合がある候補は保留し、初期式のままレビューと保存へ進む', async ({ page }) => {
    const { fake } = await setup(page, { hasSeeds: true, holdAi: false, heldLost: 150 });
    await start(page);
    await expectReview(page, '要確認');
    await expect(page.locator('.optimization__history')).toContainText('/ 保留:');
    await page.getByText('試行1の変更詳細', { exact: true }).click();
    await expect(page.getByText('失う集合: 150 件 / 増える集合: 0 件', { exact: true })).toBeVisible();
    await expect(page.locator('.optimization__review')).toContainText('保留した候補 1 件');
    await expect(page.locator('.optimization__final-formula')).toContainText('"broad"[tiab]');
    await expect(page.locator('.optimization__review')).toContainText('初期式からの変更はありません');
    const adopt = page.getByRole('button', { name: '採用して保存', exact: true });
    await expect(adopt).toBeEnabled();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations).toEqual([]);
    await adopt.click();
    await expect(page.locator('.optimization__save-status')).toContainText('保存しました', { timeout: 15_000 });
    await expect.poll(() => fake.tabs['FormulaVersions']!.length).toBe(3);
    expect(fake.tabs['FormulaVersions']![2]![4]).toContain('"broad"[tiab]');
  });
  test('設定 → 実行 → 履歴増加 → 条件達成 → auto_optimize を一度だけ保存', async ({ page }) => {
    const { fake, release } = await setup(page, { hasSeeds: true, holdAi: true });
    await start(page);
    await expect(page.locator('.optimization__history-scroll > ol > li')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.optimization__status')).toContainText('自動調整を実行中');
    release();
    await expectReview(page, '条件達成');
    await expect(page.locator('.optimization__history-scroll > ol > li')).toHaveCount(3);
    await expect(page.locator('.optimization__review')).toContainText('既知シード 1/1 件捕捉');
    await expect(page.locator('.optimization__review')).toContainText('実測 50 件（上限以下）');
    await expect(page.locator('.optimization__review')).toContainText('網羅性を保証するものではありません');
    await expect(page.locator('#app-context')).toContainText('累積 $0.1305');
    await page.getByText('試行1の変更詳細', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'フリーワード', exact: true }).filter({ visible: true })).toBeVisible();
    const adopt = page.getByRole('button', { name: '採用して保存', exact: true });
    await adopt.click();
    await expect(page.locator('.optimization__save-status')).toHaveText('保存中…');
    await expect(adopt).toBeDisabled();
    await expect(page.locator('.optimization__save-status')).toContainText('保存しました', { timeout: 15_000 });
    await expect(adopt).toBeDisabled();
    const rows = fake.tabs['FormulaVersions']!;
    expect(rows).toHaveLength(3);
    expect(rows[2]![5]).toBe('auto_optimize');
    expect(rows[2]![1]).toBe('fv-20260420-01');
    expect(rows[2]![3]).toBe('snapshot');
    expect(fake.tabs['ValidationLog']![1]![1]).toBe(rows[2]![0]);
    await page.evaluate(() => { window.location.hash = '#/history'; });
    await expect(page.locator('.history__item')).toHaveCount(2);
    await page.evaluate(() => { window.location.hash = '#/draft'; });
    await expect(adopt).toBeDisabled();
    await expect(page.locator('.optimization__history-scroll > ol > li')).toHaveCount(3);
    expect(fake.tabs['FormulaVersions']).toHaveLength(3);
  });

  test('シードなしは要確認とし、編集して確認は新しい保存を発生させない', async ({ page }) => {
    const { fake } = await setup(page, { hasSeeds: false, holdAi: false });
    await start(page);
    await expectReview(page, '要確認');
    await expect(page.locator('.optimization__review')).toContainText('シードが未指定');
    await page.getByRole('button', { name: '編集して確認', exact: true }).click();
    await expect(page).toHaveURL(/#\/edit$/);
    await expect(page.locator('.edit__block-row[data-block-id="1"] .edit__block-current')).toHaveText('"ARDS"[tiab]');
    expect(fake.tabs['FormulaVersions']).toHaveLength(2);
  });

  test('実行中の進捗表示に axe 違反がない', async ({ page }) => {
    const { release } = await setup(page, { hasSeeds: true, holdAi: true });
    await start(page);
    await expect(page.locator('.optimization__history-scroll > ol > li')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByRole('button', { name: '停止して候補を確認' })).toBeVisible();
    try {
      const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
      expect(result.violations).toEqual([]);
    } finally { release(); }
    await expectReview(page, '条件達成');
  });

  test('最終レビュー表示に axe 違反がない', async ({ page }) => {
    await setup(page);
    await start(page);
    await expectReview(page, '条件達成');
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations).toEqual([]);
  });
});
