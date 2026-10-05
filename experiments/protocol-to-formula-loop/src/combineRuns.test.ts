/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './combineRuns';
import { type Conditions } from './conditions';
import { readBudget, readRun, runPath } from './runDir';
import { readSubmissionState } from './scoreRuns';
import { splitReviews } from './split';
import { type RunRuntime } from './startRuns';
import { validateFormulaMd } from './submission';
import { fixture, record, review, writeJson, writeLines } from './testFixtures';

function setup(queries: (string | null | undefined)[] = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
  const root = mkdtempSync(join(tmpdir(), 'p2f-combine-'));
  const casesDir = join(root, 'cases');
  const harnessDir = join(root, 'harness');
  const runs = join(root, 'runs');
  const rows = Array.from({ length: 10 }, (_, i) => review(i + 1));
  fixture(root, rows);
  writeLines(join(casesDir, 'evaluable.jsonl'), rows.map((row) => record(row)));
  const dev = rows.filter((row) => splitReviews(rows).get(row.pmcid) === 'development');
  const selected = dev[0]!;
  writeJson(join(casesDir, 'subsets.json'), { smoke: [selected.pmcid], fixed: dev.map((row) => row.pmcid) });
  for (const row of rows) {
    mkdirSync(join(casesDir, row.pmcid));
    writeFileSync(join(casesDir, row.pmcid, 'protocol.md'), '合成プロトコル');
  }
  const conditions: Conditions = { version: 'combined', model: 'synthetic-20260101', generationSettings: '合成条件',
    inputs: ['protocol.md'], tools: ['submit'], maxMeasurements: 2, maxSubmissions: 4,
    costLimit: '合成上限', finalSelection: '合成選択', combine: { from: 'source', k: 3 } };
  writeJson(join(harnessDir, 'combined', 'conditions.json'), conditions);
  const source = (i: number, pmcid = selected.pmcid) => runPath(runs, 'source', pmcid, i);
  const output = (i: number, pmcid = selected.pmcid) => runPath(runs, 'combined', pmcid, i);
  for (const [index, query] of queries.entries()) {
    if (query === undefined) continue;
    mkdirSync(source(index + 1), { recursive: true });
    if (query !== null) writeJson(join(source(index + 1), 'submission.json'), { number: 2, query });
  }
  const runtime: RunRuntime = { casesDir, harnessDir, env: { COCHRANE_BENCH_DIR: root }, now: () => new Date('2026-01-01T00:00:00Z'),
    stdout: jest.fn(), stderr: jest.fn(), sleep: jest.fn(async () => {}),
    fetchImpl: jest.fn(async () => { throw new Error('通信は禁止です'); }) };
  const args = ['--runs', runs, '--version', 'combined', '--subset', 'smoke', '--runs-per-review', '2'];
  return { root, runs, args, runtime, source, output, conditions, selected, dev, rows };
}

test('元の実行を三本ずつ対応させ、検査済みの式と一回の提出を記録する', () => {
  const f = setup();
  expect(main(f.args, f.runtime)).toBe(0);
  for (const [index, words] of [['alpha', 'beta', 'gamma'], ['delta', 'epsilon', 'zeta']].entries()) {
    const dir = f.output(index + 1);
    const md = readFileSync(join(dir, 'submissions', '1.md'), 'utf8');
    expect(md).toBe('## PubMed/MEDLINE\n\n```\n#1 ' + words.map((word) => `(${word})`).join(' OR ') + '\n```\n');
    const validated = validateFormulaMd(md);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error('合成式の検査に失敗しました');
    expect(readSubmissionState(dir)).toMatchObject({ submission: { number: 1, query: validated.query }, submitAttempts: 1 });
    expect(JSON.parse(readFileSync(join(dir, 'submission.json'), 'utf8'))).toMatchObject({
      combinedFrom: index === 0 ? [1, 2, 3] : [4, 5, 6], submittedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(readBudget(dir)).toEqual({ measurements: 0, submissions: 1 });
    expect(JSON.parse(readFileSync(join(dir, 'tool-log.jsonl'), 'utf8'))).toMatchObject({ command: 'submit', args: '束ねた式 1 件',
      result: '成功', remaining: { measurements: 2, submissions: 3 } });
    expect(readRun(dir)).toMatchObject({ conditions: f.conditions, cutoffDate: f.selected.cutoffDate, runIndex: index + 1 });
    expect(readFileSync(join(dir, 'protocol.md'), 'utf8')).toBe('合成プロトコル');
  }
  expect(f.runtime.stdout).toHaveBeenNthCalledWith(1, '作成: 2 件\n');
  expect(f.runtime.stdout).toHaveBeenNthCalledWith(2, '束ねた式: 2 件\n');
  expect(f.runtime.stdout).toHaveBeenNthCalledWith(3, '提出なし: 0 件\n');
  expect(f.runtime.stdout).toHaveBeenNthCalledWith(4, '元の式が 3 個: 2 件、3 個未満: 0 件\n');
  expect(JSON.stringify((f.runtime.stdout as jest.Mock).mock.calls)).not.toContain('PMC');
  expect(f.runtime.fetchImpl).not.toHaveBeenCalled();
  expect(f.runtime.sleep).not.toHaveBeenCalled();
});

test('同じ式を一つにまとめても元の提出番号と本数は保つ', () => {
  const f = setup(['alpha', 'alpha', 'alpha', 'beta', 'beta', 'gamma']);
  main(f.args, f.runtime);
  expect(readFileSync(join(f.output(1), 'submissions', '1.md'), 'utf8')).toContain('#1 (alpha)\n');
  expect(readFileSync(join(f.output(2), 'submissions', '1.md'), 'utf8')).toContain('#1 (beta) OR (gamma)\n');
  expect(JSON.parse(readFileSync(join(f.output(1), 'submission.json'), 'utf8')).combinedFrom).toEqual([1, 2, 3]);
  expect(f.runtime.stdout).toHaveBeenCalledWith('元の式が 3 個: 2 件、3 個未満: 0 件\n');
});

test('一部の提出だけで束ね、全て未提出なら提出も試行も記録しない', () => {
  const f = setup([null, 'beta', null, null, null, null]);
  main(f.args, f.runtime);
  expect(readFileSync(join(f.output(1), 'submissions', '1.md'), 'utf8')).toContain('#1 (beta)\n');
  expect(JSON.parse(readFileSync(join(f.output(1), 'submission.json'), 'utf8')).combinedFrom).toEqual([2]);
  expect(readSubmissionState(f.output(2))).toEqual({ submission: null, fingerprint: null, submitAttempts: 0 });
  expect(existsSync(join(f.output(2), 'submissions'))).toBe(false);
  expect(existsSync(join(f.output(2), 'tool-log.jsonl'))).toBe(false);
  expect(readBudget(f.output(2))).toEqual({ measurements: 0, submissions: 0 });
  expect(f.runtime.stdout).toHaveBeenCalledWith('束ねた式: 1 件\n');
  expect(f.runtime.stdout).toHaveBeenCalledWith('提出なし: 1 件\n');
  expect(f.runtime.stdout).toHaveBeenCalledWith('元の式が 3 個: 0 件、3 個未満: 2 件\n');
});

test('後半の元フォルダが不足していれば不足数を示し何も作らない', () => {
  const f = setup(['alpha', 'beta', 'gamma', undefined, null, undefined]);
  expect(() => main(f.args, f.runtime)).toThrow('2 件不足');
  expect(existsSync(join(f.runs, 'combined'))).toBe(false);
  expect(f.runtime.stdout).not.toHaveBeenCalled();
});

test('元の実行パスがファイルでも不足として扱う', () => {
  const f = setup(['alpha', 'beta', 'gamma', 'delta', 'epsilon', undefined]);
  writeFileSync(f.source(6), '合成ファイル');
  expect(() => main(f.args, f.runtime)).toThrow('1 件不足');
  expect(existsSync(join(f.runs, 'combined'))).toBe(false);
});

test('後半の出力が既にあれば上書きせず何も作らない', () => {
  const f = setup();
  mkdirSync(f.output(2), { recursive: true });
  writeFileSync(join(f.output(2), '既存.txt'), '保持');
  expect(() => main(f.args, f.runtime)).toThrow('既に');
  expect(existsSync(f.output(1))).toBe(false);
  expect(readFileSync(join(f.output(2), '既存.txt'), 'utf8')).toBe('保持');
});

test('別レビューの不足も作成前に調べる', () => {
  const f = setup();
  const args = f.args.map((value) => value === 'smoke' ? 'fixed' : value);
  expect(() => main(args, f.runtime)).toThrow(`${(f.dev.length - 1) * 6} 件不足`);
  expect(existsSync(join(f.runs, 'combined'))).toBe(false);
});

test('束ねる条件がない版を拒否する', () => {
  const f = setup();
  delete f.conditions.combine;
  writeJson(join(f.runtime.harnessDir!, 'combined', 'conditions.json'), f.conditions);
  expect(() => main(f.args, f.runtime)).toThrow('束ねる条件がありません');
  expect(existsSync(join(f.runs, 'combined'))).toBe(false);
});

test('試験群は明示的に開けた場合だけ対象にする', () => {
  const f = setup();
  const args = f.args.map((value) => value === 'smoke' ? 'test' : value);
  expect(() => main(args, f.runtime)).toThrow('--open-test-set');
  const selected = f.rows.filter((row) => splitReviews(f.rows).get(row.pmcid) === 'test');
  for (const row of selected) for (let i = 1; i <= 6; i++) mkdirSync(f.source(i, row.pmcid), { recursive: true });
  expect(main([...args, '--open-test-set'], f.runtime)).toBe(0);
  for (const row of selected) expect(existsSync(f.output(2, row.pmcid))).toBe(true);
  expect(existsSync(f.output(1))).toBe(false);
});

test('束ねた式が検査を通らなければ拒否する', () => {
  const f = setup(['(', null, null, null, null, null]);
  expect(() => main(f.args, f.runtime)).toThrow('束ねた式の検査に失敗');
  expect(existsSync(join(f.runs, 'combined'))).toBe(false);
});
