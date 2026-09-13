/** @jest-environment node */
import { computeAdoptionAudit } from './adoptionAudit';
import { evaluateSearch } from './ncbiEval';
import { calculateMetrics } from './metrics';
import type { RunResult, StudyGroup } from './types';
import type { EutilsDeps } from '../../src/lib/ncbi/eutils';
import type { OptimizationTrial } from '../../src/features/formula/skills/optimizeQuery';

jest.mock('./ncbiEval', () => ({ evaluateSearch: jest.fn(),
  createEvalFetch: jest.requireActual<typeof import('./ncbiEval')>('./ncbiEval').createEvalFetch }));

const groups: StudyGroup[] = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, members: [{ studyId: id, pmids: [String(i + 1)] }], pmids: [String(i + 1)] }));
const heldOut = ['d', 'e'];
const eutils: EutilsDeps = { fetch: jest.fn() };
const formulaFor = (label: string) => ({ blocks: [{ id: '1', expression: `${label}[tiab]`, isCombination: false }], combinationExpression: null });

const makeResult = (manualReviewPending = false): RunResult => ({
  id: 'fake', runId: 'run', status: 'running', startedAt: '', model: 'fake', searchDate: '2021-04-15',
  profileId: 'default', maxHits: 2000, maxIterations: 5, apiCalls: { ncbi: 0, llm: 0 }, apiElapsedMs: { ncbi: 0, llm: 0 }, elapsedMs: 0, llmLogs: [],
  denominator: { groups, heldOut, outsideDatePmids: [], outsideDateGroups: [], manualReviewPending },
  conditions: { C0: { query: 'c0', formula: formulaFor('c0'), measurement: { status: 'success', hits: 100, capturedPmids: ['1', '2', '3', '4'] },
    metrics: calculateMetrics(groups, heldOut, ['1', '2', '3', '4'], 100) } },
});

const trial = (candidateId: string, accepted: boolean, formula: ReturnType<typeof formulaFor>, held = false): OptimizationTrial => ({
  candidateId, accepted, held, kind: 'proposal', formula, apiEvents: [], before: null, after: null, reason: 'r', rationale: 'r',
});

beforeEach(() => jest.resetAllMocks());

test('候補が無ければ 0 件・harmfulAdopted 0（manualReviewPending なら null）で即座に返す', async () => {
  expect(await computeAdoptionAudit(makeResult(), eutils)).toEqual({ adopted: 0, harmfulAdopted: 0, trials: [] });
  expect(await computeAdoptionAudit(makeResult(true), eutils)).toEqual({ adopted: 0, harmfulAdopted: null, trials: [] });
  expect(evaluateSearch).not.toHaveBeenCalled();
});

test('採用 → 採用の連続で、2 件目が held-out を失えば有害採用として数える（C0 の既存測定は再利用）', async () => {
  const result = makeResult();
  result.optimization = { status: 'achieved', stopReason: 'conditions_met', best: null, unmetReasons: [], iterations: 2, apiCalls: 0, elapsedMs: 0,
    trials: [
      trial('candidate-1', true, formulaFor('c1')),
      trial('candidate-2', true, formulaFor('c2')),
    ] };
  jest.mocked(evaluateSearch)
    .mockResolvedValueOnce({ status: 'success', hits: 110, capturedPmids: ['1', '2', '3', '4', '5'] }) // candidate-1: d,e とも捕捉
    .mockResolvedValueOnce({ status: 'success', hits: 90, capturedPmids: ['1', '2', '3', '5'] }); // candidate-2: d を失う

  const audit = await computeAdoptionAudit(result, eutils);
  expect(evaluateSearch).toHaveBeenCalledTimes(2); // C0 は再利用、before=candidate-1 も採用時に得た値を再利用
  expect(audit.adopted).toBe(2);
  expect(audit.harmfulAdopted).toBe(1);
  expect(audit.trials).toEqual([
    expect.objectContaining({ candidateId: 'candidate-1', accepted: true, hitsBefore: 100, hitsAfter: 110, lostHeldOut: [], gainedHeldOut: ['e'] }),
    expect.objectContaining({ candidateId: 'candidate-2', accepted: true, hitsBefore: 110, hitsAfter: 90, lostHeldOut: ['d'], gainedHeldOut: [] }),
  ]);
});

test('却下候補は rejectedCandidates の既存計測を再利用し、追加の gold 検索をしない', async () => {
  const result = makeResult();
  result.optimization = { status: 'needs_review', stopReason: 'iteration_limit', best: null, unmetReasons: [], iterations: 1, apiCalls: 0, elapsedMs: 0,
    trials: [trial('candidate-rejected', false, formulaFor('rejected'))] };
  const reusedMetrics = calculateMetrics(groups, heldOut, ['1', '2', '3'], 80); // d, e を失う却下候補
  result.rejectedCandidates = [{ candidateId: 'candidate-rejected', accepted: false, changes: null, hits: 80, metrics: reusedMetrics, comparedToC0: null }];

  const audit = await computeAdoptionAudit(result, eutils);
  expect(evaluateSearch).not.toHaveBeenCalled();
  expect(audit.adopted).toBe(0);
  expect(audit.harmfulAdopted).toBe(0); // 却下されたので有害「採用」ではない
  expect(audit.trials[0]).toMatchObject({ candidateId: 'candidate-rejected', accepted: false, hitsBefore: 100, hitsAfter: 80, lostHeldOut: ['d'] });
});

test('manualReviewPending では採点を保留する(metrics を作らず harmfulAdopted は null)', async () => {
  const result = makeResult(true);
  result.optimization = { status: 'achieved', stopReason: 'conditions_met', best: null, unmetReasons: [], iterations: 1, apiCalls: 0, elapsedMs: 0,
    trials: [trial('candidate-1', true, formulaFor('c1'))] };
  jest.mocked(evaluateSearch).mockResolvedValue({ status: 'success', hits: 50, capturedPmids: ['1'] });
  const audit = await computeAdoptionAudit(result, eutils);
  expect(audit.harmfulAdopted).toBeNull();
  expect(audit.trials[0]).toMatchObject({ hitsBefore: 100, hitsAfter: 50, lostHeldOut: [], gainedHeldOut: [] });
});

test('計測失敗は 0 件喪失として扱わず error を記録し、harmfulAdopted には数えない', async () => {
  const result = makeResult();
  result.optimization = { status: 'achieved', stopReason: 'conditions_met', best: null, unmetReasons: [], iterations: 1, apiCalls: 0, elapsedMs: 0,
    trials: [trial('candidate-1', true, formulaFor('c1'))] };
  jest.mocked(evaluateSearch).mockResolvedValue({ status: 'failure', error: 'NCBI offline' });
  const audit = await computeAdoptionAudit(result, eutils);
  expect(audit.harmfulAdopted).toBe(0); // 失敗を安全（0 件喪失）とは数えない
  expect(audit.trials[0]).toMatchObject({ hitsAfter: null, lostHeldOut: [], error: 'NCBI offline' });
});

test('denominator が無ければ例外を投げる', async () => {
  const result = makeResult();
  delete result.denominator;
  result.optimization = { status: 'achieved', stopReason: 'conditions_met', best: null, unmetReasons: [], iterations: 1, apiCalls: 0, elapsedMs: 0,
    trials: [trial('candidate-1', true, formulaFor('c1'))] };
  await expect(computeAdoptionAudit(result, eutils)).rejects.toThrow('分母');
});
