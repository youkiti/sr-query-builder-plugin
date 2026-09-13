import { searchOutsideCandidates } from './expandService';
import * as skills from '@/features/formula/skills';
import * as ncbi from '@/lib/ncbi';
import { PICK_BOUNDARY_SYSTEM_PROMPT } from '@/features/formula/skills/pickBoundaryCases';

afterEach(() => jest.restoreAllMocks());

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
