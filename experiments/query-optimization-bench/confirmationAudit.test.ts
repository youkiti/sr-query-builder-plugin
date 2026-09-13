/** @jest-environment node */
import { computeConfirmation } from './confirmationAudit';
import { searchOutsideCandidates } from '../../src/app/services/expandService';
import type { RunResult, StudyGroup } from './types';
import type { EutilsDeps } from '../../src/lib/ncbi/eutils';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';
import type { OptimizationTrial } from '../../src/features/formula/skills/optimizeQuery';

jest.mock('../../src/app/services/expandService', () => ({ searchOutsideCandidates: jest.fn() }));

const groups: StudyGroup[] = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, members: [{ studyId: id, pmids: [String(i + 1)] }], pmids: [String(i + 1)] }));
const heldOut = ['d', 'e'];
const seedPmids = ['1', '2', '3'];
const protocol = { researchQuestion: 'RQ', inclusionCriteria: 'include', exclusionCriteria: 'exclude' };
const deps = { eutils: { fetch: jest.fn() } as EutilsDeps, llmFactory: { model: 'fake', forPurpose: () => ({ model: 'fake', providerId: 'gemini' as const, chat: jest.fn() }) } as LlmProviderFactory };
const bestFormula = { blocks: [{ id: '1', expression: 'best[tiab]', isCombination: false }], combinationExpression: null };
const heldTrial = (impactPmids: string[]): OptimizationTrial => ({
  candidateId: 'held-1', accepted: false, held: true, kind: 'proposal', formula: bestFormula, apiEvents: [], before: null, after: null,
  reason: 'r', rationale: 'r', impact: { lostHits: 1, gainedHits: 0, error: null, inspected: impactPmids.map((pmid) => ({ pmid, title: null, year: null })) },
});

const makeResult = (overrides: Partial<RunResult> = {}): RunResult => ({
  id: 'fake', runId: 'run', status: 'running', startedAt: '', model: 'fake', searchDate: '2021-04-15',
  profileId: 'default', maxHits: 2000, maxIterations: 5, apiCalls: { ncbi: 0, llm: 0 }, apiElapsedMs: { ncbi: 0, llm: 0 }, elapsedMs: 0, llmLogs: [],
  denominator: { groups, heldOut, outsideDatePmids: [], outsideDateGroups: [], manualReviewPending: false },
  conditions: {},
  optimization: { status: 'achieved', stopReason: 'conditions_met', best: { formula: bestFormula, evaluation: {} as never, measurement: {} as never },
    unmetReasons: [], iterations: 1, apiCalls: 0, elapsedMs: 0, trials: [] },
  ...overrides,
});

beforeEach(() => jest.resetAllMocks());

test('最良式が無い、または achieved/needs_review でなければ skipped', async () => {
  const noBest = makeResult({ optimization: { status: 'stopped', stopReason: 'user_stop', best: null, unmetReasons: [], iterations: 0, apiCalls: 0, elapsedMs: 0, trials: [] } });
  expect(await computeConfirmation(noBest, protocol, seedPmids, deps)).toMatchObject({ status: 'skipped' });
  expect(searchOutsideCandidates).not.toHaveBeenCalled();
});

test('候補は seed PMID だけを既知集合として渡す（gold の held-out は渡さない）', async () => {
  jest.mocked(searchOutsideCandidates).mockResolvedValue({ mode: 'margin', candidates: [], originalHits: 0, broadenedHits: 0,
    marginHits: 5, evaluatedCount: 0, additions: [], insideStrategy: null, specific: null });
  await computeConfirmation(makeResult(), protocol, seedPmids, deps);
  const call = jest.mocked(searchOutsideCandidates).mock.calls[0]![0];
  expect(call.existingPmids).toEqual(new Set(seedPmids));
  // gold の held-out（4, 5）や、その他の gold PMID が existingPmids に紛れ込んでいないことを確認する。
  for (const pmid of ['4', '5']) expect(call.existingPmids.has(pmid)).toBe(false);
});

test('outsidePmids と held 候補の inspected（シード除く）を dedup して集計し、held-out 群へ対応付ける', async () => {
  const result = makeResult({ optimization: { status: 'achieved', stopReason: 'conditions_met',
    best: makeResult().optimization!.best, unmetReasons: [], iterations: 1, apiCalls: 0, elapsedMs: 0,
    trials: [heldTrial(['6', '1']), { ...heldTrial([]), candidateId: 'not-held', held: false, impact: undefined }] } });
  jest.mocked(searchOutsideCandidates).mockResolvedValue({ mode: 'margin', candidates: [{ pmid: '4', title: null, year: null, reason: 'r', abstract: null, meshHeadings: [] },
    { pmid: '7', title: null, year: null, reason: 'r', abstract: null, meshHeadings: [] }],
    originalHits: 10, broadenedHits: 15, marginHits: 5, evaluatedCount: 2, additions: [], insideStrategy: null, specific: null });

  const confirmation = await computeConfirmation(result, protocol, seedPmids, deps);
  expect(confirmation.status).toBe('ready');
  expect(confirmation.marginHits).toBe(5);
  expect(confirmation.outsidePmids).toEqual(['4', '7']);
  expect(confirmation.lostInspectedPmids).toEqual(['6']); // '1' はシードなので除外
  expect(confirmation.total).toBe(3); // {4,7,6}
  expect(confirmation.heldOutStudiesAmongCandidates).toEqual(['d']); // pmid 4 = d。5(e) は候補に含まれない
  expect(confirmation.nonGoldCandidates).toBe(2); // 6, 7 は gold に無い
});

test('outside check が失敗しても run を failed にせず、error ステータスと理由を残す（held 候補の集計は保持）', async () => {
  const result = makeResult({ optimization: { status: 'needs_review', stopReason: 'iteration_limit',
    best: makeResult().optimization!.best, unmetReasons: [], iterations: 1, apiCalls: 0, elapsedMs: 0, trials: [heldTrial(['6'])] } });
  jest.mocked(searchOutsideCandidates).mockRejectedValue(new Error('NCBI down'));
  const confirmation = await computeConfirmation(result, protocol, seedPmids, deps);
  expect(confirmation.status).toBe('error');
  expect(confirmation.reason).toBe('NCBI down');
  expect(confirmation.lostInspectedPmids).toEqual(['6']);
  expect(confirmation.total).toBe(1);
});
