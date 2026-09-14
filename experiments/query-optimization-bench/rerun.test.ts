/** @jest-environment node */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildRunJobs, executeRerun, logName, makeSlots, parseOptions, readConfig, readLedger, readSlots, slotName, slotsFile,
  type Job, type Launch, type Paths, type Slot } from './rerun';
import { c0FixturePath } from './c0Artifact';
import { getGitCommit } from './gitInfo';
import { PROFILES } from './types';

jest.mock('./gitInfo', () => ({ getGitCommit: jest.fn() }));

const config = () => ({ ...readConfig(), cases: ['r3-vascular-bleeding'], drafts: 1, liveRunsPerSplit: 1 });
const rejection = '#1: 構文エラー\n実測できない C0 は凍結しない。再生成するには --draft で別番号を指定する';
const paths = (): Paths => {
  const root = mkdtempSync(join(tmpdir(), 'rerun-'));
  return { root, fixtures: join(root, 'fixtures'), results: join(root, 'results') };
};
function write(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); }
function frozen(c = config(), p = paths()) {
  const slots = makeSlots(c).map((slot) => ({ ...slot, name: slotName(slot, c.draftStart + slot.slot - 1) }));
  for (const slot of slots) write(c0FixturePath(p.fixtures, slot.caseId, slot.name!), {});
  write(slotsFile(p), slots);
  return { c, p, slots };
}
beforeEach(() => {
  jest.replaceProperty(process, 'env', { ...process.env, GEMINI_API_KEY: 'fake-secret' });
  jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  jest.mocked(getGitCommit).mockReset().mockReturnValue('current');
});
afterEach(() => { jest.restoreAllMocks(); });

test.each(['new', 'legacy', 'both'])('枠記録を復元して run を開始する: %s', async (location) => {
  const p = paths(); const c = config();
  const slots = makeSlots(c).map((slot) => ({ ...slot, name: slotName(slot, 14) }));
  for (const slot of slots) write(c0FixturePath(p.fixtures, slot.caseId, slot.name!), {});
  if (location !== 'legacy') write(slotsFile(p), slots);
  if (location !== 'new') write(join(p.results, 'rerun/c0-slots.json'), location === 'both' ? [] : slots);
  if (location === 'new') expect(existsSync(p.results)).toBe(false);
  expect(readSlots(p)).toEqual(slots);
  const start = jest.fn<ReturnType<Launch>, Parameters<Launch>>(async (job) => {
    expect(job.blocked).toBeUndefined();
    expect(job.c0).toContain('draft14');
    write(job.expected, { status: 'completed' }); return 0;
  });
  const result = await executeRerun(c, parseOptions(['run', '--filter', 'current:']), start, p);
  expect(result).toMatchObject({ completed: 4, failed: [] });
  expect(start).toHaveBeenCalledTimes(4);
});

test('旧枠記録は次の保存で新パスへ移行し、秘密値をマスクする', async () => {
  const p = paths(); const c = config(); const slots = makeSlots(c);
  slots[0]!.pendingDraft = 14;
  const oldPath = join(p.results, 'rerun/c0-slots.json');
  write(oldPath, slots);
  const old = readFileSync(oldPath, 'utf8');
  const start: Launch = async (_job, _env, log) => {
    log(`fake-secret\n${rejection}\n${p.root}\nC:\\private\\freeze.ts:1\n/private/freeze.ts:1\n\\\\server\\share\\freeze.ts:1`); return 1;
  };
  await executeRerun(c, parseOptions(['freeze', '--filter', 'criteria-only', '--limit', '1']), start, p);
  expect(slotsFile(p)).toBe(join(p.root, 'experiments/query-optimization-bench/rerun/c0-slots.json'));
  const raw = readFileSync(slotsFile(p), 'utf8');
  expect(raw).not.toContain('fake-secret');
  expect(raw).toContain('[REDACTED]');
  expect(raw).not.toContain(JSON.stringify(p.root).slice(1, -1));
  expect(raw).not.toContain('private');
  expect(raw).not.toContain('server');
  expect(raw).toContain('[PATH]');
  expect(readSlots(p)[0]!.attempts[0]!.draft).toBe(14);
  expect(readFileSync(oldPath, 'utf8')).toBe(old);
});

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
  delete process.env.GEMINI_API_KEY;
  const p = paths(); const start = jest.fn();
  await executeRerun(config(), parseOptions(['all', '--dry-run']), start, p);
  expect(start).not.toHaveBeenCalled();
  expect(existsSync(p.results)).toBe(false);
  expect(jest.mocked(process.stdout.write).mock.calls.flat().join('')).toContain('legacyWorktree');
});

test.each(['freeze', 'run', 'all'])('%s はキーが未設定・空なら保存や子の起動より前に停止する', async (stage) => {
  const p = paths(); const start = jest.fn();
  for (const key of [undefined, '', '   ']) {
    if (key === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = key;
    await expect(executeRerun(config(), parseOptions([stage]), start, p)).rejects.toThrow('GEMINI_API_KEY が未設定です');
    await expect(executeRerun(config(), parseOptions([stage]), start, p)).rejects.toThrow('DOTENV_CONFIG_PATH');
  }
  expect(start).not.toHaveBeenCalled();
  expect(existsSync(p.results)).toBe(false);
});

test('凍結失敗は次の空き番号で再試行し、各試行を永続化、完了枠は再開でスキップする', async () => {
  const p = paths(); const c = { ...config(), drafts: 3 };
  let calls = 0;
  const start: Launch = jest.fn(async (job, _env, log) => {
    calls++;
    if (calls === 1) { log(rejection); return 1; }
    if (calls === 2) {
      const saved = JSON.parse(readFileSync(slotsFile(p), 'utf8')) as Slot[];
      expect(saved[0]!.attempts).toEqual([{ draft: 11, success: false, error: rejection }]);
    }
    write(job.expected, {}); return 0;
  });
  await executeRerun(c, parseOptions(['freeze']), start, p);
  const saved = JSON.parse(readFileSync(slotsFile(p), 'utf8')) as Slot[];
  expect(saved[0]!.name).toBe('criteria-only-draft14');
  expect(saved[0]!.attempts.map((a) => a.draft)).toEqual([11, 14]);
  expect(saved.slice(1, 3).map((s) => s.name)).toEqual(['criteria-only-draft12', 'criteria-only-draft13']);
  const previous = calls;
  const resumed = await executeRerun(c, parseOptions(['freeze']), start, p);
  expect(calls).toBe(previous);
  expect(resumed.skipped).toBe(9);
});

test('実測拒否の文言はチャンク境界と長い後続ログに依存せず判定する', async () => {
  const p = paths(); const c = config();
  const start = jest.fn<ReturnType<Launch>, Parameters<Launch>>(async (job, _env, log) => {
    if (start.mock.calls.length === 1) {
      for (const char of rejection) log(char);
      log('\n' + 'x'.repeat(5000));
      return 1;
    }
    write(job.expected, {}); return 0;
  });
  const result = await executeRerun(c, parseOptions(['freeze', '--filter', 'criteria-only']), start, p);
  const saved = JSON.parse(readFileSync(slotsFile(p), 'utf8')) as Slot[];
  expect(saved[0]!.attempts.map((a) => a.draft)).toEqual([11, 12]);
  expect(result).toMatchObject({ completed: 1, executed: 2, failed: [start.mock.calls[0]![0].id] });
});

test.each([
  ['GEMINI_API_KEY が未設定です', 1],
  ['fetch failed', 1],
  ['#1: HTTP 503\n実測中に一時的な通信障害があったため凍結しない。同じ番号で再試行できる', 1],
  ['LLM service unavailable', 1],
  ['構文エラー', 1],
  ['', 1],
  ['', 0],
] as const)('実測拒否以外は枠と番号を消費せず、次回だけ再試行する: %s / %s', async (message, exitCode) => {
  const p = paths(); const c = config(); const slots = makeSlots(c);
  const slotsPath = slotsFile(p);
  write(slotsPath, slots);
  const start = jest.fn<ReturnType<Launch>, Parameters<Launch>>(async (_job, _env, log) => { log(message); return exitCode; });
  const options = parseOptions(['freeze']);
  const first = await executeRerun(c, options, start, p);
  const jobs = start.mock.calls.map(([job]) => job);
  expect(jobs).toHaveLength(slots.length);
  expect(jobs.every((job) => job.c0.includes('draft11'))).toBe(true);
  expect(first).toMatchObject({ completed: 0, executed: slots.length, failed: jobs.map((job) => job.id) });
  expect(JSON.parse(readFileSync(slotsPath, 'utf8'))).toEqual(slots.map((slot) => ({ ...slot, pendingDraft: 11 })));
  const ledgerPath = join(p.results, 'rerun/ledger.jsonl');
  for (const job of jobs) {
    expect(readLedger(ledgerPath).get(job.id)).toMatchObject({ exitCode, error: message || `exitCode=${exitCode}, runStatus=null` });
    expect(readFileSync(join(p.results, 'rerun/logs', logName(job.id)), 'utf8')).toBe(message);
  }
  start.mockClear();
  start.mockImplementation(async (job) => { write(job.expected, {}); return 0; });
  const resumed = await executeRerun(c, options, start, p);
  expect(start.mock.calls.map(([job]) => job.command)).toEqual(jobs.map((job) => job.command));
  expect(resumed).toMatchObject({ completed: slots.length, executed: slots.length, failed: [] });
  const saved = JSON.parse(readFileSync(slotsPath, 'utf8')) as Slot[];
  expect(saved.every((slot) => slot.attempts.length === 1 && slot.attempts[0]!.draft === 11 && slot.attempts[0]!.success)).toBe(true);
  expect(saved.every((slot) => slot.pendingDraft === undefined)).toBe(true);
  expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(slots.length * 2);
});

test('過去の未分類の失敗試行は保持し、新しい一時失敗だけを記録しない', async () => {
  const p = paths(); const c = config(); const slots = makeSlots(c);
  slots[0]!.attempts.push({ draft: 11, success: false, error: 'GEMINI_API_KEY が未設定です' });
  const slotsPath = slotsFile(p);
  write(slotsPath, slots);
  const options = parseOptions(['freeze', '--filter', 'criteria-only']);
  const start = jest.fn<ReturnType<Launch>, Parameters<Launch>>(async () => { throw new Error('fetch failed'); });
  await executeRerun(c, options, start, p);
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0]![0].c0).toBe('criteria-only-draft12');
  expect(JSON.parse(readFileSync(slotsPath, 'utf8'))).toEqual(slots.map((slot, i) => i === 0 ? { ...slot, pendingDraft: 12 } : slot));
  start.mockImplementation(async (job) => { write(job.expected, {}); return 0; });
  await executeRerun(c, options, start, p);
  expect(start.mock.calls[1]![0].c0).toBe('criteria-only-draft12');
  const saved = JSON.parse(readFileSync(slotsPath, 'utf8')) as Slot[];
  expect(saved[0]!.attempts).toEqual([...slots[0]!.attempts, { draft: 12, success: true, error: null }]);
});

test('再試行待ちの番号を後続枠が使わず、再開後の生成物の失敗だけで番号を進める', async () => {
  const p = paths(); const c = { ...config(), drafts: 2 };
  const slots = makeSlots(c);
  for (const slot of slots.slice(0, 2)) slot.attempts.push({ draft: 10 + slot.slot, success: false, error: rejection });
  const slotsPath = slotsFile(p);
  write(slotsPath, slots);
  const start = jest.fn<ReturnType<Launch>, Parameters<Launch>>(async () => 1);
  const options = parseOptions(['freeze', '--filter', 'criteria-only']);
  await executeRerun(c, options, start, p);
  expect(start.mock.calls.map(([job]) => job.c0)).toEqual(['criteria-only-draft13', 'criteria-only-draft14']);
  const pending = JSON.parse(readFileSync(slotsPath, 'utf8')) as Slot[];
  expect(pending.slice(0, 2).map((slot) => slot.pendingDraft)).toEqual([13, 14]);
  expect(pending.map((slot) => slot.attempts)).toEqual(slots.map((slot) => slot.attempts));
  start.mockClear();
  start.mockImplementation(async (job, _env, log) => {
    if (start.mock.calls.length === 1) { log(rejection); return 1; }
    write(job.expected, {}); return 0;
  });
  await executeRerun(c, options, start, p);
  expect(start.mock.calls.map(([job]) => job.c0)).toEqual(['criteria-only-draft13', 'criteria-only-draft15', 'criteria-only-draft14']);
  const saved = JSON.parse(readFileSync(slotsPath, 'utf8')) as Slot[];
  expect(saved[0]!.attempts.map((a) => a.draft)).toEqual([11, 13, 15]);
  expect(saved[1]!.attempts.map((a) => a.draft)).toEqual([12, 14]);
  expect(saved.every((slot) => slot.pendingDraft === undefined)).toBe(true);
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
  const p = paths(); const c = config();
  const start = jest.fn<ReturnType<Launch>, Parameters<Launch>>(async (_job, _env, log) => { log(rejection); return 1; });
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
  delete process.env.GEMINI_API_KEY;
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

test.each([
  ['一致', {}, 'current', true],
  ['別コミット', { gitCommit: 'old' }, 'current', false],
  ['oracleRounds', { oracleRounds: 1 }, 'current', false],
  ['maxHits', { maxHits: 1000 }, 'current', false],
  ['HEAD 取得失敗', { gitCommit: null }, null, false],
] as const)('完了結果の条件照合: %s', async (_name, changes, head, skip) => {
  const { c, p, slots } = frozen();
  c.oracleRounds = 0;
  const job = buildRunJobs(c, slots, p)[0]!;
  write(job.expected, { status: 'completed', gitCommit: 'current', maxHits: PROFILES[0].maxHits, ...changes });
  const original = readFileSync(job.expected, 'utf8');
  jest.mocked(getGitCommit).mockReturnValue(head);
  const start = jest.fn();
  const options = parseOptions(['run', '--filter', job.id]);
  await executeRerun(c, { ...options, dryRun: true }, start, p);
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining(skip ? 'スキップ' : '完了結果の条件が一致しません'));
  expect(existsSync(join(p.results, 'rerun/ledger.jsonl'))).toBe(false);
  const result = await executeRerun(c, options, start, p);
  expect(result.skipped).toBe(skip ? 1 : 0);
  expect(result.failed).toEqual(skip ? [] : [job.id]);
  expect(start).not.toHaveBeenCalled();
  expect(readFileSync(job.expected, 'utf8')).toBe(original);
  if (!skip) {
    expect(readLedger(join(p.results, 'rerun/ledger.jsonl')).get(job.id)).toMatchObject({ exitCode: 1, error: expect.stringContaining('label を変えてください') });
    expect(readFileSync(join(p.results, 'rerun/logs', logName(job.id)), 'utf8')).toContain('完了結果の条件が一致しません');
  }
});

test('各チェックアウトの HEAD を一度だけ取得し、旧版は 2000 件でラウンド数に依存せずスキップする', async () => {
  const { c, p, slots } = frozen();
  c.legacyWorktree = join(p.root, 'old');
  c.oracleRounds = 2;
  jest.mocked(getGitCommit).mockImplementation((cwd) => cwd === p.root ? 'current' : 'legacy');
  const jobs = buildRunJobs(c, slots, p);
  for (const job of jobs) write(job.expected, { status: 'completed', gitCommit: job.arm === 'current' ? 'current' : 'legacy',
    maxHits: job.arm === 'current' ? PROFILES[0].maxHits : 2000, oracleRounds: job.arm === 'current' ? 2 : 0 });
  const start = jest.fn();
  const result = await executeRerun(c, parseOptions(['run']), start, p);
  expect(result.skipped).toBe(jobs.length);
  expect(getGitCommit).toHaveBeenCalledTimes(2);
  expect(getGitCommit).toHaveBeenCalledWith(p.root);
  expect(getGitCommit).toHaveBeenCalledWith(c.legacyWorktree);
  expect(start).not.toHaveBeenCalled();
});

test.each(['{"id":"previous"}\n{"id":', '{"id":'])('起動時に ledger の末尾を修復してから追記する: %s', async (raw) => {
  const { c, p } = frozen();
  const ledgerPath = join(p.results, 'rerun/ledger.jsonl');
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, raw);
  const start = jest.fn(async () => 0);
  await executeRerun(c, parseOptions(['score', '--dry-run']), start, p);
  expect(readFileSync(ledgerPath, 'utf8')).toBe(raw);
  expect(start).not.toHaveBeenCalled();
  await executeRerun(c, parseOptions(['score']), start, p);
  const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { id: string });
  expect(lines.map((row) => row.id)).toEqual(raw.includes('\n') ? ['previous', 'score:all:legacy:all'] : ['score:all:legacy:all']);
  expect(readLedger(ledgerPath).size).toBe(lines.length);
  expect(process.stdout.write).toHaveBeenCalledWith('ledger の書きかけの末尾を取り除きました\n');
});
