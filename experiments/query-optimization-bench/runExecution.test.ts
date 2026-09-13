/** @jest-environment node */
import { executeCase } from './run';
import { generateDraftFormula } from '../../src/app/services/draftService';
import { runQueryOptimization } from '../../src/app/services/queryOptimizationService';
import { extractProtocol } from '../../src/features/formula/skills/extractProtocol';
import { capturedGold, evaluateSearch, seedTitles } from './ncbiEval';
import type { BenchCase, GoldAudit, RunResult } from './types';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';

jest.mock('../../src/app/services/draftService', () => ({ generateDraftFormula: jest.fn() }));
jest.mock('../../src/app/services/queryOptimizationService', () => ({ runQueryOptimization: jest.fn() }));
jest.mock('../../src/features/formula/skills/extractProtocol', () => ({ extractProtocol: jest.fn() }));
jest.mock('./ncbiEval', () => ({ capturedGold: jest.fn(), evaluateSearch: jest.fn(), seedTitles: jest.fn(),
  createEvalFetch: jest.requireActual<typeof import('./ncbiEval')>('./ncbiEval').createEvalFetch }));

const groups = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, members: [{ studyId: id, pmids: [String(i + 1)] }], pmids: [String(i + 1)] }));
const fixture: BenchCase = { id: 'fake', pmcid: 'fake', searchDate: '2021-04-15', license: 'CC BY', protocolPath: 'protocol.md',
  gold: groups, heldOut: ['d'], seeds: { seed: 20260912, selections: groups.slice(0, 3).map((g) => ({ groupId: g.id, pmid: g.pmids[0]!, year: null })) } };
const audit: GoldAudit = { includedStudyCount: 4, includedPmidCount: 4, overlapPmids: [], sharedPmids: [], withoutPmid: [], unmappedPmids: [],
  publicationYears: {}, exclusions: { withoutPmid: 0, unresolvedMapping: 0, outsideDate: null }, manual_review: false, reviewNote: '', dateValidation: 'pending' };
const makeResult = (): RunResult => ({ id: 'fake', runId: 'fake-run', status: 'running', startedAt: '', model: 'fake', searchDate: fixture.searchDate,
  profileId: 'default', maxHits: 10000, maxIterations: 5, conditions: {}, apiCalls: { ncbi: 0, llm: 0 }, apiElapsedMs: { ncbi: 0, llm: 0 }, elapsedMs: 0, llmLogs: [] });
const formula = { blocks: [{ id: '1', expression: 'test[tiab]', isCombination: false }], combinationExpression: null };
const llmFactory: LlmProviderFactory = { model: 'fake', forPurpose: () => ({ model: 'fake', providerId: 'gemini', chat: jest.fn() }) };

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(capturedGold).mockResolvedValue(['1', '2', '3', '4']);
  jest.mocked(seedTitles).mockResolvedValue([{ pmid: '1', title: 'Seed' }]);
  jest.mocked(extractProtocol).mockResolvedValue({ frameworkType: 'custom', researchQuestion: 'RQ', inclusionCriteria: 'include', exclusionCriteria: '',
    studyDesign: 'any', blocks: [{ blockLabel: 'Concept', description: 'description' }], combinationExpression: '#1' });
  (generateDraftFormula as jest.Mock).mockResolvedValue({ formula });
  (runQueryOptimization as jest.Mock).mockResolvedValue({ status: 'needs_review', stopReason: 'iteration_limit', best: { formula },
    trials: [{ reason: 'reason', accepted: false }], iterations: 5, apiCalls: 1, elapsedMs: 1, unmetReasons: [] });
  jest.mocked(evaluateSearch).mockResolvedValue({ status: 'success', hits: 10, capturedPmids: ['4'] });
});

test('実 API 無しで C0 → C1 → B1 を配線し、段階ごとに保存する', async () => {
  const result = makeResult();
  const save = jest.fn();
  const fetch = jest.fn().mockRejectedValue(new Error('実 API 禁止'));
  await executeCase(fixture, audit, 'protocol', result, { eutils: { fetch }, llmFactory, progress: jest.fn(), save }, { query: 'baseline' });
  expect(result.status).toBe('completed');
  // denominator / C0 / C1(+B1) / (adoptionAudit + confirmation まとめて 1 回) の 4 段階 + B1 の 1 回。
  expect(save).toHaveBeenCalledTimes(5);
  expect(fetch).not.toHaveBeenCalled();
  expect(generateDraftFormula).toHaveBeenCalledWith(expect.objectContaining({ seedContext: expect.objectContaining({ titles: [] }) }), expect.anything());
  expect(runQueryOptimization).toHaveBeenCalledWith(expect.objectContaining({ maxHits: 10000, maxIterations: 5, seedPmids: ['1', '2', '3'] }), expect.objectContaining({ checkpoint: expect.anything(), fetchMeshContext: expect.any(Function) }));
  expect(result.optimization!.trials[0]!.reason).toBe('reason');
  expect(result.conditions.B1!.query).toBe('baseline');
  expect(result.conditions.C0!.metrics!.heldOutRecall).toBe(1);
  // c0 は live 生成扱い、seedSplit は fixture 埋め込みの既定分割（20260912）の id。
  expect(result.c0).toEqual({ source: 'live' });
  expect(result.seedSplit).toBe('s20260912');
});

test('deps.frozenC0 を渡すと extractProtocol/generateDraftFormula を呼ばず、凍結内容をそのまま C0 に使う', async () => {
  const result = makeResult();
  const frozenFormula = { blocks: [{ id: '1', expression: 'frozen[tiab]', isCombination: false }], combinationExpression: null };
  const frozenProtocol = { frameworkType: 'custom' as const, researchQuestion: 'frozen RQ', inclusionCriteria: 'frozen include',
    exclusionCriteria: '', studyDesign: 'any', sourceType: 'markdown' as const, sourceFilename: 'protocol.md',
    rawTextRef: null, rawTextPreview: 'protocol', rawTextInline: 'protocol' };
  const frozenBlocks = { blocks: [{ blockLabel: 'Concept', description: 'description', aiGenerated: true as const, note: '' }], combinationExpression: '#1' };
  await executeCase(fixture, audit, 'protocol', result, {
    eutils: { fetch: jest.fn() }, llmFactory, progress: jest.fn(), save: jest.fn(),
    frozenC0: { id: 'seeded-draft1', sha256: 'deadbeef', variant: 'seeded', draftIndex: 1,
      protocol: frozenProtocol, blocks: frozenBlocks, formula: frozenFormula },
  });
  expect(extractProtocol).not.toHaveBeenCalled();
  expect(generateDraftFormula).not.toHaveBeenCalled();
  expect(result.c0).toEqual({ source: 'frozen', id: 'seeded-draft1', sha256: 'deadbeef', variant: 'seeded', draftIndex: 1 });
  expect(result.conditions.C0!.formula).toEqual(frozenFormula);
  expect(runQueryOptimization).toHaveBeenCalledWith(expect.objectContaining({ initialFormula: frozenFormula,
    criteria: expect.objectContaining({ researchQuestion: 'frozen RQ' }) }), expect.anything());
});

test('deps.seeds で分割を上書きすると、その分割基準で heldOut と seedPmids を求める', async () => {
  const result = makeResult();
  const overrideSeeds = { seed: 999, selections: groups.slice(1, 4).map((g) => ({ groupId: g.id, pmid: g.pmids[0]!, year: null })) };
  await executeCase(fixture, audit, 'protocol', result, {
    eutils: { fetch: jest.fn() }, llmFactory, progress: jest.fn(), save: jest.fn(), seeds: overrideSeeds,
  });
  expect(result.seedSplit).toBe('s999');
  expect(result.denominator!.heldOut).toEqual(['a']);
  expect(runQueryOptimization).toHaveBeenCalledWith(expect.objectContaining({ seedPmids: ['2', '3', '4'] }), expect.anything());
});
test('範囲外の gold を先に除外し、範囲外シードは再抽選しない', async () => {
  jest.mocked(capturedGold).mockResolvedValue(['1', '2', '3']);
  const result = makeResult();
  jest.mocked(evaluateSearch).mockResolvedValue({ status: 'success', hits: 0, capturedPmids: [] });
  const deps = { eutils: { fetch: jest.fn() }, llmFactory, progress: jest.fn(), save: jest.fn() };
  await executeCase(fixture, audit, 'protocol', result, deps);
  expect(result.denominator!.outsideDateGroups).toEqual(['d']);
  expect(result.conditions.C0!.metrics!.heldOutRecall).toBeNull();
  jest.mocked(capturedGold).mockResolvedValue(['2', '3', '4']);
  await expect(executeCase(fixture, audit, 'protocol', makeResult(), deps)).rejects.toThrow('差し替え');
});
test('manual_review の群は自動採点せず、API 失敗も成績 0 にしない', async () => {
  const result = makeResult();
  const deps = { eutils: { fetch: jest.fn() }, llmFactory, progress: jest.fn(), save: jest.fn() };
  await executeCase(fixture, { ...audit, manual_review: true }, 'protocol', result, deps);
  expect(result.conditions.C0!.metrics).toBeNull();
  expect(result.comparison).toBeNull();
  jest.mocked(evaluateSearch).mockResolvedValue({ status: 'failure', error: 'offline' });
  const failed = makeResult();
  await executeCase(fixture, audit, 'protocol', failed, deps);
  expect(failed.status).toBe('failed');
  expect(failed.conditions.C0!.measurement.status).toBe('failure');
  expect(failed.conditions.C0!.metrics).toBeNull();
});


test('date filtering removes individual studies without in-range reports from a surviving group', async () => {
  const shared = { id: 'd + e', pmids: ['4', '5'], members: [
    { studyId: 'd', pmids: ['4', '5'] }, { studyId: 'e', pmids: ['5'] },
  ] };
  const result = makeResult();
  await executeCase({ ...fixture, gold: [...groups.slice(0, 3), shared], heldOut: [shared.id] }, audit, 'protocol', result,
    { eutils: { fetch: jest.fn() }, llmFactory, progress: jest.fn(), save: jest.fn() });
  expect(result.denominator!.groups[3]!.members).toEqual([{ studyId: 'd', pmids: ['4'] }]);
  expect(result.conditions.C0!.metrics).toMatchObject({ heldOutRecall: 1, allStudyRecall: 1 / 4, capturedStudies: ['d'] });
});

test('proposal measurements are saved after optimization using the same gold denominator', async () => {
  (runQueryOptimization as jest.Mock).mockResolvedValue({ status: 'needs_review', best: { formula },
    trials: [{ kind: 'proposal', candidateId: 'candidate', formula, accepted: false, changes: { removedTerms: ['broad'] } }] });
  const result = makeResult();
  const save = jest.fn();
  const fetch = jest.fn().mockRejectedValue(new Error('Real API forbidden'));
  await executeCase(fixture, audit, 'protocol', result, { eutils: { fetch }, llmFactory, progress: jest.fn(), save });
  expect(result.rejectedCandidates).toEqual([expect.objectContaining({ candidateId: 'candidate', accepted: false, hits: 10,
    metrics: result.conditions.C0!.metrics, comparedToC0: expect.objectContaining({ outcome: 'unchanged' }) })]);
  expect(jest.mocked(evaluateSearch).mock.calls.map((call) => call[1])).toEqual([
    ['1', '2', '3', '4'], ['1', '2', '3', '4'], ['1', '2', '3', '4'],
  ]);
  expect(save).toHaveBeenCalledTimes(5);
  expect(fetch).not.toHaveBeenCalled();
});

test('tight profile passes its registered limits to optimization without network', async () => {
  const result = { ...makeResult(), profileId: 'tight-1000' as const, maxHits: 1000 };
  const fetch = jest.fn().mockRejectedValue(new Error('Real API forbidden'));
  await executeCase(fixture, audit, 'protocol', result, { eutils: { fetch }, llmFactory, progress: jest.fn(), save: jest.fn() });
  expect(runQueryOptimization).toHaveBeenCalledWith(expect.objectContaining({ maxHits: 1000, maxIterations: 5 }), expect.anything());
  expect(fetch).not.toHaveBeenCalled();
});
