/** @jest-environment node */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as types from './types';
import { compareMetrics } from './metrics';
import { buildReport, csv, distribution, layerC, report, usageFromLogs, type Entry } from './rerunReport';
import { buildRunJobs, makeSlots, readConfig, slotName, slotsFile, type Job, type RerunConfig } from './rerun';
import type { AdoptionAudit, ConditionResult, RunResult } from './types';

const adoption = (harmfulAdopted: number | null = 0): AdoptionAudit => ({ adopted: 1, harmfulAdopted, unscoredAdopted: harmfulAdopted === null ? 1 : 0, trials: [] });
const condition = (captured: string[], hits = 10): ConditionResult => ({ query: 'q', measurement: { status: 'success', hits, capturedPmids: [] },
  metrics: { heldOutRecall: captured.length / 2, allStudyRecall: captured.length / 2, hits, capturedStudies: captured, capturedHeldOut: captured,
    knownIncludedReportShare: 0, recordsPerKnownIncludedStudy: hits } });
function run(job: Job): RunResult {
  return { id: job.caseId, runId: job.id, status: 'completed', startedAt: '', model: 'fake', searchDate: '2020-01-01',
    profileId: 'default', maxHits: 2000, maxIterations: 5, conditions: { C0: condition([]), C1: condition(['a']) },
    adoptionAudit: adoption(), apiCalls: { ncbi: 2, llm: 1 }, apiElapsedMs: { ncbi: 1, llm: 1 }, elapsedMs: 20, llmLogs: [],
    llmUsage: { calls: 1, tokensIn: 2, tokensOut: 3, costUsd: 0.1, unpricedCalls: 0, untrackedCalls: 0 },
    optimization: { status: 'achieved', stopReason: 'conditions_met', trials: [] } as unknown as RunResult['optimization'],
    confirmation: { status: 'ready', reason: null, marginHits: 0, outsidePmids: [], lostInspectedPmids: [], total: 0, heldOutStudiesAmongCandidates: [], nonGoldCandidates: 0 },
    denominator: { groups: ['a', 'b'].map((id) => ({ id, pmids: [id], members: [{ studyId: id, pmids: [id] }] })), heldOut: ['a', 'b'],
      outsideDatePmids: [], outsideDateGroups: [], manualReviewPending: false },
    oracle: { requestedRounds: 2, stopReason: 'no_new_includes', rounds: [], exposedHeldOutStudies: ['a'], final: condition(['a']),
      unexposedHeldOut: { total: 1, captured: 0, recall: 0 } } };
}
function matrix(ids = ['r1-mindfulness-smoking']) {
  const config: RerunConfig = { ...readConfig(), cases: ids, drafts: 1, liveRunsPerSplit: 1 };
  const slots = makeSlots(config).map((s) => ({ ...s, name: slotName(s, 11) }));
  const entries: Entry[] = buildRunJobs(config, slots).map((job) => ({ job, run: run(job), scored: { source: job.id, adoptionAudit: adoption() } }));
  return { config, slots, entries };
}
const build = (m: ReturnType<typeof matrix>) => buildReport(m.config, m.slots, m.entries);

test('候補損失表は新旧 current の直前比を表示し、採用・旧版・未完了を除外する', () => {
  const m = matrix();
  const current = m.entries.filter((entry) => entry.job.arm === 'current');
  for (const entry of m.entries) {
    const run = entry.run!;
    run.optimization!.trials = [
      { candidateId: '採用', kind: 'proposal', accepted: true },
      { candidateId: '保留', kind: 'proposal', accepted: false, held: true, impact: { lostHits: 50, sample: { method: 'random' } } },
      { candidateId: '却下', kind: 'proposal', accepted: false },
      { candidateId: '情報', kind: 'information', accepted: false },
    ] as NonNullable<RunResult['optimization']>['trials'];
    run.adoptionAudit!.trials = [
      { candidateId: '採用', accepted: true, held: false, hitsBefore: 10, hitsAfter: 200, lostHeldOut: [], gainedHeldOut: ['a', 'b'] },
      { candidateId: '保留', accepted: false, held: true, hitsBefore: 200, hitsAfter: 150, lostHeldOut: ['a', 'b'], gainedHeldOut: [] },
      { candidateId: '却下', accepted: false, held: false, hitsBefore: 200, hitsAfter: null, lostHeldOut: [], gainedHeldOut: [], error: '測定失敗' },
    ];
  }
  const fresh = current[0]!;
  const before = { ...condition(['a', 'b'], 200).metrics!, capturedReports: ['2', '10'] };
  const after = { ...condition([], 150).metrics!, capturedReports: [] };
  fresh.run!.rejectedCandidates = [
    { candidateId: '採用', accepted: true, changes: null, hits: 200, metrics: before, priorId: 'C0', comparedToPrior: null, comparedToC0: null },
    { candidateId: '保留', accepted: false, changes: null, hits: 150, metrics: after, priorId: '採用',
      comparedToPrior: compareMetrics(before, after), comparedToC0: compareMetrics(fresh.run!.conditions.C0!.metrics!, after) },
    { candidateId: '却下', accepted: false, changes: null, hits: null, metrics: null, priorId: '採用', comparedToPrior: null, comparedToC0: null },
  ];
  const old = current[1]!;
  old.run!.rejectedCandidates = [{ candidateId: '保留', hits: 150,
    comparedToC0: compareMetrics(old.run!.conditions.C0!.metrics!, after) }] as RunResult['rejectedCandidates'];
  current[2]!.run!.status = 'failed';
  current[3]!.run = null;
  const rows = build(m).tables.candidateLosses;
  expect(rows).toHaveLength(4);
  expect(rows[0]).toEqual({ id: fresh.job.id, case: fresh.job.caseId, c0: fresh.job.c0, split: fresh.job.split,
    candidateId: '保留', held: 1, lostHits: 50, sampleMethod: 'random', priorId: '採用', hitsPrior: 200, hitsCandidate: 150,
    lostHeldOutPrior: 'a; b', lostHeldOutC0: '', lostReportsPrior: 2, priorSource: 'rejectedCandidates' });
  expect(rows[1]).toMatchObject({ candidateId: '却下', held: 0, lostHits: null, sampleMethod: null,
    lostHeldOutPrior: null, lostReportsPrior: null, priorSource: 'rejectedCandidates' });
  expect(rows[2]).toMatchObject({ id: old.job.id, priorId: '採用', hitsPrior: 200, hitsCandidate: 150,
    lostHeldOutPrior: 'a; b', lostHeldOutC0: '', lostReportsPrior: null, priorSource: 'adoptionAudit' });
  expect(rows[3]).toMatchObject({ lostHeldOutPrior: null, lostReportsPrior: null, priorSource: 'adoptionAudit' });
  delete old.run!.adoptionAudit;
  expect(build(m).tables.candidateLosses[2]).toMatchObject({ priorId: null, lostHeldOutPrior: null, priorSource: null });
});
test.each([false, true])('既存 run の損失ゼロは手動監査待ちのときだけ欠測にする: %s', (manualReviewPending) => {
  const m = matrix();
  const entry = m.entries.find((item) => item.job.arm === 'current')!;
  const run = entry.run!;
  run.denominator!.manualReviewPending = manualReviewPending;
  run.optimization!.trials = [{ candidateId: '保留', kind: 'proposal', accepted: false, held: true }] as NonNullable<RunResult['optimization']>['trials'];
  run.adoptionAudit = { ...adoption(manualReviewPending ? null : 0), trials: [
    { candidateId: '保留', accepted: false, held: true, hitsBefore: 10, hitsAfter: 10, lostHeldOut: [], gainedHeldOut: [] },
  ] };
  run.rejectedCandidates = [{ candidateId: '保留', hits: 10, comparedToC0: null }] as RunResult['rejectedCandidates'];
  expect(build(m).tables.candidateLosses[0]).toMatchObject({ priorSource: 'adoptionAudit',
    lostHeldOutPrior: manualReviewPending ? null : '', lostHeldOutC0: null });
  run.rejectedCandidates = [{ candidateId: '保留', accepted: false, changes: null, hits: 10, metrics: null,
    priorId: 'C0', comparedToPrior: null, comparedToC0: null }];
  expect(build(m).tables.candidateLosses[0]).toMatchObject({ priorSource: 'rejectedCandidates',
    lostHeldOutPrior: null, lostHeldOutC0: null });
});

function loggedEntry(arm: Job['arm'], logs: unknown[]) {
  const m = matrix();
  const entry = m.entries.find((e) => e.job.arm === arm)!;
  const root = mkdtempSync(join(tmpdir(), 'rerun-cost-'));
  entry.job = { ...entry.job, expected: join(root, 'run.json') };
  entry.run!.runId = 'attempt';
  entry.run!.llmUsage = undefined;
  entry.run!.llmLogs = logs.map((_, i) => `llm/${i}.json`);
  mkdirSync(join(root, 'attempt/llm'), { recursive: true });
  logs.forEach((log, i) => writeFileSync(join(root, 'attempt', entry.run!.llmLogs[i]!), JSON.stringify(log)));
  return { entry, costs: () => buildReport(m.config, m.slots, [entry]).tables.costs.find((row) => row.arm === arm)! };
}
const successLog = { model: 'gemini-3.5-flash', response: { text: 'ok' }, tokensIn: 6024, tokensOut: 618 };
afterEach(() => jest.restoreAllMocks());

test.each(['legacy', 'legacyLive'] as const)('呼び出しログを同じ単価と失敗時の規則で復元する: %s', (arm) => {
  const { entry, costs } = loggedEntry(arm, [successLog,
    { model: 'unknown', response: null, tokensIn: null, tokensOut: null, error: 'offline' }]);
  expect(usageFromLogs(entry)).toEqual({ calls: 2, tokensIn: 6024, tokensOut: 618, costUsd: expect.closeTo(0.014598, 12), unpricedCalls: 0, untrackedCalls: 0 });
  expect(costs()).toMatchObject({ costFromLogs: 1, costMissing: 0, costUsdKnownSum: expect.closeTo(0.014598, 12), llmCallsKnownSum: 2, llmCallsMissing: 0 });
  expect(entry.run!.llmUsage).toBeUndefined();
});

test.each([
  [{ ...successLog, model: 'unknown' }, 1, 0],
  [{ ...successLog, tokensIn: null, tokensOut: null }, 0, 1],
] as const)('価格表外・成功時トークン不明は費用欠測を保持する: %j', (log, unpricedCalls, untrackedCalls) => {
  const { entry, costs } = loggedEntry('legacy', [log, successLog]);
  expect(usageFromLogs(entry)).toMatchObject({ calls: 2, costUsd: null, unpricedCalls, untrackedCalls });
  expect(costs()).toMatchObject({ costFromLogs: 1, costMissing: 1, costUsdKnownSum: null, llmCallsKnownSum: 2 });
});

test.each(['missing', 'broken', 'shape'])('ログが欠落・破損していれば部分和も採用しない: %s', (kind) => {
  const { entry, costs } = loggedEntry('legacy', [successLog]);
  entry.run!.llmLogs.push('llm/bad.json');
  if (kind !== 'missing') writeFileSync(join(dirname(entry.job.expected), 'attempt/llm/bad.json'), kind === 'broken' ? '{' : '42');
  expect(usageFromLogs(entry)).toBeNull();
  expect(costs()).toMatchObject({ costFromLogs: 0, costMissing: 1, costUsdKnownSum: null, llmCallsKnownSum: null, llmCallsMissing: 1 });
});

test('既存 llmUsage はログや費用欠測に関係なく優先する', () => {
  const { entry, costs } = loggedEntry('current', [successLog]);
  entry.run!.llmUsage = run(entry.job).llmUsage;
  expect(costs()).toMatchObject({ costFromLogs: 0, costMissing: 0, costUsdKnownSum: 0.1, llmCallsKnownSum: 1 });
  entry.run!.llmLogs = ['missing.json'];
  entry.run!.llmUsage!.costUsd = null;
  expect(costs()).toMatchObject({ costFromLogs: 0, costMissing: 1, costUsdKnownSum: null, llmCallsKnownSum: 1 });
});

test('層 A は criteria-only の分布、層 B は同じ C0 と分割の対、層 C は取りこぼしの積集合', () => {
  const m = matrix();
  const first = m.entries[0]!;
  first.run!.conditions.C1 = condition(['b'], 5);
  const result = build(m);
  expect(result.tables.layerARuns).toHaveLength(4);
  expect(result.tables.layerA[0]).toMatchObject({ runs: 2, C0_hits_median: 10, C1_hits_min: 5, C1_hits_max: 10, C1_hits_median: 7.5 });
  expect(result.tables.layerB[0]).toMatchObject({ c0: 'criteria-only-draft11', split: 20260912, deltaHits: -5,
    lostToCurrent: 'a', gainedToCurrent: 'b', currentHarmful: 0, legacyHarmful: 0, 原因: '' });
  expect(result.tables.layerB[2]!.c0).toBe(result.tables.layerB[0]!.c0);
  expect(result.tables.layerC[0]).toMatchObject({ missedC0: 'a; b', exposedMissed: 'a', recoveredMissed: 'a', recoveredCount: 1,
    unexposedTotal: 1, unexposedRecall: 0, withoutLoopRecall: 0.5, withLoopRecall: 0.5, presentedPmids: 0 });
  expect(result.judgments.S2).toContain('要手動分類（1 組）');
});

test('未実行と failed を各表から落とさず、未採点も 0 と扱わない', () => {
  const m = matrix();
  m.entries[0]!.run = null;
  m.entries[1]!.run!.status = 'failed';
  m.entries[2]!.run!.adoptionAudit = adoption(null);
  const result = build(m);
  expect(result.tables.layerB).toHaveLength(4);
  expect(result.tables.layerB[0]).toMatchObject({ currentStatus: '欠測', currentHits: null, currentHarmful: null });
  expect(result.tables.layerB[1]).toMatchObject({ currentStatus: '失敗', currentHits: null });
  expect(result.tables.layerC[1]!.recoveredCount).toBeNull();
  expect(result.judgments.S1).toContain('欠測で判定不能');
  expect(result.tables.costs[0]).toMatchObject({ missing: 1, failed: 1, costMissing: 1 });
});

test('S1 は有害採用 0 が境界で、旧有害採用の候補照合と未採点を区別する', () => {
  const m = matrix();
  expect(build(m).judgments.S1).toContain('満たす');
  m.entries[0]!.run!.adoptionAudit = adoption(1);
  expect(build(m).judgments.S1).toContain('満たさない');
  m.entries[0]!.run!.adoptionAudit = adoption(null);
  expect(build(m).judgments.S1).toContain('未採点 run 1');
  m.entries[0]!.run!.adoptionAudit = adoption();
  const legacy = m.entries.find((e) => e.job.arm === 'legacy')!;
  legacy.scored!.adoptionAudit = adoption(1);
  expect(build(m).judgments.S1).toContain('要手動分類');
  legacy.scored!.source = 'older-run';
  expect(build(m).tables.layerB[0]!.legacyHarmful).toBeNull();
});

test('採点保留で metrics がなくても、成功した測定の hits は残す', () => {
  const m = matrix();
  m.entries[0]!.run!.conditions.C1!.metrics = null;
  expect(build(m).tables.layerB[0]).toMatchObject({ currentHits: 10, currentRecall: null, lostToCurrent: null });
});

test('S3 は半数ちょうどでは満たさず、中央値の同値を勝ちに数える', () => {
  const ids = types.CASES.map((c) => c.id);
  const m = matrix(ids.slice(0, 2));
  for (const e of m.entries.filter((entry) => entry.job.caseId === ids[1] && entry.job.arm === 'current')) e.run!.conditions.C1 = condition([]);
  expect(build(m).judgments.S3).toContain('満たさない（1/2');
  // CASES の件数に依存させず、3 ケースちょうどの過半数判定を固定する。
  const three = matrix(ids.slice(0, 3));
  for (const e of three.entries.filter((entry) => entry.job.caseId === ids[1] && entry.job.arm === 'current')) e.run!.conditions.C1 = condition([]);
  expect(build(three).judgments.S3).toContain('満たす（2/3');
  for (const e of m.entries.filter((entry) => entry.job.caseId === ids[1] && entry.job.arm === 'current')) e.run = null;
  expect(build(m).judgments.S3).toContain('欠測で判定不能');
});

test('S4 は development と confirmation の各 1 ケース以上で、0 回収・欠測を区別する', () => {
  jest.replaceProperty(types, 'CASES', [
    { id: 'dev', pmcid: 'p1', searchDate: '2020-01-01', role: 'development' },
    { id: 'confirm', pmcid: 'p2', searchDate: '2020-01-01', role: 'confirmation' },
  ] as unknown as typeof types.CASES);
  // 設定のロード時の登録検証に合わせ、合成行列は読み込み前に元の設定を使わない。
  const config: RerunConfig = { cases: ['dev', 'confirm'], splits: [20260912, 20260915], drafts: 1, draftStart: 11, maxDraftAttempts: 3,
    liveRunsPerSplit: 1, legacyWorktree: null, labels: { current: 'current', legacy: 'legacy', legacyLive: 'live' }, legacyProfile: 'rerun-2000', legacyResultsSubdir: 'legacy', oracleRounds: 2 };
  const slots = makeSlots(config);
  const entries: Entry[] = buildRunJobs(config, slots).map((job) => ({ job, run: run(job), scored: { source: job.id, adoptionAudit: adoption() } }));
  const get = () => buildReport(config, slots, entries);
  expect(get().judgments.S4).toContain('満たす');
  for (const e of entries.filter((e) => e.job.caseId === 'confirm')) e.run!.oracle!.final = condition([]);
  expect(get().judgments.S4).toContain('満たさない');
  for (const e of entries.filter((e) => e.job.caseId === 'confirm')) e.run!.oracle = undefined;
  expect(get().judgments.S4).toContain('欠測で判定不能');
  expect(get().tables.layerCRoles).toHaveLength(2);
});

test('S5 は achieved かつ再現率 1 未満だけを数え、ready の候補 0 の割合を報告する', () => {
  const m = matrix();
  m.entries[0]!.run!.conditions.C1 = condition(['a', 'b']);
  m.entries[1]!.run!.confirmation!.total = 2;
  expect(build(m).tables.S5[0]).toMatchObject({ achievedWithMisses: 3, zeroCandidates: 2, proportion: 2 / 3 });
  for (const e of m.entries) e.run!.conditions.C1 = condition(['a', 'b']);
  expect(build(m).tables.S5[0]).toMatchObject({ achievedWithMisses: 0, zeroCandidates: 0, proportion: null });
  expect(build(m).judgments.S5).toContain('対象 0 件');
  m.entries[0]!.run!.conditions.C1 = condition([]);
  m.entries[0]!.run!.confirmation!.status = 'skipped';
  expect(build(m).judgments.S5).toContain('欠測で判定不能');
});

test('段階の提示 PMID は重複を含め合計し、include と未提示再現率を別に数える', () => {
  const m = matrix(); const e = m.entries[0]!;
  e.run!.confirmation!.total = 2;
  e.run!.oracle!.rounds = [{ presentedPmids: ['a', 'z'], includedPmids: ['a'], confirmation: { ...e.run!.confirmation!, total: 3 } }] as NonNullable<RunResult['oracle']>['rounds'];
  expect(layerC(e)).toMatchObject({ presentedPmids: 5, includedPmids: 1, rounds: 1, presentationByStage: '0:2; 1:3' });
});

test('構文エラー率と費用の欠測を示し、0 件では安全・過半数・回収を満たした扱いにしない', () => {
  const m = matrix();
  m.slots[0]!.attempts = [{ draft: 11, success: false, error: '構文エラー' }, { draft: 12, success: true, error: null }];
  for (const e of m.entries.filter((e) => e.job.arm === 'legacy')) {
    e.run!.llmUsage = undefined;
    e.run!.llmLogs = ['llm/missing.json'];
  }
  const result = build(m);
  expect(result.tables.c0QualityRates[0]).toMatchObject({ attempts: 2, syntaxErrors: 1, syntaxErrorRate: 0.5 });
  expect(result.tables.costs[1]).toMatchObject({ costUsdKnownSum: null, costMissing: 4 });
  const empty = buildReport({ ...m.config, cases: [] }, [], []);
  for (const key of ['S1', 'S3', 'S4', 'S5'] as const) expect(empty.judgments[key]).toContain('欠測で判定不能');
  expect(distribution([0, 1, null, 2, 3])).toEqual({ min: 0, median: 1.5, max: 3, measured: 4, missing: 1 });
});

test.each(['new', 'legacy', 'both'])('ローカル run.json と最終 ledger 行から全表 CSV と summary.md を生成する: %s', (location) => {
  const m = matrix(); const root = mkdtempSync(join(tmpdir(), 'rerun-report-'));
  const paths = { root, fixtures: join(root, 'fixtures'), results: join(root, 'results') };
  const jobs = buildRunJobs(m.config, m.slots, paths);
  const write = (path: string, data: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data)); };
  if (location !== 'legacy') write(slotsFile(paths), m.slots);
  if (location !== 'new') write(join(paths.results, 'rerun/c0-slots.json'), location === 'both' ? [] : m.slots);
  mkdirSync(join(paths.results, 'rerun'), { recursive: true });
  for (const job of jobs.slice(1)) { write(job.expected, run(job)); write(join(dirname(job.expected), 'scored.json'), { source: job.id, adoptionAudit: adoption() }); }
  writeFileSync(join(paths.results, 'rerun/ledger.jsonl'), [{ id: jobs[0]!.id, exitCode: 0 }, { id: jobs[0]!.id, exitCode: 1 }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  const output = report(m.config, paths);
  expect(output.tables.layerB[0]!.currentStatus).toBe('失敗');
  expect(output.tables.c0Quality.map((row) => row.name)).toEqual(m.slots.map((slot) => slot.name));
  const summary = readFileSync(join(paths.results, 'rerun/summary.md'), 'utf8');
  expect(summary).toContain('S1:'); expect(summary).toContain('候補'); expect(summary).toContain('失敗'); expect(summary).toContain('欠測');
  expect(summary).toContain('旧版はハーネスが `llmUsage` を記録しないため');
  expect(summary).toContain('costFromLogs');
  expect(readFileSync(join(paths.results, 'rerun/layerB.csv'), 'utf8')).toContain('criteria-only-draft11');
  expect(csv([{ study: 'name,"quoted"\nnext', missing: null }])).toContain('"name,""quoted""\nnext"');
});
