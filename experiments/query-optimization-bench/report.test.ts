/** @jest-environment node */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateRows, report, reportRows } from './report';
import type { RunResult } from './types';

test('同一ケースの旧系列と凍結 C0 の新系列を集計し、両系列の試行履歴を除外する', () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-mixed-'));
  const results = join(root, 'results');
  const caseDir = join(results, 'default', 'case');
  const splitDir = join(caseDir, 'seeded-draft1', 's20260912');
  const run = { id: 'case', profileId: 'default', conditions: {}, status: 'completed', apiCalls: { ncbi: 0, llm: 0 }, elapsedMs: 0 };
  const frozen = { ...run, c0: { source: 'frozen', id: 'seeded-draft1', sha256: 'deadbeef', variant: 'seeded', draftIndex: 1 }, seedSplit: 's20260912' };
  for (const [dir, value] of [
    [caseDir, run], [splitDir, frozen],
    [join(caseDir, 'run-old'), { ...run, id: 'ignored-old' }],
    [join(splitDir, 'run-new'), { ...frozen, id: 'ignored-new' }],
  ] as const) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(value));
  }
  report(results, join(root, 'fixtures'));
  const csv = readFileSync(join(results, 'summary.csv'), 'utf8');
  const c0Rows = csv.trim().split('\n').filter((line) => line.includes('"C0"'));
  expect(c0Rows).toHaveLength(2);
  expect(c0Rows.filter((line) => line.includes('frozen:seeded-draft1'))).toHaveLength(1);
  expect(c0Rows.filter((line) => !line.includes('frozen:seeded-draft1'))).toHaveLength(1);
  expect(csv).not.toContain('ignored-');
});

test('有害採用列は比較不能件数を表示し、古い記録の欠落フィールドも扱う', () => {
  const run: RunResult = { id: 'case', runId: 'run', profileId: 'default', status: 'completed', startedAt: '',
    model: 'fake', searchDate: '2021-04-15', maxHits: 2000, maxIterations: 5, conditions: {}, apiCalls: { ncbi: 0, llm: 0 },
    apiElapsedMs: { ncbi: 0, llm: 0 }, elapsedMs: 0, llmLogs: [],
    adoptionAudit: { adopted: 2, unscoredAdopted: 2, harmfulAdopted: null, trials: [] } };
  const rows = reportRows([run]);
  const column = rows[0]!.indexOf('harmfulAdopted');
  expect(rows[2]![column]).toBe('未採点（2 件）');
  const legacy = JSON.parse(JSON.stringify(run)) as RunResult;
  Reflect.deleteProperty(legacy.adoptionAudit!, 'unscoredAdopted');
  expect(reportRows([legacy])[2]![column]).toBe('欠測');
  Reflect.deleteProperty(legacy.adoptionAudit!, 'harmfulAdopted');
  expect(reportRows([legacy])[2]![column]).toBe('欠測');
  delete legacy.adoptionAudit;
  expect(reportRows([legacy])[2]![column]).toBe('欠測');
});

test('report reads both layouts and groups cases across profiles without counting attempts', () => {
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real API forbidden'));
  const root = mkdtempSync(join(tmpdir(), 'bench-profiles-'));
  const fixtures = join(root, 'fixtures');
  const results = join(root, 'results');
  const save = (dir: string, value: unknown) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(value));
  };
  const run = (id: string, profileId?: string) => ({ id, profileId, conditions: {}, status: 'completed', apiCalls: { ncbi: 0, llm: 0 }, elapsedMs: 0 });
  try {
    save(join(results, 'a'), run('a'));
    save(join(results, 'a', 'attempt'), run('ignored'));
    save(join(results, 'b'), run('b', 'tight-1000'));
    save(join(results, 'tight-1000', 'a'), run('a', 'tight-1000'));
    save(join(results, 'tight-1000', 'a', 'attempt'), run('ignored'));
    save(join(results, 'default', 'c'), run('c', 'default'));
    mkdirSync(join(fixtures, 'a'), { recursive: true });
    writeFileSync(join(fixtures, 'a', 'b1.json'), JSON.stringify({ query: 'baseline' }));
    report(results, fixtures);
    const csv = readFileSync(join(results, 'summary.csv'), 'utf8');
    const lines = csv.trim().split('\n');
    expect(lines[0]).toMatch(/^"profile","case"/);
    expect(lines.filter((line) => line.includes('"C0"')).map((line) => line.split(',').slice(0, 2))).toEqual([
      ['"default"', '"a"'], ['"tight-1000"', '"a"'], ['"tight-1000"', '"b"'], ['"default"', '"c"'],
    ]);
    expect(csv).not.toContain('ignored');
    expect(csv.match(/baseline/g)).toHaveLength(2);
    expect(readFileSync(join(results, 'summary.md'), 'utf8')).toContain('| profile | case |');
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});

test('新レイアウト（profile/case/c0Key/splitKey/run.json）も読み、role・c0・seedSplit・maxHits・gitCommit を列に出す', () => {
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real API forbidden'));
  const root = mkdtempSync(join(tmpdir(), 'bench-deep-'));
  const results = join(root, 'results');
  const fixtures = join(root, 'fixtures');
  const run: RunResult = { id: 'r1-mindfulness-smoking', runId: 'run-1', profileId: 'default', status: 'completed', startedAt: '',
    model: 'fake', searchDate: '2021-04-15', maxHits: 2000, maxIterations: 5, conditions: {}, apiCalls: { ncbi: 0, llm: 0 },
    apiElapsedMs: { ncbi: 0, llm: 0 }, elapsedMs: 0, llmLogs: [], role: 'development', postHoc: false,
    gitCommit: 'abc123', gitDirty: false, seedSplit: 's20260912',
    c0: { source: 'frozen', id: 'seeded-draft1', sha256: 'deadbeef', variant: 'seeded', draftIndex: 1 } };
  try {
    const dir = join(results, 'default', 'r1-mindfulness-smoking', 'seeded-draft1', 's20260912');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run));
    // 試行履歴のコピーは二重集計しない。
    mkdirSync(join(dir, 'run-1'), { recursive: true });
    writeFileSync(join(dir, 'run-1', 'run.json'), JSON.stringify({ ...run, id: 'ignored-attempt' }));
    report(results, fixtures);
    const csv = readFileSync(join(results, 'summary.csv'), 'utf8');
    expect(csv).not.toContain('ignored-attempt');
    const rows = reportRows([run]);
    expect(rows[0]).toEqual(expect.arrayContaining(['role', 'c0', 'seedSplit', 'maxHits', 'gitCommit']));
    expect(rows[1]).toEqual(expect.arrayContaining(['development', 'frozen:seeded-draft1', 's20260912', '2000', 'abc123']));
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});

test('aggregateRows は role・profile・case・C0・分割ごとに min/median/max と outcome 件数をまとめ、live には注記を付ける', () => {
  const base: RunResult = { id: 'r1-mindfulness-smoking', runId: 'r', profileId: 'default', status: 'completed', startedAt: '',
    model: 'fake', searchDate: '2021-04-15', maxHits: 2000, maxIterations: 5, apiCalls: { ncbi: 0, llm: 0 }, apiElapsedMs: { ncbi: 0, llm: 0 },
    elapsedMs: 0, llmLogs: [], role: 'development', seedSplit: 's20260912',
    c0: { source: 'frozen', id: 'seeded-draft1', sha256: 'x', variant: 'seeded', draftIndex: 1 },
    conditions: {
      C0: { query: 'c0', measurement: { status: 'success', hits: 100, capturedPmids: [] }, metrics: null },
      C1: { query: 'c1', measurement: { status: 'success', hits: 80, capturedPmids: [] }, metrics: { heldOutRecall: 0.5, allStudyRecall: 0.5,
        hits: 80, capturedStudies: [], capturedHeldOut: [], knownIncludedReportShare: null, recordsPerKnownIncludedStudy: null } },
    },
    comparison: { lostStudies: [], gainedStudies: [], lostHeldOut: [], gainedHeldOut: [], improved: true, outcome: 'improved' },
    adoptionAudit: { adopted: 1, unscoredAdopted: 0, harmfulAdopted: 0, trials: [] },
    confirmation: { status: 'ready', reason: null, marginHits: 5, outsidePmids: [], lostInspectedPmids: [], total: 4, heldOutStudiesAmongCandidates: [], nonGoldCandidates: 0 },
  };
  const second: RunResult = { ...base, runId: 'r2',
    conditions: { ...base.conditions, C0: { query: 'c0', measurement: { status: 'success', hits: 200, capturedPmids: [] }, metrics: null },
      C1: { query: 'c1', measurement: { status: 'success', hits: 60, capturedPmids: [] }, metrics: { heldOutRecall: 0.7, allStudyRecall: 0.7,
        hits: 60, capturedStudies: [], capturedHeldOut: [], knownIncludedReportShare: null, recordsPerKnownIncludedStudy: null } } },
    comparison: { lostStudies: [], gainedStudies: [], lostHeldOut: ['d'], gainedHeldOut: [], improved: false, outcome: 'tradeoff' },
    adoptionAudit: { adopted: 1, unscoredAdopted: 0, harmfulAdopted: 1, trials: [] },
    confirmation: { ...base.confirmation!, total: 8 } };
  const liveRun: RunResult = { ...base, runId: 'r3', c0: { source: 'live' } };

  const rows = aggregateRows([base, second, liveRun]);
  const frozenRow = rows.find((row) => row[3] === 'seeded');
  expect(frozenRow).toEqual(['development', 'default', 'r1-mindfulness-smoking', 'seeded', 's20260912', '2',
    '100', '150', '200', // c0 hits min/median/max
    '60', '70', '80', // c1 hits min/median/max
    '0.5', '0.6', '0.7', // heldOutRecall min/median/max
    '1', '1', '0', '0', // improved/tradeoff/unchanged/worse
    '1', '6', '']); // harmfulAdoptedTotal, confirmationTotalMedian(4,8→6), note(空)
  const liveRow = rows.find((row) => row[3] === 'live');
  expect(liveRow![liveRow!.length - 1]).toContain('ポリシーの効果と解釈しない');
  // 採点保留（null）の run は 0 件として合計しない。
  const unscored: RunResult = { ...base, runId: 'r4', adoptionAudit: { adopted: 1, unscoredAdopted: 1, harmfulAdopted: null, trials: [] } };
  const harmfulIndex = rows[0]!.indexOf('harmfulAdoptedTotal');
  expect(aggregateRows([base, second, unscored]).find((row) => row[3] === 'seeded')![harmfulIndex]).toBe('1（未採点 1 run を除く）');
  expect(aggregateRows([unscored]).find((row) => row[3] === 'seeded')![harmfulIndex]).toBe('欠測');
});
