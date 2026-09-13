/** @jest-environment node */
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { FIXTURES, loadSeedsFile, SEED, seedSplitId } from './prepare';
import { hashC0Content, loadC0Artifact } from './c0Artifact';
import { CASES } from './types';
import { join } from 'node:path';
import { decideExisting, resultDir, loggedFactory, main, memoryCheckpoint, parseArgs, reportError, RESULTS } from './run';
import { reportRows, renderCsv, renderMarkdown } from './report';
import type { RunResult } from './types';

describe('CLI のエラー表示', () => {
  const originalExitCode = process.exitCode;
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    jest.replaceProperty(process, 'env', { ...process.env });
    delete process.env.GEMINI_API_KEY;
    delete process.env.NCBI_API_KEY;
    process.exitCode = 0;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  test.each([
    [['--dry-run', '--label', 'bad/label'], '--label は英数字・.・_・- の 1〜40 文字で指定してください'],
    [['--profile', 'tight-1000', '--max-hits', '1000'], '--profile と --max-hits は同時に指定できません'],
  ])('引数エラーの理由を stderr に表示して終了コードを 1 にする: %j', async (args, message) => {
    await main(args).catch(reportError);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(`${message}\n`);
    expect(process.exitCode).toBe(1);
  });

  test.each([true, false])('Error かどうかにかかわらず環境変数と URL のキーをマスクする: %s', (isError) => {
    process.env.GEMINI_API_KEY = 'テスト用 Gemini 秘密値';
    process.env.NCBI_API_KEY = 'テスト用 NCBI 秘密値';
    const message = `実行失敗: ${process.env.GEMINI_API_KEY} ${process.env.NCBI_API_KEY} `
      + 'https://example.invalid/?api_key=テスト値&key=別のテスト値&mode=test';
    reportError(isError ? new Error(message) : message);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith('実行失敗: [REDACTED] [REDACTED] https://example.invalid/?api_key=[REDACTED]&key=[REDACTED]&mode=test\n');
    expect(process.exitCode).toBe(1);
  });
});

test('CLI から未知ケース・未知プロファイルを拒否し、既定値を解決する', () => {
  expect(parseArgs(['--dry-run']).dryRun).toBe(true);
  expect(parseArgs([]).profile).toEqual({ id: 'default', maxHits: 2000, maxIterations: 5, postHoc: false });
  expect(parseArgs([]).seed).toBe(20260912);
  expect(parseArgs([]).postHoc).toBe(false);
  expect(parseArgs(['--profile', 'tight-1000']).profile).toEqual({ id: 'tight-1000', maxHits: 1000, maxIterations: 5, postHoc: true });
  expect(parseArgs(['--profile', 'tight-1000']).postHoc).toBe(true);
  expect(() => parseArgs(['--profile', 'unknown'])).toThrow('未知のプロファイル');
  expect(() => parseArgs(['--profile'])).toThrow();
  expect(() => parseArgs(['--maxHits', '5'])).toThrow();
  expect(() => parseArgs(['--max-hits=1000'])).toThrow();
  expect(() => parseArgs(['--max-iterations', '10'])).toThrow();
  expect(() => parseArgs(['--case', 'unknown'])).toThrow();
});
test('--max-hits は事後探索の custom プロファイルを発行し、--profile と同時指定できない', () => {
  const parsed = parseArgs(['--max-hits', '1000']);
  expect(parsed.profile).toEqual({ id: 'custom-1000', maxHits: 1000, maxIterations: 5 });
  expect(parsed.postHoc).toBe(true);
  expect(() => parseArgs(['--max-hits', '0'])).toThrow('正の整数');
  expect(() => parseArgs(['--max-hits', 'abc'])).toThrow('正の整数');
  expect(() => parseArgs(['--profile', 'tight-1000', '--max-hits', '1000'])).toThrow('同時に指定できません');
});
test('--seeds は分割用の乱数を受け取り、既定は SEED', () => {
  expect(parseArgs(['--seeds', '42']).seed).toBe(42);
  expect(() => parseArgs(['--seeds', 'Invalid'])).toThrow();
});
test('--c0 は名前をそのまま受け取る', () => {
  expect(parseArgs(['--c0', 'seeded-draft1']).c0Name).toBe('seeded-draft1');
  expect(parseArgs([]).c0Name).toBeUndefined();
});
test('--replay は --c0 と併用必須で、名前は C0 と同じ命名規則を要求する', () => {
  expect(parseArgs(['--c0', 'seeded-draft1', '--replay', 'pr104-r2']).replayName).toBe('pr104-r2');
  expect(parseArgs([]).replayName).toBeUndefined();
  expect(() => parseArgs(['--replay', 'pr104-r2'])).toThrow('--c0 と併用してください');
  expect(() => parseArgs(['--c0', 'x', '--replay', 'Bad_Name'])).toThrow('英小文字');
  expect(() => parseArgs(['--c0', 'x', '--replay', '1abc'])).toThrow('英小文字');
});
test('checkpoint はメモリだけを使う', async () => {
  const checkpoint = memoryCheckpoint();
  expect(await checkpoint.read('x')).toBeUndefined();
  await checkpoint.write({ x: { value: 1 } });
  expect(await checkpoint.read('x')).toEqual({ value: 1 });
});
test('purpose・全文・トークン・所要時間を成功時と失敗時に保存する', async () => {
  const write = jest.fn();
  const paths: string[] = [];
  const onUsage = jest.fn();
  const chat = jest.fn().mockResolvedValueOnce({ text: 'full response', tokensIn: 3, tokensOut: 4, raw: {} }).mockRejectedValueOnce(new Error('offline'));
  const factory = loggedFactory({ model: 'fake', providerId: 'gemini', chat }, write, paths, onUsage);
  await factory.forPurpose('extract_protocol').chat([{ role: 'user', content: 'full prompt' }]);
  await expect(factory.forPurpose('draft_block').chat([])).rejects.toThrow('offline');
  expect(onUsage.mock.calls).toEqual([['fake', 3, 4, true], ['fake', null, null, false]]);
  expect(paths).toEqual(['llm/0001_extract_protocol.json', 'llm/0002_draft_block.json']);
  expect(write.mock.calls[0]![1]).toMatchObject({ purpose: 'extract_protocol', tokensIn: 3, tokensOut: 4, latencyMs: expect.any(Number),
    messages: [{ role: 'user', content: 'full prompt' }], response: { text: 'full response' } });
  expect(write.mock.calls[1]![1]).toMatchObject({ error: 'offline', response: null });
});
test('dry-run は実ネットワークを呼ばず全 fixture を読む', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実 API 禁止'));
  try {
    await main(['--dry-run']);
    await main(['--profile', 'tight-1000', '--dry-run']);
    await main(['--max-hits', '500', '--dry-run']);
    await main(['--seeds', '20260912', '--dry-run']);
    expect(fetch).not.toHaveBeenCalled();
  }
  finally { fetch.mockRestore(); }
});
test('報告は失敗と B1 欠測を残し、B1 入力があれば未計測の式を表示する', () => {
  const run: RunResult = { id: 'case', runId: 'run', status: 'failed', startedAt: '', model: 'fake', searchDate: '2021-04-15',
    profileId: 'default', maxHits: 10000, maxIterations: 5, conditions: {}, apiCalls: { ncbi: 1, llm: 2 }, apiElapsedMs: { ncbi: 1, llm: 2 }, elapsedMs: 3, llmLogs: [] };
  expect(reportRows([run])[3]!.slice(0, 5)).toEqual(['default', 'case', 'B1', '欠測', '欠測']);
  expect(reportRows([run], { case: 'original' })[3]).toContain('original');
  expect(renderCsv([['a,b', '"x"', 'a\nb']])).toContain('"a,b","""x""","a\nb"');
  expect(renderMarkdown([['a'], ['x|y\nz']])).toContain('x\\|y<br>z');
});


test('--label は安全な名前を 1 回だけ受け取り、分割と同じ階層に置く', () => {
  expect(parseArgs(['--label', 'baseline']).label).toBe('baseline');
  expect(parseArgs(['--label', 'A.z_0-']).label).toBe('A.z_0-');
  expect(parseArgs(['--label', 'x'.repeat(40)]).label).toHaveLength(40);
  for (const value of ['', 'a b', 'x'.repeat(41), 'a/b', 'a\n']) expect(() => parseArgs(['--label', value])).toThrow();
  expect(() => parseArgs(['--label'])).toThrow();
  expect(() => parseArgs(['--label', 'a', '--label', 'b'])).toThrow();
  expect(resultDir('results', 'default', 'case', 'draft', 's42', 'baseline')).toBe(join('results', 'default', 'case', 'draft', 's42+baseline'));
  expect(resultDir('results', 'default', 'case', 'draft', 's42')).toBe(join('results', 'default', 'case', 'draft', 's42'));
});

test('resultDir は replay 名を分割キーへ +replay-<name> で連結し、label があればその後ろに続ける', () => {
  expect(resultDir('results', 'default', 'case', 'draft', 's42', undefined, 'pr104-r2'))
    .toBe(join('results', 'default', 'case', 'draft', 's42+replay-pr104-r2'));
  expect(resultDir('results', 'default', 'case', 'draft', 's42', 'baseline', 'pr104-r2'))
    .toBe(join('results', 'default', 'case', 'draft', 's42+baseline+replay-pr104-r2'));
});

test('完了結果は maxHits とコミットの厳密一致でだけスキップし、別コミットなら変更せず拒否する', () => {
  const existing = Object.freeze({ status: 'completed', maxHits: 2000, gitCommit: 'aaaaaaaaaaaa111' }) as RunResult;
  const original = JSON.stringify(existing);
  const profile = { maxHits: 2000 };
  expect(decideExisting(existing, profile, existing.gitCommit!)).toBe('skip');
  expect(() => decideExisting(existing, profile, 'bbbbbbbbbbbb222')).toThrow('既存=aaaaaaaaaaaa, 現在=bbbbbbbbbbbb');
  expect(() => decideExisting(existing, profile, null)).toThrow('--label');
  expect(JSON.stringify(existing)).toBe(original);
  expect(decideExisting({ ...existing, gitCommit: null }, profile, null)).toBe('skip');
  expect(() => decideExisting({ ...existing, gitCommit: undefined }, profile, null)).toThrow('--label');
  expect(decideExisting({ ...existing, status: 'failed' }, profile, 'other')).toBe('run');
  expect(decideExisting(existing, { maxHits: 1000 }, 'other')).toBe('run');
});

test('dry-run は label を表示する', async () => {
  const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    await main(['--dry-run', '--label', 'baseline']);
    expect(stdout.mock.calls.some(([text]) => String(text).includes('label=baseline'))).toBe(true);
  } finally { stdout.mockRestore(); }
});

test('既存の全凍結 C0 は optimize の --c0 検証経路を通信無しで通る', async () => {
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実 API 禁止'));
  const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    for (const { id } of CASES) {
      for (const name of ['criteria-only-draft1', 'seeded-draft1']) {
        await main(['--case', id, '--c0', name, '--dry-run']);
        expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining(`c0=${name}`));
        expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining('dry-run OK'));
      }
    }
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); stdout.mockRestore(); }
});

test('--replay は --c0 とのハッシュ照合まで dry-run で検証し、通信なしで通る', async () => {
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実 API 禁止'));
  const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    await main(['--case', 'r2-pdr-prognostic', '--c0', 'criteria-only-draft2', '--replay', 'pr104-r2', '--dry-run']);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining('replay=pr104-r2'));
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining('dry-run OK'));
    expect(resultDir(RESULTS, 'default', 'r2-pdr-prognostic', 'criteria-only-draft2', 's20260912', undefined, 'pr104-r2'))
      .toBe(join(RESULTS, 'default', 'r2-pdr-prognostic', 'criteria-only-draft2', 's20260912+replay-pr104-r2'));
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); stdout.mockRestore(); }
});

test('--replay の適用先 C0 が実行時の --c0 と一致しなければ dry-run でも拒否する', async () => {
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実 API 禁止'));
  const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  const originalExitCode = process.exitCode;
  try {
    await main(['--case', 'r2-pdr-prognostic', '--c0', 'criteria-only-draft1', '--replay', 'pr104-r2', '--dry-run']);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining('一致しない'));
    expect(network).not.toHaveBeenCalled();
  } finally { process.exitCode = originalExitCode; network.mockRestore(); stdout.mockRestore(); }
});

test('名前付き集合と取り込み C0 を optimize が照合し、名前を結果キーに使用する', async () => {
  const id = CASES[0].id;
  const root = mkdtempSync(join(tmpdir(), 'run-named-'));
  const fixturesDir = join(root, 'fixtures');
  const resultsDir = join(root, 'results');
  const dir = join(fixturesDir, id);
  mkdirSync(dir, { recursive: true });
  cpSync(join(FIXTURES, id), dir, { recursive: true });
  const seeds = { name: 'without-one', selections: loadSeedsFile(dir, SEED).selections };
  writeFileSync(join(dir, 'seeds-without-one.json'), JSON.stringify(seeds));
  const { sha256, ...base } = loadC0Artifact(fixturesDir, id, 'seeded-draft1');
  expect(hashC0Content(base)).toBe(sha256);
  const content = { ...base, source: 'import' as const, sourceFilename: 'search_formula.md', seedSplit: 'without-one' };
  const name = 'seeded-draft2-without-one';
  writeFileSync(join(dir, 'c0', `${name}.json`), JSON.stringify({ ...content, sha256: hashC0Content(content) }));
  const network = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('実 API 禁止'));
  const stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  const originalExitCode = process.exitCode;
  try {
    const args = ['--case', id, '--seeds', 'without-one', '--c0', name, '--dry-run'];
    await main(args, fixturesDir, resultsDir);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining(`seedSplit=without-one, c0=${name}`));
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining('dry-run OK'));
    expect(resultDir(resultsDir, 'default', id, name, seedSplitId(parseArgs(['--seeds', 'without-one']).seed)))
      .toBe(join(resultsDir, 'default', id, name, 'without-one'));
    await main(['--case', id, '--seeds', 'without-one', '--c0', 'seeded-draft1', '--dry-run'], fixturesDir, resultsDir);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining('シード分割 (s20260912) が実行時の分割 (without-one) と一致しません'));
    writeFileSync(join(dir, 'seeds-without-one.json'), JSON.stringify({ ...seeds, name: 'other' }));
    await main(args, fixturesDir, resultsDir);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining('要求した集合'));
    expect(network).not.toHaveBeenCalled();
    expect(existsSync(resultsDir)).toBe(false);
  } finally { process.exitCode = originalExitCode; network.mockRestore(); stdout.mockRestore(); }
});
