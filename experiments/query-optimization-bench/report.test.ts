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
  expect(frozenRow).toEqual(['development', 'default', 'r1-mindfulness-smoking', 'seeded', 's20260912', '-', '欠測', '2',
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


const labeledRun: RunResult = { id: 'case', runId: 'run', profileId: 'default', status: 'completed', startedAt: '',
  model: 'fake', searchDate: '', maxHits: 2000, maxIterations: 5, conditions: {}, apiCalls: { ncbi: 0, llm: 0 },
  apiElapsedMs: { ncbi: 0, llm: 0 }, elapsedMs: 0, llmLogs: [], seedSplit: 's42', gitCommit: '123456789012aaa',
  c0: { source: 'frozen', id: 'seeded-draft1', variant: 'seeded', sha256: 'a', draftIndex: 1 } };

test('ラベル無しと +label 付き run は両方読み、各試行履歴は除く', () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-label-'));
  for (const [split, label] of [['s42', undefined], ['s42+baseline', 'baseline']] as const) {
    const dir = join(root, 'default', 'case', 'seeded-draft1', split);
    mkdirSync(join(dir, 'attempt'), { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...labeledRun, label }));
    writeFileSync(join(dir, 'attempt', 'run.json'), JSON.stringify({ ...labeledRun, id: 'ignored' }));
  }
  report(root, join(root, 'fixtures'));
  const csv = readFileSync(join(root, 'summary.csv'), 'utf8');
  const rows = csv.trim().split('\n').filter((row) => row.includes('"C0"'));
  expect(rows).toHaveLength(2);
  expect(rows.filter((row) => row.includes('"baseline"'))).toHaveLength(1);
  expect(csv).not.toContain('ignored');
});

test('集計は label とコミットを分け、同一グループの複数ドラフトだけ注記する', () => {
  const second = { ...labeledRun, c0: { ...labeledRun.c0!, id: 'seeded-draft2', sha256: 'b', draftIndex: 2 } };
  const rows = aggregateRows([labeledRun, second, { ...labeledRun, label: 'candidate' }, { ...labeledRun, gitCommit: 'abcdef123456bbb' }]);
  expect(rows).toHaveLength(4);
  const column = (name: string) => rows[0]!.indexOf(name);
  expect(rows[0]!.slice(4, 7)).toEqual(['seedSplit', 'label', 'gitCommit']);
  const mixed = rows.slice(1).find((row) => row[column('runs')] === '2')!;
  expect(mixed[column('label')]).toBe('-');
  expect(mixed[column('gitCommit')]).toBe('123456789012');
  expect(mixed[column('note')]).toBe('複数ドラフト（2 種）を含む。散らばりには C0 の違いが混ざる');
  expect(rows.slice(1).filter((row) => row[column('runs')] === '1').every((row) => row[column('note')] === '')).toBe(true);
});

test('replay 列は run.replay.name を出し、頑健性の集計からは replay run を除外して注記する', () => {
  const freeGeneration: RunResult = { ...labeledRun, label: 'baseline' };
  const replayRun: RunResult = { ...labeledRun, label: 'replay-check',
    replay: { name: 'pr104-r2', sha256: 'replay-x', responseCount: 3, usedCount: 3, exhausted: true } };
  const rows = reportRows([freeGeneration, replayRun]);
  const column = rows[0]!.indexOf('replay');
  expect(column).toBeGreaterThan(-1);
  expect(rows[2]![column]).toBe('-');
  expect(rows[4]![column]).toBe('pr104-r2');

  const root = mkdtempSync(join(tmpdir(), 'bench-replay-'));
  const dir = (label: string) => join(root, 'default', 'case', 'seeded-draft1', `s42+${label}`);
  for (const [label, run] of [['baseline', freeGeneration], ['replay-check', replayRun]] as const) {
    mkdirSync(dir(label), { recursive: true });
    writeFileSync(join(dir(label), 'run.json'), JSON.stringify(run));
  }
  report(root, join(root, 'fixtures'));
  expect(readFileSync(join(root, 'summary.md'), 'utf8')).toContain('replay run は 1 件をこの集計から除外した');
  const aggregate = aggregateRows([freeGeneration, replayRun]);
  // replay run は自身のグループにすら現れない（総 run 数に含まれない）。
  expect(aggregate.some((row) => row.includes('replay-check'))).toBe(false);
  expect(aggregate.find((row) => row[5] === 'baseline')![7]).toBe('1');
});

test('コスト欠測は価格表外とトークン不明を区別し、古い記録も表示する', () => {
  const usage = { calls: 3, tokensIn: 0, tokensOut: 0, costUsd: null, unpricedCalls: 0, untrackedCalls: 0 };
  const cost = (llmUsage?: RunResult['llmUsage']) => {
    const rows = reportRows([{ ...labeledRun, label: 'baseline', llmUsage }]);
    expect(rows[2]![rows[0]!.indexOf('label')]).toBe('baseline');
    return rows[2]![rows[0]!.indexOf('llmCostUsd')];
  };
  expect(cost()).toBe('欠測');
  expect(cost({ ...usage, unpricedCalls: 1 })).toBe('欠測（価格表外 1 件）');
  expect(cost({ ...usage, untrackedCalls: 2 })).toBe('欠測（トークン不明 2 件）');
  expect(cost({ ...usage, unpricedCalls: 1, untrackedCalls: 2 })).toBe('欠測（価格表外 1 件・トークン不明 2 件）');
  const legacy = { ...usage, unpricedCalls: 1 };
  Reflect.deleteProperty(legacy, 'untrackedCalls');
  expect(cost(legacy)).toBe('欠測（価格表外 1 件）');
  expect(cost({ ...usage, costUsd: 0 })).toBe('0');
});
