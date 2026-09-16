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
import { createQueryOptimizationInputIdentity, type QueryOptimizationCheckpoint } from '../../src/app/services/queryOptimizationCheckpointService';
import { parsePubmedFormulaMd } from '../../src/lib/search-formula-md';

const APP_URL = '/app/app.html#/draft';
const PMID = '20000001';
const OUTSIDE_PMID = '40000001';
const INITIAL_MD = '## PubMed/MEDLINE\n\n```\n#1 "ARDS"[tiab] OR "broad"[tiab]\n#2 "ECMO"[tiab]\n#3 #1 AND #2\n```\n';

async function setup(page: Page, options: { hasSeeds: boolean; holdAi: boolean; heldLost?: number; missedByFilter?: boolean; checkpoint?: QueryOptimizationCheckpoint }
  = { hasSeeds: true, holdAi: false }) {
  const initialMd = options.missedByFilter ? INITIAL_MD.replace('#3 #1 AND #2',
    '#3 randomized controlled trial[pt]\n#4 #1 AND #2 AND #3') : INITIAL_MD;
  const seed: Record<string, string> = { seed_id: 'seed-1', pmid: PMID, title: 'ARDS と ECMO',
    source: 'initial', is_valid: 'TRUE', user_decision: 'include' };
  const fake = await registerSheetsStub(page, { appendDelayMs: 300, tabs: {
    FormulaVersions: [[...SHEET_HEADERS.FormulaVersions],
      ['fv-20260420-01', '', '1', 'snapshot', initialMd, 'ai_draft', '2026-09-11T00:00:00Z', '', 'gemini-3.5-flash']],
    ValidationLog: [[...SHEET_HEADERS.ValidationLog]],
    SeedPapers: [[...SHEET_HEADERS.SeedPapers], ...(options.hasSeeds ? [SHEET_HEADERS.SeedPapers.map((key) => seed[key] ?? '')] : [])],
  } });
  await registerDriveStub(page);
  await registerMeshRdfStub(page);
  await registerNcbiStub(page, { esearch: (url) => {
    const query = new URL(url).searchParams.get('term')!;
    // margin も差集合なので、拡張語を目印に削除影響より先に判定する。
    // expand-query-for-recall の応答（下の Gemini スタブ）は拡張語が 1 語だけなので、
    // 外側の確認（既定 per-term。issue #154）の「全体 margin 件数 → 語の件数 → 語の取得」は
    // すべて同一クエリ文字列になり、この条件だけで何度呼ばれても同じ結果を返せる。
    if (query.includes(') NOT (') && query.includes('"extracorporeal"[tiab]')) {
      return { count: '1', idlist: [OUTSIDE_PMID] };
    }
    if (query.includes(') NOT (')) {
      const lost = options.heldLost !== undefined && query.split(') NOT (')[0]!.includes('broad');
      return { count: String(lost ? options.heldLost : 0), idlist: lost ? Array.from({ length: Math.min(options.heldLost!, Number(new URL(url).searchParams.get('retmax') ?? '20')) }, (_, index) => String(30000001 + index)) : [] };
    }
    if (options.missedByFilter && query.includes('[uid]')) {
      return query.includes('randomized') ? { count: '0', idlist: [] } : { count: '1', idlist: [PMID] };
    }
    // 件数診断で片方の概念を外した式も、最終式以上の件数を返す。
    if (!query.includes('[uid]') && (!query.includes('"ARDS"[tiab]') || !query.includes('"ECMO"[tiab]'))) {
      return { count: '300', idlist: [] };
    }
    return url.includes(PMID) ? { count: '1', idlist: [PMID] }
      : { count: url.includes('broad') ? '250' : '50', idlist: [] };
  }, efetchXml: (url) => {
    const pmids = new URL(url).searchParams.get('id')?.split(',') ?? [];
    return `<PubmedArticleSet>${pmids.filter((pmid) => (Number(pmid) >= 30000001 && Number(pmid) <= 30000000 + (options.heldLost ?? 0)) || pmid === OUTSIDE_PMID).map((pmid) =>
      `<PubmedArticle><PMID>${pmid}</PMID><ArticleTitle>${pmid === OUTSIDE_PMID ? '外側の研究' : '確認対象の研究'}</ArticleTitle><PubDate><Year>2024</Year></PubDate><Abstract><AbstractText>確認対象の抄録</AbstractText></Abstract></PubmedArticle>`).join('')}</PubmedArticleSet>`;
  } });
  await registerGeminiStub(page, { responses: {
    'annotate-lost-sample': (prompt: string) => ({ items: [...prompt.matchAll(/"pmid"\s*:\s*"(\d+)"/g)].map((match) => ({
      pmid: match[1], judgement: 'unclear', reason: '人による確認が必要です。',
    })) }),
    'optimize-query': {
    target_block_id: '1', proposed_expression: '"ARDS"[tiab]', added_terms: [], removed_terms: ['"broad"[tiab]'],
    replaced_terms: [], rationale: '研究基準に合う ARDS を維持し、広すぎる語を削除しました。', measurement_ids: [], mesh_requests: [],
  }, 'expand-query-for-recall': { blocks: [{ id: '2', additions: [
    { term: '"extracorporeal"[tiab]', axis: 'freeword', rationale: '別の用語を確認する' },
  ] }] }, 'pick-boundary-cases': { picks: [{ pmid: OUTSIDE_PMID, reason: '介入の適格性を確認する' }] } },
  usage: { promptTokenCount: 1000, candidatesTokenCount: 1000 },
  usageBySkill: {
    'annotate-lost-sample': { promptTokenCount: 0, candidatesTokenCount: 0 },
    'expand-query-for-recall': { promptTokenCount: 0, candidatesTokenCount: 0 },
    'pick-boundary-cases': { promptTokenCount: 0, candidatesTokenCount: 0 },
  } });
  let release = (): void => {};
  if (options.holdAi) {
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/generativelanguage.googleapis.com/**', async (route) => { await gate; await route.fallback(); });
  }
  await injectAppStub(page, fullStateScenario({ preloadedState: { ...FULL_APP_STATE, currentFormulaMarkdown: initialMd },
    extraStorage: { 'apiKeys.gemini': 'dummy-key', ...(options.checkpoint ? {
      queryOptimizationCheckpoint: options.checkpoint,
      queryOptimizationSettings: { projectId: options.checkpoint.projectId, maxHits: 100, maxIterations: 5 },
    } : {}) } }));
  return { fake, release };
}

async function start(page: Page) {
  await page.goto(APP_URL);
  await expect(page.getByRole('button', { name: '検索式を作成・自動調整する' })).toBeEnabled();
  await page.getByLabel('目安件数', { exact: true }).fill('100');
  await page.getByText('詳細設定', { exact: true }).click();
  await page.getByLabel('反復上限').fill('1');
  await page.getByRole('button', { name: '検索式を作成・自動調整する' }).click();
}

async function expectReview(page: Page, label: string) {
  await expect(page.getByRole('heading', { name: `最終レビュー：${label}`, exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.optimization__final-formula')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ブロック構造の診断', exact: true })).toBeVisible();
  await expect(page.locator('.optimization__review')).toContainText('削減率');
}

test.describe('検索式の自動調整', () => {
  test.setTimeout(90_000);
  test('未捕捉シードとフィルタを診断しブロック承認へ戻る', async ({ page }) => {
    await setup(page, { hasSeeds: true, holdAi: false, missedByFilter: true });
    await start(page);
    await expectReview(page, '要確認');
    await expect(page.locator('.optimization__history')).toContainText('削除案を受け付けません');
    await expect(page.getByRole('heading', { name: '未捕捉シードの診断', exact: true })).toBeVisible();
    const review = page.locator('.optimization__review');
    await expect(review).toContainText(PMID);
    await expect(review).toContainText('承認外');
    await expect(review).toContainText('語の調整では回収できないシード');
    const button = page.getByRole('button', { name: 'ブロック承認へ戻る', exact: true });
    await expect(button).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations).toEqual([]);
    await button.click();
    await expect(page).toHaveURL(/#\/blocks$/);
  });
  test('リロードした中断ログから最良式を新しい run で再測定し、旧記録と残予算を保つ', async ({ page }) => {
    const best = parsePubmedFormulaMd(INITIAL_MD.replace(' OR "broad"[tiab]', ''));
    const checkpoint: QueryOptimizationCheckpoint = { projectId: FULL_APP_STATE.project!.projectId,
      runId: 'interrupted-run', savedAt: '2026-09-10T00:00:00Z', maxHits: 100,
      trials: [{ candidateId: 'old-rejected', formula: parsePubmedFormulaMd(INITIAL_MD), totalHits: 999,
        capturedSeedCount: 0, accepted: false, reason: '前回はシードを失った', fingerprint: 'old-fingerprint' }],
      resume: { bestFormula: best,
        inputIdentity: createQueryOptimizationInputIdentity(FULL_APP_STATE.protocolDraft!, FULL_APP_STATE.blocksDraft!, [PMID], 100),
        limits: { apiCalls: 200, elapsedMs: 600000, evaluatedTrials: 5 },
        consumed: { apiCalls: 120, elapsedMs: 300000, evaluatedTrials: 2 }, previousRejectedTrials: [] },
    };
    const { fake } = await setup(page, { hasSeeds: true, holdAi: false, checkpoint });
    const queries: string[] = [];
    let prompt = '';
    await page.route('**/eutils.ncbi.nlm.nih.gov/**', async (route) => {
      queries.push(new URL(route.request().url()).searchParams.get('term') ?? '');
      await route.fallback();
    });
    await page.route('**/generativelanguage.googleapis.com/**', async (route) => {
      prompt += route.request().postData() ?? '';
      await route.fallback();
    });
    await page.goto(APP_URL);
    await expect(page.locator('.optimization__resume')).toBeEnabled();
    await page.reload();
    await expect(page.locator('.optimization__restored')).toContainText('再検証は済んでいません');
    await expect(page.locator('.optimization__restored')).toContainText('通信 80 回 / 時間 300 秒 / 評価試行 3 回');
    const a11y = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(a11y.violations).toEqual([]);
    await page.locator('.optimization__resume').click();
    await expectReview(page, '目安件数と既知シードの捕捉を満たしました');
    await expect(page.locator('.optimization__history-scroll > ol > li').first()).toContainText('50 件 / シード: 未測定 → 1/1件');
    expect(queries.some((query) => query.includes('[uid]'))).toBe(true);
    expect(queries.some((query) => query.includes('broad'))).toBe(false);
    expect(prompt).toContain('前回はシードを失った');
    expect(prompt).toContain('old-fingerprint');
    expect(fake.tabs['FormulaVersions']).toHaveLength(2);
    const data = await page.evaluate(() => chrome.storage.local.get(null));
    const saved = data.queryOptimizationCheckpoint as QueryOptimizationCheckpoint;
    expect(saved.runId).not.toBe(checkpoint.runId);
    expect(saved.resume?.resumedFromRunId).toBe(checkpoint.runId);
    expect(saved.resume?.consumed.apiCalls).toBeGreaterThan(120);
    expect(saved.resume?.consumed.evaluatedTrials).toBe(3);
    expect(Object.keys(data).filter((key) => key.startsWith('queryOptimizationCheckpoint'))).toEqual(['queryOptimizationCheckpoint']);
    expect(saved.completion?.status).toBe('achieved');
  });

  test('失う集合がある候補は保留し、初期式のままレビューと保存へ進む', async ({ page }) => {
    const { fake } = await setup(page, { hasSeeds: true, holdAi: false, heldLost: 150 });
    await start(page);
    await expectReview(page, '要確認');
    await expect(page.locator('.optimization__history')).toContainText('/ 保留:');
    await page.getByText('試行1の変更詳細', { exact: true }).click();
    await expect(page.getByText('失う集合: 150 件 / 増える集合: 0 件', { exact: true })).toBeVisible();
    await expect(page.locator('.optimization__review')).toContainText('保留した候補 1 件');
    await expect(page.locator('.optimization__held-candidate')).toContainText('AI の参考注釈（採否には使いません）');
    await expect(page.getByRole('article', { name: /^判定候補 PMID 30000/ }).first()).not.toContainText('AI:');
    await expect(page.getByRole('article', { name: /^判定候補 PMID 30000/ }).first())
      .toContainText('保留候補 candidate-1 で失う文献');
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

  test('保留候補の 3 操作が出て、標本を判定するまで採用できない（issue #172）', async ({ page }) => {
    const { fake } = await setup(page, { hasSeeds: true, holdAi: false, heldLost: 150 });
    await start(page);
    await expectReview(page, '要確認');
    const card = page.getByRole('article', { name: '保留候補 candidate-1 の操作', exact: true });
    await expect(card).toBeVisible();
    const heldAdopt = card.getByRole('button', { name: '保留候補 candidate-1 を採用して保存', exact: true });
    await expect(heldAdopt).toHaveText('この候補を採用して保存');
    const bestAdopt = page.getByRole('button', { name: '採用して保存', exact: true });
    await expect(bestAdopt).toHaveCount(1);
    await expect(bestAdopt).toHaveText('採用して保存');
    const readjust = card.getByRole('button', { name: 'これを初期式に再調整', exact: true });
    const reject = card.getByRole('button', { name: '除外', exact: true });
    // 失う集合 150 件は既定の閾値（100 件）を超えるため、標本を全件判定するまで押せない。
    await expect(heldAdopt).toBeDisabled();
    await expect(card).toContainText('件の判定が必要です');
    await expect(readjust).toBeEnabled();
    await expect(reject).toBeEnabled();
    const a11y = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(a11y.violations).toEqual([]);

    // 標本の全件を exclude 判定するとゲートが通る。
    const candidates = page.getByRole('article', { name: /^判定候補 PMID 30000/ });
    const sampleCount = await candidates.count();
    for (let index = 0; index < sampleCount; index += 1) {
      await candidates.nth(index).getByRole('button', { name: 'exclude', exact: true }).click();
      await expect(candidates.nth(index)).toContainText('exclude：保存済み');
    }
    await expect(heldAdopt).toBeEnabled();
    await expect(card).not.toContainText('件の判定が必要です');

    // 保留候補の採用は最良候補の保存と排他（run につき 1 回）。
    await heldAdopt.click();
    await expect(page.locator('.optimization__save-status'))
      .toContainText('保留候補 candidate-1 の式を採用して保存しました', { timeout: 15_000 });
    await expect(bestAdopt).toBeDisabled();
    await expect.poll(() => fake.tabs['FormulaVersions']!.length).toBe(3);
    expect(fake.tabs['FormulaVersions']![2]![4]).toContain('"ARDS"[tiab]');
    expect(fake.tabs['FormulaVersions']![2]![4]).not.toContain('"broad"[tiab]');
  });

  test('保留候補の除外は取り消せ、再調整はその候補の式で新しい run を始める（issue #172）', async ({ page }) => {
    await setup(page, { hasSeeds: true, holdAi: false, heldLost: 150 });
    await start(page);
    await expectReview(page, '要確認');
    const card = page.getByRole('article', { name: '保留候補 candidate-1 の操作', exact: true });
    const heldAdopt = card.getByRole('button', { name: '保留候補 candidate-1 を採用して保存', exact: true });
    const reject = card.getByRole('button', { name: '除外', exact: true });
    await reject.click();
    const undo = card.getByRole('button', { name: '除外を取り消す', exact: true });
    await expect(undo).toBeVisible();
    await expect(card).toContainText('人がこの変更を除外しました');
    await expect(heldAdopt).toBeDisabled();
    await undo.click();
    await expect(reject).toBeVisible();
    await expect(card).not.toContainText('人がこの変更を除外しました');

    const readjust = card.getByRole('button', { name: 'これを初期式に再調整', exact: true });
    await readjust.click();
    await expect(page.locator('.optimization__status')).toContainText('自動調整を実行中');
  });

  test('設定 → 実行 → 履歴増加 → 目安件数と既知シードの捕捉を満たしました → auto_optimize を一度だけ保存', async ({ page }) => {
    const { fake, release } = await setup(page, { hasSeeds: true, holdAi: true });
    await start(page);
    await expect(page.locator('.optimization__history-scroll > ol > li')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.optimization__status')).toContainText('自動調整を実行中');
    release();
    await expectReview(page, '目安件数と既知シードの捕捉を満たしました');
    await expect(page.locator('.optimization__history-scroll > ol > li')).toHaveCount(3);
    await expect(page.locator('.optimization__review')).toContainText('既知シード 1/1 件捕捉');
    await expect(page.locator('.optimization__review')).toContainText('実測 50 件（目安以下）');
    await expect(page.locator('.optimization__review')).toContainText('既知シードを捕捉したことは、未知の適格研究を網羅したことを意味しません。');
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
    await expectReview(page, '目安件数と既知シードの捕捉を満たしました');
  });

  test('最終レビュー表示に axe 違反がない', async ({ page }) => {
    await setup(page);
    await start(page);
    await expectReview(page, '目安件数と既知シードの捕捉を満たしました');
    await expect(page.getByRole('article', { name: `判定候補 PMID ${OUTSIDE_PMID}`, exact: true })).toBeVisible();
    const result = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(result.violations).toEqual([]);
  });

  test('4 区分を確認して外側の文献を include 保存すると保護再調整を選べる', async ({ page }) => {
    const { fake } = await setup(page);
    await start(page);
    await expectReview(page, '目安件数と既知シードの捕捉を満たしました');
    await expect(page.getByRole('heading', { name: '確認の状況', exact: true })).toBeVisible();
    const sections = page.locator('.optimization__review-section');
    await expect(sections).toHaveCount(4);
    for (const label of ['既知文献の捕捉', '目安件数', '外側の確認', '削除影響の確認']) {
      await expect(sections.getByRole('heading', { name: new RegExp(label) })).toBeVisible();
    }
    const candidate = page.getByRole('article', { name: `判定候補 PMID ${OUTSIDE_PMID}`, exact: true });
    await candidate.getByRole('button', { name: 'include', exact: true }).click();
    await expect(candidate).toContainText('include：保存済み');
    await expect(page.getByRole('button', { name: 'include した文献を保護して再調整する', exact: true })).toBeEnabled();
    const rows = fake.tabs['SeedPapers']!;
    const row = rows.find((values) => values[SHEET_HEADERS.SeedPapers.indexOf('pmid')] === OUTSIDE_PMID)!;
    expect(row[SHEET_HEADERS.SeedPapers.indexOf('source')]).toBe('interactive');
    expect(row[SHEET_HEADERS.SeedPapers.indexOf('user_decision')]).toBe('include');
  });
});
