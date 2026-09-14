/** @jest-environment node */
import { executeCase, main, resultDir, type FrozenC0Input } from './run';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGitCommit } from './gitInfo';
import { hashC0Content, type C0Content } from './c0Artifact';
import { generateDraftFormula } from '../../src/app/services/draftService';
import { runQueryOptimization } from '../../src/app/services/queryOptimizationService';
import { extractProtocol } from '../../src/features/formula/skills/extractProtocol';
import { capturedGold, evaluateSearch, seedTitles } from './ncbiEval';
import type { BenchCase, GoldAudit, RunResult } from './types';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';

jest.mock('../../src/app/services/draftService', () => ({ generateDraftFormula: jest.fn() }));
jest.mock('../../src/app/services/queryOptimizationService', () => ({ runQueryOptimization: jest.fn() }));
jest.mock('../../src/features/formula/skills/extractProtocol', () => ({ extractProtocol: jest.fn() }));
jest.mock('./ncbiEval', () => ({ redact: jest.requireActual<typeof import('./ncbiEval')>('./ncbiEval').redact, capturedGold: jest.fn(), evaluateSearch: jest.fn(), seedTitles: jest.fn(),
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
  expect(save).toHaveBeenCalledTimes(4);
  expect(fetch).not.toHaveBeenCalled();
  expect(generateDraftFormula).toHaveBeenCalledWith(expect.objectContaining({ seedContext: expect.objectContaining({ titles: [] }) }), expect.anything());
  expect(runQueryOptimization).toHaveBeenCalledWith(expect.objectContaining({ maxHits: 10000, maxIterations: 5, seedPmids: ['1', '2', '3'] }), expect.objectContaining({ checkpoint: expect.anything(), fetchMeshContext: expect.any(Function) }));
  expect(result.optimization!.trials[0]!.reason).toBe('reason');
  expect(result.conditions.B1!.query).toBe('baseline');
  expect(result.conditions.C0!.metrics!.heldOutRecall).toBe(1);
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
  expect(save).toHaveBeenCalledTimes(4);
  expect(fetch).not.toHaveBeenCalled();
});

test('tight profile passes its registered limits to optimization without network', async () => {
  const result = { ...makeResult(), profileId: 'tight-1000' as const, maxHits: 1000 };
  const fetch = jest.fn().mockRejectedValue(new Error('Real API forbidden'));
  await executeCase(fixture, audit, 'protocol', result, { eutils: { fetch }, llmFactory, progress: jest.fn(), save: jest.fn() });
  expect(runQueryOptimization).toHaveBeenCalledWith(expect.objectContaining({ maxHits: 1000, maxIterations: 5 }), expect.anything());
  expect(fetch).not.toHaveBeenCalled();
});
jest.mock('./gitInfo', () => ({ getGitCommit: jest.fn(() => 'legacy-commit'), isGitDirty: () => true }));

const frozen: FrozenC0Input = { id: 'frozen', sha256: 'hash', variant: 'criteria-only', draftIndex: 1,
  protocol: { frameworkType: 'custom', researchQuestion: 'frozen RQ', inclusionCriteria: 'frozen include', exclusionCriteria: '',
    studyDesign: 'any', sourceType: 'markdown', sourceFilename: 'protocol.md', rawTextRef: null, rawTextPreview: '', rawTextInline: '' },
  blocks: { blocks: [{ blockLabel: 'Frozen block', description: '', aiGenerated: true, note: '' }], combinationExpression: '#1' },
  formula };

test('凍結 C0 では生成を呼ばず、指定シードの held-out と2000件上限を使う', async () => {
  const result = { ...makeResult(), profileId: 'rerun-2000' as const, maxHits: 2000 };
  const seeds = { name: 'alternate', selections: groups.slice(1).map((g) => ({ groupId: g.id, pmid: g.pmids[0]!, year: null })) };
  await executeCase(fixture, audit, '', result,
    { eutils: { fetch: jest.fn() }, llmFactory, progress: jest.fn(), save: jest.fn(), seeds, frozenC0: frozen });
  expect(extractProtocol).not.toHaveBeenCalled();
  expect(generateDraftFormula).not.toHaveBeenCalled();
  expect(result.denominator!.heldOut).toEqual(['a']);
  expect(result.conditions.C0!.formula).toEqual(formula);
  expect(result.c0).toEqual({ source: 'frozen', id: 'frozen', sha256: 'hash', variant: 'criteria-only', draftIndex: 1 });
  expect(runQueryOptimization).toHaveBeenCalledWith(expect.objectContaining({ initialFormula: formula, seedPmids: ['2', '3', '4'],
    maxHits: 2000, maxIterations: 5, criteria: expect.objectContaining({ researchQuestion: 'frozen RQ' }),
    approvedBlocks: [expect.objectContaining({ label: 'Frozen block' })] }), expect.anything());
});

test('main は試行と最新結果にメタデータを保存し、別コミットの完了結果を書き換えない', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-execution-'));
  const fixtureDir = join(root, fixture.id);
  mkdirSync(join(fixtureDir, 'c0'), { recursive: true });
  writeFileSync(join(fixtureDir, 'case.json'), JSON.stringify({ ...fixture, searchDate: '2001-02-03' }));
  writeFileSync(join(fixtureDir, 'audit.json'), JSON.stringify(audit));
  writeFileSync(join(fixtureDir, 'protocol.md'), 'protocol');
  writeFileSync(join(fixtureDir, 'seeds.json'), JSON.stringify(fixture.seeds));
  const content: C0Content = { schemaVersion: 1, caseId: fixture.id, variant: frozen.variant, draftIndex: 1, seedSplit: null,
    targetHits: 2000, model: 'fake', createdAt: '', gitCommit: null, gitDirty: null, protocol: frozen.protocol,
    blocks: frozen.blocks, formula, formulaMd: '', seedContext: null, blockApproval: 'auto' };
  writeFileSync(join(fixtureDir, 'c0', 'frozen.json'), JSON.stringify({ ...content, sha256: hashC0Content(content) }));
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'mock-only';
  jest.mocked(getGitCommit).mockReturnValue('legacy-commit');
  const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実 API 禁止'));
  const args = ['--fixtures', root, '--results', join(root, 'results'), '--case', fixture.id, '--c0', 'frozen',
    '--profile', 'rerun-2000', '--label', 'legacy'];
  try {
    await main(args);
    const dir = resultDir(join(root, 'results'), 'rerun-2000', fixture.id, 'frozen', 's20260912', 'legacy');
    const path = join(dir, 'run.json');
    const text = readFileSync(path, 'utf8');
    const result = JSON.parse(text) as RunResult;
    expect(result).toMatchObject({ status: 'completed', searchDate: '2001-02-03', gitCommit: 'legacy-commit', gitDirty: true,
      seedSplit: 's20260912', label: 'legacy', legacy: true, c0: { source: 'frozen', id: 'frozen', sha256: hashC0Content(content) } });
    expect(readFileSync(join(dir, result.runId, 'run.json'), 'utf8')).toBe(text);
    await main(args);
    expect(runQueryOptimization).toHaveBeenCalledTimes(1);
    jest.mocked(getGitCommit).mockReturnValue('other-commit');
    await main(args);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(process.exitCode).toBe(1);
    writeFileSync(path, JSON.stringify({ ...result, status: 'failed' }));
    process.exitCode = 0;
    await main(args);
    expect(runQueryOptimization).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    fetch.mockRestore();
    process.exitCode = 0;
  }
});
