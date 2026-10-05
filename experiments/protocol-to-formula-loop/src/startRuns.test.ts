/** @jest-environment node */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { fixture, record, review, writeJson, writeLines } from './testFixtures';
import { splitReviews } from './split';

test('群と回数を検査し、試験群は明示的に開ける指定を要求する', () => {
  const args = ['--out', 'runs', '--version', 'v0', '--subset', 'test', '--runs-per-review', '1'];
  expect(() => parseRunOptions(args, '--out')).toThrow('--open-test-set');
  expect(parseRunOptions([...args, '--open-test-set'], '--out').openTestSet).toBe(true);
  for (const n of ['0', '1.5', 'NaN']) expect(() => parseRunOptions([...args.slice(0, -1), n, '--open-test-set'], '--out')).toThrow();
});
test('評価可能な指定群の入力だけから実行を作り、上書きしない', () => {
  const root = mkdtempSync(join(tmpdir(), 'p2f-start-'));
  const casesDir = join(root, 'cases');
  const rows = Array.from({ length: 10 }, (_, i) => review(i + 1));
  fixture(root, rows);
  writeLines(join(casesDir, 'evaluable.jsonl'), rows.map((row) => record(row)));
  const dev = rows.filter((row) => splitReviews(rows).get(row.pmcid) === 'development');
  writeJson(join(casesDir, 'subsets.json'), { smoke: [dev[0]!.pmcid], fixed: dev.map((r) => r.pmcid) });
  for (const row of rows) { mkdirSync(join(casesDir, row.pmcid)); writeFileSync(join(casesDir, row.pmcid, 'protocol.md'), '合成プロトコル'); }
  const runtime: RunRuntime = { casesDir, env: { COCHRANE_BENCH_DIR: root }, now: () => new Date('2026-01-01Z'),
    stdout: jest.fn(), stderr: jest.fn(), fetchImpl: jest.fn(async () => { throw new Error('通信は禁止です'); }) };
  const args = ['--out', join(root, 'runs'), '--version', 'v0', '--subset', 'smoke', '--runs-per-review', '2'];
  expect(main(args, runtime)).toBe(0);
  expect(runtime.stdout).toHaveBeenCalledWith('作成: 2 件\n');
  const info = readFileSync(join(root, 'runs/v0', dev[0]!.pmcid, 'run-2/run.json'), 'utf8');
  expect(info).not.toMatch(/included|studies|00000001/);
  expect(() => main(args, runtime)).toThrow('既に');
  const options = parseRunOptions(args, '--out');
  expect(targetReviews({ ...options, subset: 'fixed' }, runtime)).toHaveLength(dev.length);
  expect(targetReviews({ ...options, subset: 'validation' }, runtime)).toHaveLength(3);
  expect(() => targetReviews({ ...options, subset: 'test' }, runtime)).toThrow('--open-test-set');
  expect(runtime.fetchImpl).not.toHaveBeenCalled();
});
