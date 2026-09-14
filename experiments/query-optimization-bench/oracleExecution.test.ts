/** @jest-environment node */
import { decideExisting, executeCase, main, parseArgs } from './run';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDraftFormula } from '../../src/app/services/draftService';
import { runQueryOptimization } from '../../src/app/services/queryOptimizationService';
import { extractProtocol } from '../../src/features/formula/skills/extractProtocol';
import { searchOutsideCandidates } from '../../src/app/services/expandService';
import * as confirmationAudit from './confirmationAudit';
import { capturedGold, evaluateSearch, seedTitles } from './ncbiEval';
import type { BenchCase, GoldAudit, RunResult } from './types';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';

jest.mock('../../src/app/services/expandService', () => ({ searchOutsideCandidates: jest.fn() }));
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('../../src/app/services/draftService', () => ({ generateDraftFormula: jest.fn() }));
jest.mock('../../src/app/services/queryOptimizationService', () => ({ runQueryOptimization: jest.fn() }));
jest.mock('../../src/features/formula/skills/extractProtocol', () => ({ extractProtocol: jest.fn() }));
jest.mock('./ncbiEval', () => ({ capturedGold: jest.fn(), evaluateSearch: jest.fn(), seedTitles: jest.fn(),
  ...Object.fromEntries(['redact', 'observeBackoff', 'observeRateLimiter'].map((key) => [key, jest.requireActual('./ncbiEval')[key]])),
  createEvalFetch: jest.requireActual<typeof import('./ncbiEval')>('./ncbiEval').createEvalFetch }));

const groups = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ({ id, members: [{ studyId: id, pmids: [String(i + 1)] }], pmids: [String(i + 1)] }));
const fixture: BenchCase = { id: 'fake', pmcid: 'fake', searchDate: '2021-04-15', license: 'CC BY', protocolPath: 'protocol.md',
  gold: groups, heldOut: ['d'], seeds: { seed: 20260912, selections: groups.slice(0, 3).map((g) => ({ groupId: g.id, pmid: g.pmids[0]!, year: null })) } };
const audit: GoldAudit = { includedStudyCount: 4, includedPmidCount: 4, overlapPmids: [], sharedPmids: [], withoutPmid: [], unmappedPmids: [],
  publicationYears: {}, exclusions: { withoutPmid: 0, unresolvedMapping: 0, outsideDate: null }, manual_review: false, reviewNote: '', dateValidation: 'pending' };
const makeResult = (): RunResult => ({ id: 'fake', runId: 'fake-run', status: 'running', startedAt: '', model: 'fake', searchDate: fixture.searchDate,
  profileId: 'default', maxHits: 10000, maxIterations: 5, conditions: {}, apiCalls: { ncbi: 0, llm: 0 }, apiElapsedMs: { ncbi: 0, llm: 0 }, elapsedMs: 0, llmLogs: [] });
const formula = { blocks: [{ id: '1', expression: 'test[tiab]', isCombination: false }], combinationExpression: null };
const llmFactory: LlmProviderFactory = { model: 'fake', forPurpose: () => ({ model: 'fake', providerId: 'gemini', chat: jest.fn() }) };

beforeEach(() => {
  jest.restoreAllMocks();
  jest.resetAllMocks();
  (searchOutsideCandidates as jest.Mock).mockResolvedValue({ candidates: [], marginHits: 0 });
  jest.mocked(capturedGold).mockResolvedValue(['1', '2', '3', '4', '5', '6']);
  jest.mocked(seedTitles).mockResolvedValue([{ pmid: '1', title: 'Seed' }]);
  jest.mocked(extractProtocol).mockResolvedValue({ frameworkType: 'custom', researchQuestion: 'RQ', inclusionCriteria: 'include', exclusionCriteria: '',
    studyDesign: 'any', blocks: [{ blockLabel: 'Concept', description: 'description' }], combinationExpression: '#1' });
  (generateDraftFormula as jest.Mock).mockResolvedValue({ formula });
  (runQueryOptimization as jest.Mock).mockResolvedValue({ status: 'needs_review', stopReason: 'iteration_limit', best: { formula },
    trials: [{ reason: 'reason', accepted: false }], iterations: 5, apiCalls: 1, elapsedMs: 1, unmetReasons: [] });
  jest.mocked(evaluateSearch).mockResolvedValue({ status: 'success', hits: 10, capturedPmids: ['4'] });
});

const deps = () => ({ eutils: { fetch: jest.fn().mockRejectedValue(new Error('実 API 禁止')) },
  llmFactory, progress: jest.fn(), save: jest.fn(), writeOracleRound: jest.fn() });
const outside = (...pmids: string[]) => ({ candidates: pmids.map((pmid) => ({ pmid })), marginHits: pmids.length });

test('基本 run が failed ならラウンドを回さない', async () => {
  (runQueryOptimization as jest.Mock).mockResolvedValue({ status: 'error', best: { formula }, trials: [] });
  const result = { ...makeResult(), oracleRounds: 2 };
  await executeCase(fixture, audit, 'protocol', result, deps());
  expect(result.status).toBe('failed');
  expect(result.oracle).toBeUndefined();
  expect(runQueryOptimization).toHaveBeenCalledTimes(1);
});

test('引数の範囲と replay 併用を検証する', () => {
  expect(parseArgs([]).oracleRounds).toBe(0);
  for (const n of ['0', '1', '2']) expect(parseArgs(['--oracle-rounds', n]).oracleRounds).toBe(Number(n));
  for (const n of ['-1', '3', '1.5', 'NaN', '']) expect(() => parseArgs(['--oracle-rounds', n])).toThrow('oracle-rounds');
  expect(() => parseArgs(['--oracle-rounds'])).toThrow();
  expect(() => parseArgs(['--oracle-rounds', '0', '--c0', 'draft', '--replay', 'fixed'])).toThrow('併用');
});

test('0 ラウンドは従来の段階・保存回数を保ち oracle を設定しない', async () => {
  const result = makeResult();
  const d = deps();
  await executeCase(fixture, audit, 'protocol', result, d);
  expect(result.oracleRounds).toBe(0);
  expect(result.oracle).toBeUndefined();
  expect(runQueryOptimization).toHaveBeenCalledTimes(1);
  expect(d.save).toHaveBeenCalledTimes(4);
  expect(d.writeOracleRound).not.toHaveBeenCalled();
  expect(result.status).toBe('completed');
});

test('提示 ∩ 日付内 gold − シードを include し、同じ設定と更新書誌で直前の最良式から再調整する', async () => {
  const nextFormula = { ...formula, blocks: [{ ...formula.blocks[0]!, expression: 'next[tiab]' }] };
  const lastFormula = { ...formula, blocks: [{ ...formula.blocks[0]!, expression: 'last[tiab]' }] };
  (runQueryOptimization as jest.Mock)
    .mockResolvedValueOnce({ status: 'needs_review', best: { formula }, trials: [
      { kind: 'proposal', candidateId: 'held', formula, accepted: false, held: true, impact: { inspected: [{ pmid: '4' }] } },
    ] })
    .mockResolvedValueOnce({ status: 'needs_review', best: { formula: nextFormula }, trials: [] })
    .mockResolvedValueOnce({ status: 'achieved', best: { formula: lastFormula }, trials: [] });
  (searchOutsideCandidates as jest.Mock).mockResolvedValueOnce(outside('1', '4', '9', '4'))
    .mockResolvedValueOnce(outside('5')).mockResolvedValueOnce(outside('8'));
  jest.mocked(seedTitles).mockImplementation(async (pmids) => pmids.map((pmid) => ({ pmid, title: `title ${pmid}` })));
  const result = { ...makeResult(), oracleRounds: 2 };
  const d = deps();
  await executeCase(fixture, audit, 'protocol', result, d);
  const calls = jest.mocked(runQueryOptimization).mock.calls;
  const first = calls[0]![0];
  expect(calls[1]![0]).toEqual({ ...first, initialFormula: formula, runId: 'fake-run-oracle1',
    seedPmids: ['1', '2', '3', '4'], seedPapers: ['1', '2', '3', '4'].map((pmid) => ({ pmid, title: `title ${pmid}` })) });
  expect(calls[2]![0]).toEqual({ ...first, initialFormula: nextFormula, runId: 'fake-run-oracle2',
    seedPmids: ['1', '2', '3', '4', '5'], seedPapers: ['1', '2', '3', '4', '5'].map((pmid) => ({ pmid, title: `title ${pmid}` })) });
  expect(calls[1]![1]!.checkpoint).not.toBe(calls[0]![1]!.checkpoint);
  expect(calls[2]![1]!.checkpoint).not.toBe(calls[1]![1]!.checkpoint);
  expect(jest.mocked(searchOutsideCandidates).mock.calls.map(([input]) => [...input.existingPmids])).toEqual([
    ['1', '2', '3'], ['1', '2', '3', '4'], ['1', '2', '3', '4', '5'],
  ]);
  expect(result.oracle).toMatchObject({ stopReason: 'round_limit', exposedHeldOutStudies: ['d', 'e'],
    unexposedHeldOut: { total: 1, captured: 0, recall: 0 }, final: { formula: lastFormula },
    rounds: [ { presentedPmids: ['1', '4', '9'], includedPmids: ['4'], includedStudyIds: ['d'], excludedCount: 2 },
      { presentedPmids: ['5'], includedPmids: ['5'], includedStudyIds: ['e'], excludedCount: 0 } ] });
  expect(d.writeOracleRound.mock.calls.map(([round]) => round)).toEqual(result.oracle!.rounds);
  expect(d.eutils.fetch).not.toHaveBeenCalled();
});

test.each(['confirmation_unavailable', 'no_new_includes', 'no_best_formula'] as const)('停止理由 %s を保存する', async (reason) => {
  if (reason === 'confirmation_unavailable') (searchOutsideCandidates as jest.Mock).mockRejectedValue(new Error('探索失敗'));
  if (reason === 'no_new_includes') (searchOutsideCandidates as jest.Mock).mockResolvedValue(outside('1', '9'));
  if (reason === 'no_best_formula') {
    (runQueryOptimization as jest.Mock).mockResolvedValue({ status: 'needs_review', best: null, trials: [] });
    jest.spyOn(confirmationAudit, 'computeConfirmation').mockResolvedValue({ status: 'ready', reason: null, marginHits: 1,
      outsidePmids: ['4'], lostInspectedPmids: [], total: 1, heldOutStudiesAmongCandidates: ['d'], nonGoldCandidates: 0 });
  }
  const result = { ...makeResult(), oracleRounds: 2 };
  await executeCase(fixture, audit, 'protocol', result, deps());
  if (reason === 'no_best_formula') {
    expect(result.status).toBe('failed');
    expect(result.oracle).toBeUndefined();
    expect(runQueryOptimization).toHaveBeenCalledTimes(1);
    return;
  }
  expect(result.oracle).toMatchObject({ stopReason: reason, rounds: [] });
  expect(result.oracle!.final).toBe(result.conditions.C1);
  expect(runQueryOptimization).toHaveBeenCalledTimes(1);
});

test('最後の確認候補も提示済みに数え、研究単位で未提示の捕捉と分母 0 を計算する', async () => {
  (searchOutsideCandidates as jest.Mock).mockResolvedValueOnce(outside('5')).mockResolvedValueOnce(outside('6'));
  const result = { ...makeResult(), oracleRounds: 1 };
  await executeCase(fixture, audit, 'protocol', result, deps());
  expect(result.oracle).toMatchObject({ exposedHeldOutStudies: ['e', 'f'], unexposedHeldOut: { total: 1, captured: 1, recall: 1 } });
  (searchOutsideCandidates as jest.Mock).mockResolvedValue(outside('4', '5', '6'));
  const all = { ...makeResult(), oracleRounds: 1 };
  await executeCase(fixture, audit, 'protocol', all, deps());
  expect(all.oracle!.unexposedHeldOut).toEqual({ total: 0, captured: 0, recall: null });
});

test('検索日外の gold は exclude とし、共有 PMID の include は各研究 ID に対応付ける', async () => {
  jest.mocked(capturedGold).mockResolvedValue(['1', '2', '3', '4', '5']);
  const sharedFixture = { ...fixture, gold: fixture.gold.map((group) => group.id === 'd'
    ? { ...group, members: [...group.members, { studyId: 'd2', pmids: ['4'] }] } : group) };
  (searchOutsideCandidates as jest.Mock).mockResolvedValueOnce(outside('4', '6')).mockResolvedValueOnce(outside());
  const result = { ...makeResult(), oracleRounds: 1 };
  await executeCase(sharedFixture, audit, 'protocol', result, deps());
  expect(result.oracle!.rounds[0]).toMatchObject({ includedPmids: ['4'], includedStudyIds: ['d', 'd2'], excludedCount: 1 });
  expect(result.oracle!.exposedHeldOutStudies).toEqual(['d', 'd2']);
  expect(jest.mocked(runQueryOptimization).mock.calls[1]![0].seedPmids).toEqual(['1', '2', '3', '4']);
});

test.each(['exception', 'error', 'measurement', 'candidate'] as const)('ラウンドの %s は run 全体を failed にする', async (failure) => {
  (searchOutsideCandidates as jest.Mock).mockResolvedValue(outside('4'));
  const base = { status: 'needs_review', best: { formula }, trials: [] };
  const optimize = runQueryOptimization as jest.Mock;
  optimize.mockResolvedValueOnce(base);
  if (failure === 'exception') optimize.mockRejectedValueOnce(new Error('ラウンド例外'));
  else optimize.mockResolvedValueOnce({ ...base, status: failure === 'error' ? 'error' : 'needs_review',
    trials: failure === 'candidate' ? [{ kind: 'proposal', candidateId: 'bad', accepted: false, formula }] : [] });
  if (failure === 'measurement' || failure === 'candidate') {
    const ok = { status: 'success', hits: 10, capturedPmids: ['4'] };
    const measure = evaluateSearch as jest.Mock;
    measure.mockResolvedValueOnce(ok).mockResolvedValueOnce(ok);
    if (failure === 'candidate') measure.mockResolvedValueOnce(ok);
    measure.mockResolvedValue({ status: 'failure', error: '測定失敗' });
  }
  const result = { ...makeResult(), oracleRounds: 2 };
  await expect(executeCase(fixture, audit, 'protocol', result, deps())).rejects.toThrow();
  expect(result.status).toBe('failed');
  expect(runQueryOptimization).toHaveBeenCalledTimes(2);
});

test('完了結果のラウンド数が違えば上限やコミットにかかわらず label 変更を求める', () => {
  const result = { ...makeResult(), status: 'completed' as const, gitCommit: 'same' };
  expect(decideExisting(result, result, 'same', 0)).toBe('skip');
  expect(() => decideExisting(result, result, 'same', 1)).toThrow('--label');
  expect(() => decideExisting({ ...result, oracleRounds: 2 }, { maxHits: 1 }, 'other', 0)).toThrow('oracleRounds');
  expect(decideExisting({ ...result, oracleRounds: 2 }, result, 'same', 2)).toBe('skip');
});

test('ラウンドの却下候補と有害採用は直前の最終式を C0 として比較する', async () => {
  const base = { status: 'needs_review', best: { formula }, trials: [] };
  (runQueryOptimization as jest.Mock).mockResolvedValueOnce(base).mockResolvedValueOnce({ ...base, trials: [
    { kind: 'proposal', candidateId: 'accepted', formula, accepted: true },
    { kind: 'proposal', candidateId: 'rejected', formula, accepted: false },
  ] });
  (searchOutsideCandidates as jest.Mock).mockResolvedValueOnce(outside('4')).mockResolvedValueOnce(outside());
  (evaluateSearch as jest.Mock).mockResolvedValueOnce({ status: 'success', hits: 30, capturedPmids: ['6'] })
    .mockResolvedValueOnce({ status: 'success', hits: 20, capturedPmids: ['4', '5'] })
    .mockResolvedValue({ status: 'success', hits: 10, capturedPmids: ['4'] });
  const result = { ...makeResult(), oracleRounds: 1 };
  await executeCase(fixture, audit, 'protocol', result, deps());
  const round = result.oracle!.rounds[0]!;
  expect(round.comparisonToPrevious!.lostHeldOut).toEqual(['e']);
  expect(round.rejectedCandidates.map((candidate) => candidate.comparedToC0!.lostHeldOut)).toEqual([['e'], ['e']]);
  expect(round.adoptionAudit).toMatchObject({ harmfulAdopted: 1, trials: [
    { candidateId: 'accepted', hitsBefore: 20, lostHeldOut: ['e'] },
    { candidateId: 'rejected', hitsBefore: 10, lostHeldOut: [] },
  ] });
});

test('CLI は各ラウンドの JSON をマスクして試行ディレクトリに保存し dry-run に要求数を表示する', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-cli-'));
  const id = 'r1-mindfulness-smoking';
  const fixtureDir = join(root, 'fixtures', id);
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, 'case.json'), JSON.stringify(fixture));
  writeFileSync(join(fixtureDir, 'audit.json'), JSON.stringify(audit));
  writeFileSync(join(fixtureDir, 'seeds.json'), JSON.stringify(fixture.seeds));
  writeFileSync(join(fixtureDir, 'protocol.md'), 'protocol');
  jest.replaceProperty(process, 'env', { ...process.env, GEMINI_API_KEY: 'fake-secret' });
  const output = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  const previousExitCode = process.exitCode;
  try {
    (searchOutsideCandidates as jest.Mock).mockResolvedValueOnce(outside('4')).mockResolvedValueOnce(outside('5'))
      .mockResolvedValueOnce(outside());
    (runQueryOptimization as jest.Mock).mockResolvedValue({ status: 'achieved', best: { formula }, trials: [], reason: 'fake-secret' });
    await main(['--case', id, '--oracle-rounds', '2'], join(root, 'fixtures'), join(root, 'results'));
    const dir = join(root, 'results', 'default', id, 'live', 's20260912');
    const raw = readFileSync(join(dir, 'run.json'), 'utf8');
    const result = JSON.parse(raw) as RunResult;
    expect(result.status).toBe('completed');
    expect(raw).not.toContain('fake-secret');
    expect(result.oracleRounds).toBe(2);
    for (const round of result.oracle!.rounds) {
      const roundRaw = readFileSync(join(dir, result.runId, `oracle-round-${round.round}.json`), 'utf8');
      expect(roundRaw).not.toContain('fake-secret');
      expect(JSON.parse(roundRaw)).toEqual(round);
    }
    await main(['--case', id, '--oracle-rounds', '2', '--dry-run'], join(root, 'fixtures'), join(root, 'results'));
    expect(output.mock.calls.flat().join('')).toContain('oracleRounds=2');
  } finally {
    process.exitCode = previousExitCode;
    jest.restoreAllMocks();
  }
});

