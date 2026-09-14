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

test('head の明示と未指定は通信引数・回数・戻り値が同一', async () => {
  const search = jest.spyOn(ncbi, 'esearch').mockResolvedValue({ count: 0, pmids: [] });
  const deps = outsideInput();
  const implicit = await searchOutsideCandidates(deps);
  const calls = [...search.mock.calls];
  search.mockClear();
  expect(await searchOutsideCandidates({ ...deps, retrieval: 'head' })).toEqual(implicit);
  expect(search.mock.calls).toEqual(calls);
  expect(search).toHaveBeenCalledTimes(2);
  expect(implicit.stages).not.toHaveProperty('strata');
});

test('年代層の検索語・50 件の配分・sort・交互順・重複除去を記録する', async () => {
  const allocations = [8, 8, 8, 8, 9, 9];
  const pools = allocations.map((size, layer) => Array.from({ length: size }, (_, i) => i === 0 ? 'shared' : `${layer}-${i}`));
  const search = jest.spyOn(ncbi, 'esearch').mockResolvedValueOnce({ count: 999, pmids: [] });
  pools.forEach((pmids) => search.mockResolvedValueOnce({ count: 100, pmids }));
  search.mockResolvedValueOnce({ count: 10, pmids: [] });
  const fetch = jest.spyOn(ncbi, 'efetchArticles').mockResolvedValue([]);
  jest.spyOn(skills, 'pickBoundaryCases').mockResolvedValue([]);
  const deps = { ...outsideInput(), retrieval: 'year-stratified' as const, sort: 'relevance' as const };
  const result = await searchOutsideCandidates(deps);
  expect(search).toHaveBeenCalledTimes(8);
  expect(search).toHaveBeenNthCalledWith(1, stratifiedMargin, deps.eutils, { retmax: 0 });
  stratifiedRanges.forEach((range, index) => expect(search).toHaveBeenNthCalledWith(index + 2,
    `(${stratifiedMargin}) AND (${range})`, deps.eutils, { retmax: allocations[index], sort: 'relevance' }));
  const expected = ['shared', ...Array.from({ length: 7 }, (_, i) => [5, 4, 3, 2, 1, 0].map((layer) => `${layer}-${i + 1}`)).flat(), '5-8', '4-8'];
  expect(result.stages?.retrievedPmids).toEqual(expected);
  expect(fetch).toHaveBeenCalledWith(expected.slice(0, 20), deps.eutils);
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
  expect(search.mock.calls.slice(1, 7).map((call) => call[2])).toEqual([0, 0, 0, 0, 1, 1].map((retmax) => ({ retmax })));
  expect(search).toHaveBeenCalledTimes(8);
});

test('指定式を拡張して NOT の右辺にも使い、全シードを除外し既定 50 / 20 件を保つ', async () => {
  const formula = { blocks: [{ id: '1', expression: 'best[tiab]', isCombination: false }], combinationExpression: null };
  jest.spyOn(skills, 'expandQueryForRecall').mockResolvedValue([{ blockId: '1', additions: [
    { term: 'outside[tiab]', axis: 'freeword', rationale: '別の用語' },
  ] }]);
  const search = jest.spyOn(ncbi, 'esearch').mockResolvedValue({ count: 50, pmids: ['existing', ...Array.from({ length: 30 }, (_, i) => String(i))] });
  const fetch = jest.spyOn(ncbi, 'efetchArticles').mockResolvedValue([]);
  jest.spyOn(skills, 'pickBoundaryCases').mockResolvedValue([]);
  const onProgress = jest.fn();
  const deps = { formula, researchQuestion: 'RQ', inclusionCriteria: '', exclusionCriteria: '', existingPmids: new Set(['existing']),
    eutils: { fetch: jest.fn() }, llmFactory: { model: 'fake', forPurpose: jest.fn() }, onProgress };
  await searchOutsideCandidates(deps);
  expect(search).toHaveBeenNthCalledWith(1, '((best[tiab]) OR outside[tiab]) NOT (best[tiab])', deps.eutils, { retmax: 50 });
  expect(search).toHaveBeenNthCalledWith(2, 'best[tiab]', deps.eutils, { retmax: 0 });
  expect(fetch.mock.calls[0]![0]).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
  expect(onProgress.mock.calls.map(([step]) => step)).toEqual(['broaden', 'esearch', 'dedup', 'efetch', 'pick-boundary']);
  expect(formula.blocks[0]!.expression).toBe('best[tiab]');
});

test('境界候補のプロンプトは出版年代・用語・介入（曝露）の多様性を求める', () => {
  expect(PICK_BOUNDARY_SYSTEM_PROMPT).toContain('出版年代・用語・介入（曝露）が偏らない');
  expect(PICK_BOUNDARY_SYSTEM_PROMPT).toContain('似た文献で候補を厚くせず');
});

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
    eutils: { fetch: jest.fn() }, llmFactory: { model: 'fake', forPurpose: jest.fn() }, skillCandidateLimit: 3, sort: 'relevance' as const };
  const result = await searchOutsideCandidates(deps);
  expect(expand).not.toHaveBeenCalled();
  expect(deps.llmFactory.forPurpose.mock.calls).toEqual([['pick_boundary']]);
  expect(search).toHaveBeenNthCalledWith(1, '((best[tiab]) OR outside[tiab]) NOT (best[tiab])', deps.eutils, { retmax: 50, sort: 'relevance' });
  expect(search).toHaveBeenNthCalledWith(2, 'best[tiab]', deps.eutils, { retmax: 0 });
  expect(fetch).toHaveBeenCalledWith(['2', '3', '4'], deps.eutils);
  expect(pick.mock.calls[0]![0].candidates.map((candidate) => candidate.pmid)).toEqual(['2', '4']);
  expect(result.stages).toEqual({ broadenedQuery: '(best[tiab]) OR outside[tiab]',
    marginQuery: '((best[tiab]) OR outside[tiab]) NOT (best[tiab])',
    retrievedPmids: ['1', '2', '3', '4', '5'], novelPmids: ['2', '3', '4', '5'],
    requestedPmids: ['2', '3', '4'], fetchedPmids: ['2', '4'], pickedPmids: ['4'] });
  expect(result.candidates.map((candidate) => candidate.pmid)).toEqual(['4']);
});

test.each([false, true])('早期リターンも段階を返す（拡張語なし: %s）', async (empty) => {
  const expand = jest.spyOn(skills, 'expandQueryForRecall');
  const search = jest.spyOn(ncbi, 'esearch').mockResolvedValue({ count: 10, pmids: ['1'] });
  const fetch = jest.spyOn(ncbi, 'efetchArticles');
  const result = await searchOutsideCandidates({
    formula: { blocks: [{ id: '1', expression: 'best[tiab]', isCombination: false }], combinationExpression: null },
    researchQuestion: 'RQ', inclusionCriteria: '', exclusionCriteria: '', existingPmids: new Set(['1']),
    additions: empty ? [] : [{ blockId: '1', additions: [{ term: 'outside[tiab]', axis: 'freeword', rationale: '' }] }],
    eutils: { fetch: jest.fn() }, llmFactory: { model: 'fake', forPurpose: jest.fn() },
  });
  expect(expand).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(search).toHaveBeenCalledTimes(empty ? 1 : 2);
  expect(result.stages).toEqual({ broadenedQuery: empty ? null : '(best[tiab]) OR outside[tiab]',
    marginQuery: empty ? null : '((best[tiab]) OR outside[tiab]) NOT (best[tiab])',
    retrievedPmids: empty ? [] : ['1'], novelPmids: [], requestedPmids: [], fetchedPmids: [], pickedPmids: [] });
});
