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
