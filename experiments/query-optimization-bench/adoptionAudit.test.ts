/** @jest-environment node */
import { computeAdoptionAudit } from './adoptionAudit';
import { evaluateSearch } from './ncbiEval';
import { calculateMetrics } from './metrics';
import { measureRejectedCandidates } from './run';
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

test.each([false, true])('採用→保留→却下の直前比は採否監査と一致し、計測済み候補を再利用する: %s', async (reuse) => {
  const result = makeResult();
  result.optimization = { status: 'needs_review', stopReason: 'iteration_limit', best: null, unmetReasons: [], iterations: 3,
    apiCalls: 0, elapsedMs: 0, trials: [trial('採用', true, formulaFor('accepted')),
      trial('保留', false, formulaFor('held'), true), trial('却下', false, formulaFor('rejected'))] };
  const acceptedMetrics = calculateMetrics(groups, heldOut, ['1', '2', '3', '4', '5'], 200);
  if (reuse) result.rejectedCandidates = [{ candidateId: '採用', accepted: true, changes: null, hits: 200,
    metrics: acceptedMetrics, priorId: 'C0', comparedToPrior: null, comparedToC0: null }];
  else jest.mocked(evaluateSearch).mockResolvedValueOnce({ status: 'success', hits: 200, capturedPmids: ['1', '2', '3', '4', '5'] });
  jest.mocked(evaluateSearch)
    .mockResolvedValueOnce({ status: 'success', hits: 150, capturedPmids: ['1', '2', '3', '4'] })
    .mockResolvedValueOnce({ status: 'success', hits: 120, capturedPmids: ['1', '2', '3', '4'] });
  const measured = await measureRejectedCandidates(result, eutils);
  expect(evaluateSearch).toHaveBeenCalledTimes(reuse ? 2 : 3);
  if (!reuse) expect(measured[0]!.priorId).toBe('C0');
  for (const candidate of measured.filter((item) => !item.accepted)) {
    expect(candidate.priorId).toBe('採用');
    expect(candidate.comparedToPrior).toMatchObject({ lostHeldOut: ['e'], lostReports: ['5'], outcome: 'tradeoff' });
    expect(candidate.comparedToC0).toMatchObject({ lostHeldOut: [], lostReports: [], outcome: 'worse' });
  }
  result.rejectedCandidates = [...result.rejectedCandidates ?? [], ...measured];
  const audit = await computeAdoptionAudit(result, eutils);
  for (const candidate of measured) {
    const row = audit.trials.find((item) => item.candidateId === candidate.candidateId)!;
    const before = candidate.priorId === 'C0' ? result.conditions.C0!.metrics! : acceptedMetrics;
    expect(row.hitsBefore).toBe(before.hits);
    expect(row.lostHeldOut).toEqual(candidate.comparedToPrior!.lostHeldOut);
  }
  expect(evaluateSearch).toHaveBeenCalledTimes(reuse ? 2 : 3);
});

test('採用がない場合は全候補が C0 比で、比較元欠測は null になる', async () => {
  const result = makeResult();
  result.optimization = { status: 'needs_review', stopReason: 'iteration_limit', best: null, unmetReasons: [], iterations: 2,
    apiCalls: 0, elapsedMs: 0, trials: [trial('保留', false, formulaFor('held'), true), trial('却下', false, formulaFor('rejected'))] };
  jest.mocked(evaluateSearch).mockResolvedValue({ status: 'success', hits: 90, capturedPmids: ['4'] });
  const measured = await measureRejectedCandidates(result, eutils);
  for (const candidate of measured) {
    expect(candidate.priorId).toBe('C0');
    expect(candidate.comparedToPrior).toEqual(candidate.comparedToC0);
  }
  result.conditions.C0!.metrics = null;
  expect((await measureRejectedCandidates(result, eutils))[0]!.comparedToPrior).toBeNull();
});

test('候補が無ければ 0 件・harmfulAdopted 0（manualReviewPending なら null）で即座に返す', async () => {
  expect(await computeAdoptionAudit(makeResult(), eutils)).toEqual({ adopted: 0, unscoredAdopted: 0, harmfulAdopted: 0, trials: [] });
  expect(await computeAdoptionAudit(makeResult(true), eutils)).toEqual({ adopted: 0, unscoredAdopted: 0, harmfulAdopted: null, trials: [] });
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
  result.rejectedCandidates = [{ candidateId: 'candidate-rejected', accepted: false, changes: null, hits: 80, metrics: reusedMetrics,
    comparedToC0: null, priorId: 'C0', comparedToPrior: null }];

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

test('計測失敗は error と未採点件数を記録し、harmfulAdopted を null にする', async () => {
  const result = makeResult();
  result.optimization = { status: 'achieved', stopReason: 'conditions_met', best: null, unmetReasons: [], iterations: 1, apiCalls: 0, elapsedMs: 0,
    trials: [trial('candidate-1', true, formulaFor('c1'))] };
  jest.mocked(evaluateSearch).mockResolvedValue({ status: 'failure', error: 'NCBI offline' });
  const audit = await computeAdoptionAudit(result, eutils);
  expect(audit.harmfulAdopted).toBeNull();
  expect(audit.unscoredAdopted).toBe(1);
  expect(audit.trials[0]).toMatchObject({ hitsAfter: null, lostHeldOut: [], error: 'NCBI offline' });
});

test('denominator が無ければ例外を投げる', async () => {
  const result = makeResult();
  delete result.denominator;
  result.optimization = { status: 'achieved', stopReason: 'conditions_met', best: null, unmetReasons: [], iterations: 1, apiCalls: 0, elapsedMs: 0,
    trials: [trial('candidate-1', true, formulaFor('c1'))] };
  await expect(computeAdoptionAudit(result, eutils)).rejects.toThrow('分母');
});

test('採用候補の測定失敗は次の採用でも比較元欠測として記録する', async () => {
  const result = makeResult();
  result.optimization = { status: 'achieved', stopReason: 'conditions_met', best: null, unmetReasons: [], iterations: 2, apiCalls: 0, elapsedMs: 0,
    trials: [trial('candidate-1', true, formulaFor('c1')), trial('candidate-2', true, formulaFor('c2'))] };
  jest.mocked(evaluateSearch)
    .mockResolvedValueOnce({ status: 'failure', error: 'NCBI offline' })
    .mockResolvedValueOnce({ status: 'success', hits: 90, capturedPmids: ['1', '2', '3', '4'] });
  const audit = await computeAdoptionAudit(result, eutils);
  expect(audit).toMatchObject({ adopted: 2, unscoredAdopted: 2, harmfulAdopted: null });
  expect(audit.trials[0]).toMatchObject({ error: 'NCBI offline' });
  expect(audit.trials[1]).toMatchObject({ hitsAfter: 90, error: '比較元 candidate-1 の測定が欠測: NCBI offline' });
});

test('比較可能な有害採用があっても比較不能な採用があれば全体を未採点にする', async () => {
  const result = makeResult();
  result.optimization = { status: 'achieved', stopReason: 'conditions_met', best: null, unmetReasons: [], iterations: 2, apiCalls: 0, elapsedMs: 0,
    trials: [trial('candidate-1', true, formulaFor('c1')), trial('candidate-2', true, formulaFor('c2'))] };
  jest.mocked(evaluateSearch)
    .mockResolvedValueOnce({ status: 'success', hits: 90, capturedPmids: ['1', '2', '3'] })
    .mockResolvedValueOnce({ status: 'failure', error: 'NCBI offline' });
  const audit = await computeAdoptionAudit(result, eutils);
  expect(audit).toMatchObject({ adopted: 2, unscoredAdopted: 1, harmfulAdopted: null });
  expect(audit.trials[0]).toMatchObject({ lostHeldOut: ['d'] });
});

test.each(['C0', 'C1'] as const)('%s のキャッシュでも測定失敗の原因を保持する', async (condition) => {
  const result = makeResult();
  result.conditions[condition] = { query: condition, formula: formulaFor(condition),
    measurement: { status: 'failure', error: 'NCBI offline' }, metrics: null };
  result.optimization = { status: 'achieved', stopReason: 'conditions_met', best: null, unmetReasons: [], iterations: 1, apiCalls: 0, elapsedMs: 0,
    trials: [trial('candidate-1', true, formulaFor('c1'))] };
  jest.mocked(evaluateSearch).mockResolvedValue({ status: 'success', hits: 90, capturedPmids: ['4'] });
  const audit = await computeAdoptionAudit(result, eutils);
  expect(audit).toMatchObject({ adopted: 1, unscoredAdopted: 1, harmfulAdopted: null });
  expect(audit.trials[0]!.error).toBe(condition === 'C0' ? '比較元 C0 の測定が欠測: NCBI offline' : 'NCBI offline');
  expect(evaluateSearch).toHaveBeenCalledTimes(condition === 'C0' ? 1 : 0);
});

test('手動監査待ちだけによる比較元欠測は error にしない', async () => {
  const result = makeResult(true);
  result.conditions.C0!.metrics = null;
  result.optimization = { status: 'achieved', stopReason: 'conditions_met', best: null, unmetReasons: [], iterations: 2, apiCalls: 0, elapsedMs: 0,
    trials: [trial('candidate-1', true, formulaFor('c1')), trial('candidate-2', true, formulaFor('c2'))] };
  jest.mocked(evaluateSearch).mockResolvedValue({ status: 'success', hits: 90, capturedPmids: ['4'] });
  const audit = await computeAdoptionAudit(result, eutils);
  expect(audit).toMatchObject({ adopted: 2, unscoredAdopted: 2, harmfulAdopted: null });
  for (const item of audit.trials) expect(item).not.toHaveProperty('error');
});
