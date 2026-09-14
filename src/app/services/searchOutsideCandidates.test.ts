import { searchOutsideCandidates } from './expandService';
import * as skills from '@/features/formula/skills';
import * as ncbi from '@/lib/ncbi';
import { PICK_BOUNDARY_SYSTEM_PROMPT } from '@/features/formula/skills/pickBoundaryCases';

afterEach(() => jest.restoreAllMocks());

const stratifiedRanges = [
  '"1000/01/01"[dp] : "1979/12/31"[dp]', '"1980/01/01"[dp] : "1989/12/31"[dp]',
  '"1990/01/01"[dp] : "1999/12/31"[dp]', '"2000/01/01"[dp] : "2009/12/31"[dp]',
  '"2010/01/01"[dp] : "2019/12/31"[dp]', '"2020/01/01"[dp] : "3000"[dp]',
];
const stratifiedMargin = '((best[tiab]) OR outside[tiab]) NOT (best[tiab])';
function outsideInput() {
  return { formula: { blocks: [{ id: '1', expression: 'best[tiab]', isCombination: false }], combinationExpression: null },
    researchQuestion: 'RQ', inclusionCriteria: '', exclusionCriteria: '', existingPmids: new Set<string>(),
    additions: [{ blockId: '1', additions: [{ term: 'outside[tiab]', axis: 'freeword' as const, rationale: '別名' }] }],
    eutils: { fetch: jest.fn() }, llmFactory: { model: 'fake', forPurpose: jest.fn() } };
}

// 意図した仕様変更（issue #154）: retrieval 未指定の既定が head から per-term に変わったため、
// 「head の明示と未指定は同一」ではなくなった。ここでは「head を明示すれば毎回同じ通信・戻り値
// になる」ことだけを検査する。未指定（per-term）の挙動は以降のテストで別に検査する。
test('head を明示すると通信引数・回数・戻り値が変わらない', async () => {
  const search = jest.spyOn(ncbi, 'esearch').mockResolvedValue({ count: 0, pmids: [] });
  const deps = { ...outsideInput(), retrieval: 'head' as const };
  const first = await searchOutsideCandidates(deps);
  const calls = [...search.mock.calls];
  search.mockClear();
  expect(await searchOutsideCandidates(deps)).toEqual(first);
  expect(search.mock.calls).toEqual(calls);
  expect(search).toHaveBeenCalledTimes(2);
  expect(first.stages).not.toHaveProperty('strata');
  expect(first.stages).not.toHaveProperty('terms');
});

test.each(['head', 'year-stratified'] as const)('sort: none は %s の取得で sort パラメータを付けない', async (retrieval) => {
  const search = jest.spyOn(ncbi, 'esearch').mockResolvedValue({ count: 0, pmids: [] });
  await searchOutsideCandidates({ ...outsideInput(), retrieval, sort: 'none' });
  expect(search).toHaveBeenCalledTimes(retrieval === 'head' ? 2 : 8);
  for (const call of search.mock.calls) expect(call[2]).not.toHaveProperty('sort');
});

test('sort: none は per-term（既定）の取得でも sort パラメータを付けない', async () => {
  // count 1 以上にして語の取得（esearch 3 回目）まで実際に走らせ、sort が付かないことを見る。
  // 取得した PMID を既存 seed と衝突させ、既知除外の直後（efetch 前）で早期リターンさせる
  // （efetch / pick_boundary まで進めると eutils.fetch の未スタブぶんが実ネットワークへ
  // リトライし続けてタイムアウトする。実際に一度この形で踏んだ）。
  const search = jest.spyOn(ncbi, 'esearch').mockResolvedValue({ count: 1, pmids: ['p'] });
  await searchOutsideCandidates({ ...outsideInput(), existingPmids: new Set(['p']), sort: 'none' });
  expect(search).toHaveBeenCalledTimes(4); // 全体件数 + 語の件数 + 語の取得 + 現式件数
  for (const call of search.mock.calls) expect(call[2]).not.toHaveProperty('sort');
});

test('年代層の検索語・既定 200 件の配分・sort・交互順・重複除去を記録する', async () => {
  const allocations = [33, 33, 33, 33, 34, 34];
  const pools = allocations.map((size, layer) => Array.from({ length: size }, (_, i) => i === 0 ? 'shared' : `${layer}-${i}`));
  const search = jest.spyOn(ncbi, 'esearch').mockResolvedValueOnce({ count: 999, pmids: [] });
  pools.forEach((pmids) => search.mockResolvedValueOnce({ count: 100, pmids }));
  search.mockResolvedValueOnce({ count: 10, pmids: [] });
  const fetch = jest.spyOn(ncbi, 'efetchArticles').mockResolvedValue([]);
  jest.spyOn(skills, 'pickBoundaryCases').mockResolvedValue([]);
  const deps = { ...outsideInput(), retrieval: 'year-stratified' as const };
  const result = await searchOutsideCandidates(deps);
  expect(search).toHaveBeenCalledTimes(8);
  expect(search).toHaveBeenNthCalledWith(1, stratifiedMargin, deps.eutils, { retmax: 0 });
  stratifiedRanges.forEach((range, index) => expect(search).toHaveBeenNthCalledWith(index + 2,
    `(${stratifiedMargin}) AND (${range})`, deps.eutils, { retmax: allocations[index], sort: 'relevance' }));
  const expected = ['shared', ...Array.from({ length: 32 }, (_, i) => [5, 4, 3, 2, 1, 0].map((layer) => `${layer}-${i + 1}`)).flat(), '5-33', '4-33'];
  expect(result.stages?.retrievedPmids).toEqual(expected);
  expect(fetch).toHaveBeenCalledWith(expected, deps.eutils);
  expect(result.marginHits).toBe(999);
  expect(result.stages?.strata).toEqual(stratifiedRanges.map((dateRange, index) => ({ dateRange,
    label: ['〜1979', '1980–1989', '1990–1999', '2000–2009', '2010–2019', '2020〜'][index],
    count: 100, retrievedPmids: pools[index] })));
});

test.each([false, true])('余りは新しい未取得層へ均等配分し、2 巡目だけで終了する（容量不足: %s）', async (scarce) => {
  const search = jest.spyOn(ncbi, 'esearch').mockResolvedValueOnce({ count: 100, pmids: [] });
  [0, 0, 0, 0, 4, scarce ? 3 : 20].forEach((count, layer) =>
    search.mockResolvedValueOnce({ count, pmids: count ? [`${layer}-0`, `${layer}-1`] : [] }));
  search.mockResolvedValueOnce({ count: scarce ? 3 : 20, pmids: scarce ? ['5-2'] : ['5-2', '5-3'] });
  search.mockResolvedValueOnce({ count: 4, pmids: ['4-2', '4-3'] });
  search.mockResolvedValueOnce({ count: 10, pmids: [] });
  const deps = { ...outsideInput(), retrieval: 'year-stratified' as const, retmax: 12, skillCandidateLimit: 0, sort: 'relevance' as const };
  const result = await searchOutsideCandidates(deps);
  expect(search).toHaveBeenCalledTimes(10);
  expect(search).toHaveBeenNthCalledWith(8, `(${stratifiedMargin}) AND (${stratifiedRanges[5]})`, deps.eutils,
    { retmax: scarce ? 1 : 6, retstart: 2, sort: 'relevance' });
  expect(search).toHaveBeenNthCalledWith(9, `(${stratifiedMargin}) AND (${stratifiedRanges[4]})`, deps.eutils,
    { retmax: 2, retstart: 2, sort: 'relevance' });
  expect(result.stages?.retrievedPmids).toEqual(['5-0', '4-0', '5-1', '4-1', '5-2', '4-2', ...(scarce ? [] : ['5-3']), '4-3']);
  expect(result.stages?.strata?.[5]?.retrievedPmids).toEqual(['5-0', '5-1', '5-2', ...(scarce ? [] : ['5-3'])]);
});

test('6 件未満の枠も新しい層から割り当て、0 枠の層も件数を測る', async () => {
  const search = jest.spyOn(ncbi, 'esearch').mockResolvedValue({ count: 0, pmids: [] });
  await searchOutsideCandidates({ ...outsideInput(), retrieval: 'year-stratified', retmax: 2 });
  expect(search.mock.calls.slice(1, 7).map((call) => call[2])).toEqual([0, 0, 0, 0, 1, 1].map((retmax) => ({ retmax, sort: 'relevance' })));
  expect(search).toHaveBeenCalledTimes(8);
});

// 意図した仕様変更（issue #154）: 既定の取得方法が head（全語まとめて関連度順に一括取得）から
// per-term（語ごとの margin を件数昇順で均等配分して取得）に変わった。ここは拡張語が 1 語だけ
// なので、語ごとの margin クエリは全体の margin クエリと同一になり、実質は同じ集合を取得するが、
// 通信は「全体件数 → 語の件数 → 語の取得（retmax 200・relevance） → 現式件数」の 4 回になる。
test('指定式を拡張して NOT の右辺にも使い、全シードを除外し既定は per-term（語ごとの均等配分）にする', async () => {
  const formula = { blocks: [{ id: '1', expression: 'best[tiab]', isCombination: false }], combinationExpression: null };
  jest.spyOn(skills, 'expandQueryForRecall').mockResolvedValue([{ blockId: '1', additions: [
    { term: 'outside[tiab]', axis: 'freeword', rationale: '別の用語' },
  ] }]);
  const search = jest.spyOn(ncbi, 'esearch').mockResolvedValue({ count: 300, pmids: ['existing', ...Array.from({ length: 250 }, (_, i) => String(i))] });
  const fetch = jest.spyOn(ncbi, 'efetchArticles').mockImplementation(async (pmids) => pmids.map((pmid) => ({
    pmid, title: pmid, year: null, abstract: null, meshHeadings: [], meshDetails: [],
    journal: null, authors: [], volume: null, issue: null, pages: null, doi: null,
  })));
  const pick = jest.spyOn(skills, 'pickBoundaryCases').mockResolvedValue([]);
  const onProgress = jest.fn();
  const deps = { formula, researchQuestion: 'RQ', inclusionCriteria: '', exclusionCriteria: '', existingPmids: new Set(['existing']),
    eutils: { fetch: jest.fn() }, llmFactory: { model: 'fake', forPurpose: jest.fn() }, onProgress };
  await searchOutsideCandidates(deps);
  const margin = '((best[tiab]) OR outside[tiab]) NOT (best[tiab])';
  expect(search).toHaveBeenCalledTimes(4);
  expect(search).toHaveBeenNthCalledWith(1, margin, deps.eutils, { retmax: 0 }); // 全体の margin 件数
  expect(search).toHaveBeenNthCalledWith(2, margin, deps.eutils, { retmax: 0 }); // 語（1 語のみ）の件数
  expect(search).toHaveBeenNthCalledWith(3, margin, deps.eutils, { retmax: 200, sort: 'relevance' }); // 語の取得
  expect(search).toHaveBeenNthCalledWith(4, 'best[tiab]', deps.eutils, { retmax: 0 }); // 現式件数
  expect(fetch.mock.calls[0]![0]).toEqual(Array.from({ length: 200 }, (_, i) => String(i)));
  expect(pick.mock.calls[0]![0].candidates.map((candidate) => candidate.pmid)).toEqual(fetch.mock.calls[0]![0]);
  expect(onProgress.mock.calls.map(([step]) => step)).toEqual(['broaden', 'esearch', 'dedup', 'efetch', 'pick-boundary']);
  expect(formula.blocks[0]!.expression).toBe('best[tiab]');
});

test('境界候補のプロンプトは出版年代・用語・介入（曝露）の多様性を求める', () => {
  expect(PICK_BOUNDARY_SYSTEM_PROMPT).toContain('出版年代・用語・介入（曝露）が偏らない');
  expect(PICK_BOUNDARY_SYSTEM_PROMPT).toContain('似た文献で候補を厚くせず');
});

// retrieval: 'head' を明示している（既定は per-term に変わったため）。このテストの主眼は
// 「凍結した拡張語で候補を段階ごとに記録すること」であり、既定の取得方法の検証は別テストが担う。
test('凍結拡張語と relevance を使い、既知・上限・書誌欠落・未選定を段階ごとに記録する', async () => {
  const additions = [{ blockId: '1', additions: [{ term: 'outside[tiab]', axis: 'freeword' as const, rationale: '別名' }] }];
  const expand = jest.spyOn(skills, 'expandQueryForRecall');
  const search = jest.spyOn(ncbi, 'esearch').mockResolvedValueOnce({ count: 99, pmids: ['1', '2', '3', '4', '5'] })
    .mockResolvedValueOnce({ count: 10, pmids: [] });
  const article = (pmid: string): ncbi.EfetchArticle => ({ pmid, title: pmid, year: null, abstract: null,
    meshHeadings: [], meshDetails: [], journal: null, authors: [], volume: null, issue: null, pages: null, doi: null });
  const fetch = jest.spyOn(ncbi, 'efetchArticles').mockResolvedValue([article('4'), article('2')]);
  const pick = jest.spyOn(skills, 'pickBoundaryCases').mockResolvedValue([{ pmid: '4', reason: '候補' }]);
  const deps = { formula: { blocks: [{ id: '1', expression: 'best[tiab]', isCombination: false }], combinationExpression: null },
    researchQuestion: 'RQ', inclusionCriteria: '', exclusionCriteria: '', existingPmids: new Set(['1']), additions,
    eutils: { fetch: jest.fn() }, llmFactory: { model: 'fake', forPurpose: jest.fn() }, skillCandidateLimit: 3,
    sort: 'relevance' as const, retrieval: 'head' as const };
  const result = await searchOutsideCandidates(deps);
  expect(expand).not.toHaveBeenCalled();
  expect(deps.llmFactory.forPurpose.mock.calls).toEqual([['pick_boundary']]);
  expect(search).toHaveBeenNthCalledWith(1, '((best[tiab]) OR outside[tiab]) NOT (best[tiab])', deps.eutils, { retmax: 200, sort: 'relevance' });
  expect(search).toHaveBeenNthCalledWith(2, 'best[tiab]', deps.eutils, { retmax: 0 });
  expect(fetch).toHaveBeenCalledWith(['2', '3', '4'], deps.eutils);
  expect(pick.mock.calls[0]![0].candidates.map((candidate) => candidate.pmid)).toEqual(['2', '4']);
  expect(result.stages).toEqual({ broadenedQuery: '(best[tiab]) OR outside[tiab]',
    marginQuery: '((best[tiab]) OR outside[tiab]) NOT (best[tiab])',
    retrievedPmids: ['1', '2', '3', '4', '5'], novelPmids: ['2', '3', '4', '5'],
    requestedPmids: ['2', '3', '4'], fetchedPmids: ['2', '4'], pickedPmids: ['4'] });
  expect(result.candidates.map((candidate) => candidate.pmid)).toEqual(['4']);
});

// retrieval: 'head' を明示している（既定は per-term に変わり、語ごとの件数・取得の通信が増えるため、
// 早期リターン自体を検査するこのテストの回数比較が per-term では成り立たない）。
test.each([false, true])('早期リターンも段階を返す（拡張語なし: %s）', async (empty) => {
  const expand = jest.spyOn(skills, 'expandQueryForRecall');
  const search = jest.spyOn(ncbi, 'esearch').mockResolvedValue({ count: 10, pmids: ['1'] });
  const fetch = jest.spyOn(ncbi, 'efetchArticles');
  const result = await searchOutsideCandidates({
    formula: { blocks: [{ id: '1', expression: 'best[tiab]', isCombination: false }], combinationExpression: null },
    researchQuestion: 'RQ', inclusionCriteria: '', exclusionCriteria: '', existingPmids: new Set(['1']),
    additions: empty ? [] : [{ blockId: '1', additions: [{ term: 'outside[tiab]', axis: 'freeword', rationale: '' }] }],
    eutils: { fetch: jest.fn() }, llmFactory: { model: 'fake', forPurpose: jest.fn() }, retrieval: 'head',
  });
  expect(expand).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(search).toHaveBeenCalledTimes(empty ? 1 : 2);
  expect(result.stages).toEqual({ broadenedQuery: empty ? null : '(best[tiab]) OR outside[tiab]',
    marginQuery: empty ? null : '((best[tiab]) OR outside[tiab]) NOT (best[tiab])',
    retrievedPmids: empty ? [] : ['1'], novelPmids: [], requestedPmids: [], fetchedPmids: [], pickedPmids: [] });
});

// --- per-term（既定。issue #154）専用のテスト -----------------------------------------------

test('per-term（既定）: 語ごとの件数を数え、件数昇順で均等配分し、ラウンドロビンで重複除去する', async () => {
  const formula = { blocks: [{ id: '1', expression: 'best[tiab]', isCombination: false }], combinationExpression: null };
  // 'y1[tiab]' の前に空白のみの語を挟み、buildBroadenedFormula と同じく丸ごと除かれることを確認する。
  const additions = [{ blockId: '1', additions: [
    { term: 'x1[tiab]', axis: 'freeword' as const, rationale: '' },
    { term: 'x2[tiab]', axis: 'freeword' as const, rationale: '' },
    { term: '  ', axis: 'freeword' as const, rationale: '' },
    { term: 'y1[tiab]', axis: 'freeword' as const, rationale: '' },
  ] }];
  const mx1 = '((best[tiab]) OR x1[tiab]) NOT (best[tiab])';
  const mx2 = '((best[tiab]) OR x2[tiab]) NOT (best[tiab])';
  const my1 = '((best[tiab]) OR y1[tiab]) NOT (best[tiab])';
  const overallMargin = '((best[tiab]) OR x1[tiab] OR x2[tiab] OR y1[tiab]) NOT (best[tiab])';

  const search = jest.spyOn(ncbi, 'esearch')
    .mockResolvedValueOnce({ count: 77, pmids: [] }) // 1. 全体の margin 件数
    .mockResolvedValueOnce({ count: 50, pmids: [] }) // 2. x1 の件数
    .mockResolvedValueOnce({ count: 5, pmids: [] }) // 3. x2 の件数
    .mockResolvedValueOnce({ count: 0, pmids: [] }) // 4. y1 の件数（0 件 → 取得しない）
    .mockResolvedValueOnce({ count: 5, pmids: ['p1', 'p2', 'p3'] }) // 5. x2 の取得（件数昇順で先）
    .mockResolvedValueOnce({ count: 50, pmids: ['p3', 'p4'] }) // 6. x1 の取得
    .mockResolvedValueOnce({ count: 20, pmids: [] }); // 7. 現式件数
  const fetch = jest.spyOn(ncbi, 'efetchArticles').mockResolvedValue([]);
  const pick = jest.spyOn(skills, 'pickBoundaryCases').mockResolvedValue([]);
  const deps = { formula, researchQuestion: 'RQ', inclusionCriteria: '', exclusionCriteria: '', existingPmids: new Set<string>(),
    additions, eutils: { fetch: jest.fn() }, llmFactory: { model: 'fake', forPurpose: jest.fn() }, retmax: 5 };
  const result = await searchOutsideCandidates(deps);

  expect(search).toHaveBeenCalledTimes(7);
  expect(search).toHaveBeenNthCalledWith(1, overallMargin, deps.eutils, { retmax: 0 });
  expect(search).toHaveBeenNthCalledWith(2, mx1, deps.eutils, { retmax: 0 });
  expect(search).toHaveBeenNthCalledWith(3, mx2, deps.eutils, { retmax: 0 });
  expect(search).toHaveBeenNthCalledWith(4, my1, deps.eutils, { retmax: 0 });
  // 件数昇順（x2:5 → x1:50）。retmax 5 を 2 語へ均等配分（余り 1 は先頭の x2 へ）= [3, 2]。
  expect(search).toHaveBeenNthCalledWith(5, mx2, deps.eutils, { retmax: 3, sort: 'relevance' });
  expect(search).toHaveBeenNthCalledWith(6, mx1, deps.eutils, { retmax: 2, sort: 'relevance' });
  expect(search).toHaveBeenNthCalledWith(7, 'best[tiab]', deps.eutils, { retmax: 0 });

  expect(result.marginHits).toBe(77);
  expect(result.originalHits).toBe(20);
  expect(result.broadenedHits).toBe(97);
  expect(result.stages?.retrievalFallback).toBeUndefined();
  // ラウンドロビン（x2 が先）: index0 [p1,p3] index1 [p2,p4] index2 [p3(重複除去)]
  expect(result.stages?.retrievedPmids).toEqual(['p1', 'p3', 'p2', 'p4']);
  expect(result.stages?.terms).toEqual([
    { blockId: '1', term: 'x2[tiab]', marginQuery: mx2, count: 5, allocation: 3, retrievedPmids: ['p1', 'p2', 'p3'] },
    { blockId: '1', term: 'x1[tiab]', marginQuery: mx1, count: 50, allocation: 2, retrievedPmids: ['p3', 'p4'] },
    { blockId: '1', term: 'y1[tiab]', marginQuery: my1, count: 0, allocation: 0, retrievedPmids: [] },
  ]);
  expect(fetch).toHaveBeenCalledWith(['p1', 'p3', 'p2', 'p4'], deps.eutils);
  expect(pick).toHaveBeenCalled();
});

test('per-term（既定）: 語ごとの取得が合計 0 件で全体 margin が 1 件以上あれば head 取得へフォールバックする', async () => {
  const deps = outsideInput(); // 拡張語は 'outside[tiab]' の 1 語だけ
  const search = jest.spyOn(ncbi, 'esearch')
    .mockResolvedValueOnce({ count: 3, pmids: [] }) // 1. 全体 margin 件数（1 件以上）
    .mockResolvedValueOnce({ count: 0, pmids: [] }) // 2. 語の件数が 0（取得単位に入らない）
    .mockResolvedValueOnce({ count: 3, pmids: ['h1', 'h2'] }) // 3. フォールバック: head 取得
    .mockResolvedValueOnce({ count: 9, pmids: [] }); // 4. 現式件数
  jest.spyOn(ncbi, 'efetchArticles').mockResolvedValue([]);
  jest.spyOn(skills, 'pickBoundaryCases').mockResolvedValue([]);
  const result = await searchOutsideCandidates(deps);
  const margin = '((best[tiab]) OR outside[tiab]) NOT (best[tiab])';
  expect(search).toHaveBeenCalledTimes(4);
  expect(search).toHaveBeenNthCalledWith(1, margin, deps.eutils, { retmax: 0 });
  expect(search).toHaveBeenNthCalledWith(2, margin, deps.eutils, { retmax: 0 });
  expect(search).toHaveBeenNthCalledWith(3, margin, deps.eutils, { retmax: 200, sort: 'relevance' });
  expect(search).toHaveBeenNthCalledWith(4, 'best[tiab]', deps.eutils, { retmax: 0 });
  expect(result.stages?.retrievalFallback).toBe('head');
  expect(result.stages?.retrievedPmids).toEqual(['h1', 'h2']);
  expect(result.marginHits).toBe(3);
});

test('per-term（既定）: 全体 margin も 0 件ならフォールバックしない', async () => {
  const deps = outsideInput();
  const search = jest.spyOn(ncbi, 'esearch').mockResolvedValue({ count: 0, pmids: [] });
  const result = await searchOutsideCandidates(deps);
  expect(search).toHaveBeenCalledTimes(3); // 全体件数 + 語の件数(0件→取得なし) + 現式件数
  expect(result.stages?.retrievalFallback).toBeUndefined();
  expect(result.marginHits).toBe(0);
  expect(result.candidates).toEqual([]);
});
