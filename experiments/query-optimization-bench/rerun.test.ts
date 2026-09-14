/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildRunJobs, executeRerun, logName, makeSlots, parseOptions, readConfig, readLedger, slotName,
  type Job, type Launch, type Paths, type Slot } from './rerun';
import { c0FixturePath } from './c0Artifact';

const config = () => ({ ...readConfig(), cases: ['r3-vascular-bleeding'], drafts: 1, liveRunsPerSplit: 1 });
const paths = (): Paths => {
  const root = mkdtempSync(join(tmpdir(), 'rerun-'));
  return { root, fixtures: join(root, 'fixtures'), results: join(root, 'results') };
};
function write(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); }
function frozen(c = config(), p = paths()) {
  const slots = makeSlots(c).map((slot) => ({ ...slot, name: slotName(slot, c.draftStart + slot.slot - 1) }));
  for (const slot of slots) write(c0FixturePath(p.fixtures, slot.caseId, slot.name!), {});
  write(join(p.results, 'rerun/c0-slots.json'), slots);
  return { c, p, slots };
}
beforeEach(() => { jest.spyOn(process.stdout, 'write').mockReturnValue(true); });
afterEach(() => { jest.restoreAllMocks(); });

test('行列はケースごと current → legacy → legacyLive、criteria-only C0 は分割間で共有する', () => {
  const { c, p, slots } = frozen();
  c.legacyWorktree = join(p.root, 'old');
  const jobs = buildRunJobs(c, slots, p);
  expect(jobs.map((j) => j.arm)).toEqual(['current', 'current', 'current', 'current', 'legacy', 'legacy', 'legacy', 'legacy', 'legacyLive', 'legacyLive']);
  const shared = jobs.filter((j) => j.arm === 'current' && j.variant === 'criteria-only');
  expect(shared.map((j) => j.c0)).toEqual(['criteria-only-draft11', 'criteria-only-draft11']);
  expect(jobs.some((j) => j.c0 === 'seeded-draft11-s20260915')).toBe(true);
  const old = jobs.find((j) => j.arm === 'legacy')!;
  expect(old.cwd).toBe(c.legacyWorktree);
  expect(old.command).toEqual(['npx', 'tsx', join(c.legacyWorktree, 'experiments/query-optimization-bench/run.ts'),
    '--case', c.cases[0], '--seeds', '20260912', '--label', c.labels.legacy, '--c0', 'criteria-only-draft11',
    '--profile', 'rerun-2000', '--fixtures', p.fixtures, '--results', join(p.results, c.legacyResultsSubdir)]);
  expect(old.expected).toBe(join(p.results, c.legacyResultsSubdir, 'rerun-2000', c.cases[0]!, 'criteria-only-draft11', 's20260912+rerun-legacy', 'run.json'));
  const live = jobs.find((j) => j.arm === 'legacyLive')!;
  expect(live.command).not.toContain('--c0');
  expect(live.command).toContain('rerun-legacy-live-1');
});

test('dry-run は保存も起動もせず、未凍結と旧版設定不足を一覧に出す', async () => {
  const p = paths(); const start = jest.fn();
  await executeRerun(config(), parseOptions(['all', '--dry-run']), start, p);
  expect(start).not.toHaveBeenCalled();
  expect(existsSync(p.results)).toBe(false);
  expect(jest.mocked(process.stdout.write).mock.calls.flat().join('')).toContain('legacyWorktree');
});

test('凍結失敗は次の空き番号で再試行し、各試行を永続化、完了枠は再開でスキップする', async () => {
  const p = paths(); const c = { ...config(), drafts: 3 };
  let calls = 0;
  const start: Launch = jest.fn(async (job, _env, log) => {
    calls++;
    if (calls === 1) { log('構文エラー'); return 1; }
    if (calls === 2) {
      const saved = JSON.parse(readFileSync(join(p.results, 'rerun/c0-slots.json'), 'utf8')) as Slot[];
      expect(saved[0]!.attempts).toEqual([{ draft: 11, success: false, error: '構文エラー' }]);
    }
    write(job.expected, {}); return 0;
  });
  await executeRerun(c, parseOptions(['freeze']), start, p);
  const saved = JSON.parse(readFileSync(join(p.results, 'rerun/c0-slots.json'), 'utf8')) as Slot[];
  expect(saved[0]!.name).toBe('criteria-only-draft14');
  expect(saved[0]!.attempts.map((a) => a.draft)).toEqual([11, 14]);
  expect(saved.slice(1, 3).map((s) => s.name)).toEqual(['criteria-only-draft12', 'criteria-only-draft13']);
  const previous = calls;
  const resumed = await executeRerun(c, parseOptions(['freeze']), start, p);
  expect(calls).toBe(previous);
  expect(resumed.skipped).toBe(9);
});

test('試行上限、フィルタと limit を守り、失敗でも次の run に進み ledger とログを追記する', async () => {
  const { c, p } = frozen();
  const started: Job[] = [];
  jest.replaceProperty(process, 'env', { ...process.env, GEMINI_API_KEY: 'fake-secret' });
  const start: Launch = async (job, env, log) => {
    expect(env).toBe(process.env);
    started.push(job); log('fake-secret\n');
    write(job.expected, { status: started.length === 1 ? 'failed' : 'completed' });
    return started.length === 1 ? 1 : 0;
  };
  const options = parseOptions(['run', '--filter', 'current:', '--limit', '2']);
  const first = await executeRerun(c, options, start, p);
  expect(first).toMatchObject({ completed: 1, executed: 2, failed: [started[0]!.id] });
  const firstLog = join(p.results, 'rerun/logs', logName(started[0]!.id));
  expect(readFileSync(firstLog, 'utf8')).toBe('[REDACTED]\n');
  await executeRerun(c, { ...options, limit: 1 }, start, p);
  expect(readFileSync(firstLog, 'utf8')).toBe('[REDACTED]\n[REDACTED]\n');
  const ledger = readLedger(join(p.results, 'rerun/ledger.jsonl'));
  expect(ledger.get(started[0]!.id)?.runStatus).toBe('completed');
  expect(ledger.size).toBe(2);
  expect(logName('a:日本')).not.toBe(logName('a:中国'));
});

test('最大試行後は子を再起動せず、不足 C0 は実行失敗として残す', async () => {
  const p = paths(); const c = config(); const start = jest.fn(async () => 1);
  await executeRerun(c, parseOptions(['freeze', '--filter', 'criteria-only']), start, p);
  expect(start).toHaveBeenCalledTimes(3);
  await executeRerun(c, parseOptions(['freeze', '--filter', 'criteria-only']), start, p);
  expect(start).toHaveBeenCalledTimes(3);
  const run = await executeRerun(c, parseOptions(['run', '--filter', 'current:']), start, p);
  expect(run.failed).toHaveLength(4);
  expect(start).toHaveBeenCalledTimes(3);
});

test('legacy 未指定は拒否し、上書き指定なら旧版 cwd、0 件でも集計行を出す', async () => {
  const { c, p } = frozen(); const start = jest.fn(async () => 0);
  const result = await executeRerun(c, parseOptions(['run', '--filter', 'legacy:', '--limit', '1']), start, p);
  expect(result.failed).toHaveLength(1); expect(start).not.toHaveBeenCalled();
  await executeRerun(c, parseOptions(['run', '--legacy-dir', join(p.root, 'old'), '--filter', 'legacy:', '--limit', '1']), start, p);
  expect(start).toHaveBeenCalledTimes(1);
  await executeRerun(c, parseOptions(['run', '--limit', '0']), start, p);
  expect(jest.mocked(process.stdout.write).mock.calls.flat().join('')).toContain('完了 0 / スキップ 0 / 失敗 0');
});

test('prepare は追加分割のみ、score は旧版結果ディレクトリを指定する', async () => {
  const p = paths(); const start = jest.fn(async () => 0); const c = config();
  await executeRerun(c, parseOptions(['prepare']), start, p);
  await executeRerun(c, parseOptions(['score']), start, p);
  expect(start.mock.calls).toHaveLength(2);
  const calls = start.mock.calls as unknown as [Job][];
  expect(calls[0]![0].command.slice(-2)).toEqual(['--seed', '20260915']);
  expect(calls[1]![0].command.slice(-1)).toEqual([join(p.results, c.legacyResultsSubdir)]);
});

test('ledger は id の最終行勝ちで読み、途中の破損は拒否する', () => {
  const p = join(paths().root, 'ledger.jsonl');
  writeFileSync(p, '{"id":"one","exitCode":1}\n{"id":"two","exitCode":0}\n{"id":"one","exitCode":0}\n');
  expect([...readLedger(p).values()].map((r) => r.exitCode)).toEqual([0, 0]);
  writeFileSync(p, '{"id":"one"}\nbroken\n');
  expect(() => readLedger(p)).toThrow('2 行目');
});
