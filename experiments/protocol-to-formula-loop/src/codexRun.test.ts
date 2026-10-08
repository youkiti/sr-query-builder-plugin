/** @jest-environment node */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseLog, parseOptions, type Runtime } from './codexRun';
import { loadConditions } from './conditions';
import { runPath } from './runDir';
import { splitReviews } from './split';
import { fixture, record, review, writeJson, writeLines } from './testFixtures';

const secret = '合成NCBI秘密';
const header = 'OpenAI Codex v0.160.0\n--------\nworkdir: 合成\nmodel: gpt-6-astra\nprovider: openai\napproval: never\nsandbox: workspace-write [workdir, /tmp, $TMPDIR]\nreasoning effort: medium\nreasoning summaries: none\nsession id: 合成\n--------\n';
function child() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 123,
    exitCode: null, signalCode: null }) as unknown as ChildProcessWithoutNullStreams & { stdout: PassThrough; stderr: PassThrough };
}
function setup(runs = 1, concurrency = 1) {
  const root = mkdtempSync(join(tmpdir(), 'p2f-codex-'));
  const casesDir = join(root, 'cases'), harnessDir = join(root, 'harness');
  const rows = Array.from({ length: 10 }, (_, i) => review(i + 1)); fixture(root, rows);
  const selected = rows.find((row) => splitReviews(rows).get(row.pmcid) === 'development')!;
  writeLines(join(casesDir, 'evaluable.jsonl'), rows.map((row) => record(row)));
  writeJson(join(casesDir, 'subsets.json'), { smoke: [selected.pmcid] });
  const conditionFile = join(harnessDir, 'v1a', 'conditions.json'); writeJson(conditionFile, loadConditions('v1a'));
  const dirs = Array.from({ length: runs }, (_, i) => runPath(join(root, 'runs'), 'v1a', selected.pmcid, i + 1));
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'prompt.txt'), '合成手順書'); writeFileSync(join(dir, 'tool.sh'), '実行は禁止');
    writeJson(join(dir, 'budget.json'), { measurements: 0, submissions: 0 });
  }
  const envFile = join(root, 'secret.env'); writeFileSync(envFile, `NCBI_API_KEY=${secret}\n`);
  const spawnCodex = jest.fn<ChildProcessWithoutNullStreams, [Parameters<NonNullable<Runtime['spawnCodex']>>[0]]>(() => {
    const c = child(); setImmediate(() => { c.stdout.write(header + 'tokens used\n1,234\n'); c.emit('close', 0); }); return c;
  });
  const runtime: Runtime = { casesDir, harnessDir, env: { COCHRANE_BENCH_DIR: root, NCBI_API_KEY: secret },
    now: () => new Date('2026-01-01T00:00:00Z'), stdout: jest.fn(), stderr: jest.fn(), fetchImpl: jest.fn(),
    spawnCodex, spawnTool: jest.fn(() => { throw new Error('本物の道具は禁止です'); }),
    kill: jest.fn(async (c) => { c.emit('close', null); }), relayIntervalMs: 5 };
  const args = ['--runs', join(root, 'runs'), '--version', 'v1a', '--subset', 'smoke', '--runs-per-review', String(runs),
    '--env-file', envFile, '--rps', '1', '--effort', 'medium', '--concurrency', String(concurrency)];
  const read = (name: string, i = 0) => readFileSync(join(dirs[i]!, name), 'utf8');
  const state = (i = 0) => JSON.parse(read('codex-run.json', i)) as Record<string, unknown>;
  const output = () => JSON.stringify([(runtime.stdout as jest.Mock).mock.calls, (runtime.stderr as jest.Mock).mock.calls]);
  return { root, dirs, args, runtime, spawnCodex, conditionFile, read, state, output, casesDir };
}
test.each([['--concurrency', '0'], ['--concurrency', '9'], ['--concurrency', '1.5'], ['--rps', '11'], ['--effort', 'max'], ['--timeout-min', '0']])(
  '不正な引数を起動前に拒否する: %s %s', async (flag, value) => {
    const s = setup();
    if (s.args.includes(flag)) s.args[s.args.indexOf(flag) + 1] = value;
    else s.args.push(flag, value);
    await expect(main(s.args, s.runtime)).rejects.toThrow(); expect(s.spawnCodex).not.toHaveBeenCalled();
  });
test('全プロセス合計の通信頻度と実行役を検査する', async () => {
  const s = setup(1, 4); s.args[s.args.indexOf('--rps') + 1] = '3';
  expect(() => parseOptions(s.args)).toThrow('10 以下');
  s.args[s.args.indexOf('--rps') + 1] = '1';
  writeJson(s.conditionFile, { ...loadConditions('v1a'), runner: 'claude-subagent' });
  await expect(main(s.args, s.runtime)).rejects.toThrow('codex-relay'); expect(s.spawnCodex).not.toHaveBeenCalled();
});

test.each([false, true])('固定した引数と標準入力で起動し、提出の有無を記録する: %s', async (submitted) => {
  const s = setup();
  if (submitted) writeJson(join(s.dirs[0]!, 'submission.json'), {});
  let prompt = '';
  s.spawnCodex.mockImplementation((launch) => {
    expect(launch.args).toEqual(['exec', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=medium', '-s', 'workspace-write',
      '--skip-git-repo-check', '-C', s.dirs[0], '-o', join(s.dirs[0]!, 'codex-last.txt'), '-']);
    expect(launch.args.join(' ')).not.toMatch(/network_access|dangerously/);
    expect(JSON.stringify(launch.env)).not.toContain(secret);
    const c = child(); c.stdin.on('data', (value: Buffer) => { prompt += value.toString(); });
    setImmediate(() => { c.stdout.write(header); c.stderr.write('tokens used\n1,234\n'); c.emit('close', 0); }); return c;
  });
  expect(await main(s.args, s.runtime)).toBe(0); expect(prompt).toBe('合成手順書');
  expect(s.state()).toMatchObject({ status: 'finished', attempt: 1, exitCode: 0, model: 'gpt-6-astra', reasoningEffort: 'medium', tokensUsed: 1234, submitted });
  expect(s.output()).toContain('[1/1] v1a/'); expect(s.output()).toContain('finished: 1');
});

test.each([
  ['失敗終了', 2, header, 'failed'], ['モデルの不一致', 0, header.replace('gpt-6-astra', '別モデル'), 'mismatch'],
  ['推論の不一致', 0, header.replace('effort: medium', 'effort: high'), 'mismatch'],
  ['サンドボックスの不一致', 0, header.replace('workspace-write', 'read-only'), 'mismatch'], ['ヘッダなし', 0, '本文', 'mismatch'],
])('終了状態を判別する: %s', async (_label, code, text, status) => {
  const s = setup(); s.spawnCodex.mockImplementation(() => {
    const c = child(); setImmediate(() => { c.stdout.write(text); c.emit('close', code); }); return c;
  });
  expect(await main(s.args, s.runtime)).toBe(1); expect(s.state().status).toBe(status); expect(s.state().tokensUsed).toBeNull();
});
test.each(['同期例外', '起動エラー'])('起動失敗を記録する: %s', async (kind) => {
  const s = setup(); s.spawnCodex.mockImplementation(() => {
    if (kind === '同期例外') throw new Error(secret);
    const c = child(); setImmediate(() => { c.emit('error', new Error(secret)); c.emit('close', -1); }); return c;
  });
  expect(await main(s.args, s.runtime)).toBe(1); expect(s.state().status).toBe('launch-failed');
  expect(s.read('codex-run.json') + s.output()).not.toContain(secret);
});
test('制限時間では停止関数を呼び、終了コードより timeout を優先する', async () => {
  const s = setup(); s.runtime.codexTimeoutMs = 10; s.spawnCodex.mockImplementation(() => child());
  expect(await main(s.args, s.runtime)).toBe(1); expect(s.runtime.kill).toHaveBeenCalledTimes(1); expect(s.state().status).toBe('timeout');
});

test('済みは飛ばし、道具未使用の中断だけ再開し、古いログのヘッダを使わない', async () => {
  const s = setup(3);
  writeJson(join(s.dirs[0]!, 'codex-run.json'), { status: 'finished', submitted: true });
  writeJson(join(s.dirs[1]!, 'codex-run.json'), { status: 'started', attempt: 2 });
  writeFileSync(join(s.dirs[1]!, 'codex.log'), header.replace('gpt-6-astra', '古いモデル'));
  writeJson(join(s.dirs[2]!, 'codex-run.json'), { status: 'started' });
  writeJson(join(s.dirs[2]!, 'budget.json'), { measurements: 1, submissions: 0 });
  expect(await main(s.args, s.runtime)).toBe(1); expect(s.spawnCodex).toHaveBeenCalledTimes(1);
  expect(s.state(1)).toMatchObject({ status: 'finished', attempt: 3 }); expect(s.state(2).status).toBe('started');
  expect(s.output()).toContain('今回実行: 1'); expect(s.output()).toContain('済みで飛ばした: 1'); expect(s.output()).toContain('中断（道具を使った後）: 1');
});
test.each(['提出回数', '提出ファイル', '予算なし'])('使用済みまたは不明な中断を作り直さない: %s', async (kind) => {
  const s = setup(); const dir = s.dirs[0]!; writeJson(join(dir, 'codex-run.json'), { status: 'started' });
  if (kind === '提出回数') writeJson(join(dir, 'budget.json'), { measurements: 0, submissions: 1 });
  if (kind === '提出ファイル') writeJson(join(dir, 'submission.json'), {});
  if (kind === '予算なし') unlinkSync(join(dir, 'budget.json'));
  expect(await main(s.args, s.runtime)).toBe(1); expect(s.spawnCodex).not.toHaveBeenCalled(); expect(s.output()).toContain('中断（道具を使った後）: 1');
});
test('済みだけなら終了値はゼロで、集計に数える', async () => {
  const s = setup(); writeJson(join(s.dirs[0]!, 'codex-run.json'), { status: 'finished', submitted: false });
  expect(await main(s.args, s.runtime)).toBe(0); expect(s.spawnCodex).not.toHaveBeenCalled(); expect(s.output()).toContain('finished: 1');
});
test('同時実行の上限を保ち、一件の失敗後も残りを実行する', async () => {
  const s = setup(6, 2); let active = 0, maximum = 0, index = 0;
  s.spawnCodex.mockImplementation(() => {
    active++; maximum = Math.max(maximum, active); const code = index++ === 0 ? 1 : 0; const c = child();
    setTimeout(() => { active--; c.stdout.write(header); c.emit('close', code); }, 10); return c;
  });
  expect(await main(s.args, s.runtime)).toBe(1); expect(maximum).toBe(2); expect(active).toBe(0); expect(s.spawnCodex).toHaveBeenCalledTimes(6);
  expect(s.output()).toContain('finished: 5'); expect(s.output()).toContain('failed: 1');
});
test.each(['prompt.txt', 'tool.sh'])('後のフォルダに %s がなければ何も起動しない', async (file) => {
  const s = setup(2); unlinkSync(join(s.dirs[1]!, file));
  await expect(main(s.args, s.runtime)).rejects.toThrow('ありません'); expect(s.spawnCodex).not.toHaveBeenCalled();
  expect(existsSync(join(s.dirs[0]!, 'codex-run.json'))).toBe(false);
});
test('対象がゼロでも集計を一行出す', async () => {
  const s = setup(); writeJson(join(s.casesDir, 'subsets.json'), { smoke: [] });
  expect(await main(s.args, s.runtime)).toBe(0); expect(s.runtime.stdout).toHaveBeenCalledTimes(1); expect(s.output()).toContain('対象: 0');
});
test('秘密を分割して出力しても、ログ・記録・進捗には残さない', async () => {
  const s = setup(); s.spawnCodex.mockImplementation(() => {
    const c = child(); setImmediate(() => {
      c.stdout.write(header.replace('model: gpt-6-astra', `model: ${secret}`));
      c.stderr.write(secret.slice(0, 3)); c.stderr.write(secret.slice(3)); c.stderr.write('\n'); c.emit('close', 0);
    }); return c;
  });
  expect(await main(s.args, s.runtime)).toBe(1);
  expect(s.read('codex.log') + s.read('codex-run.json') + s.output()).not.toContain(secret);
  expect(s.read('codex.log')).toContain('[REDACTED]');
});
test('末尾のトークン数を読み、本文にある偽のヘッダは採用しない', () => {
  expect(parseLog(header + 'tokens used\n1,234\ntokens used\n5,678\n').tokensUsed).toBe(5678);
  expect(parseLog('本文\n' + header).model).toBeNull();
});

test('環境ファイルだけにある秘密も起動前のエラーから除く', async () => {
  const s = setup(); delete s.runtime.env.NCBI_API_KEY;
  s.runtime.harnessDir = join(s.root, secret);
  await expect(main(s.args, s.runtime)).rejects.not.toThrow(secret);
  expect(s.spawnCodex).not.toHaveBeenCalled();
});

test('中継の準備に失敗しても記録を確定し、ほかの実行を続ける', async () => {
  const s = setup(2); writeFileSync(join(s.dirs[0]!, '.relay'), 'フォルダではありません');
  expect(await main(s.args, s.runtime)).toBe(1);
  expect(s.state()).toMatchObject({ status: 'failed', attempt: 1, exitCode: null, submitted: false });
  expect(s.state(1).status).toBe('finished'); expect(s.spawnCodex).toHaveBeenCalledTimes(1);
});

test('中継はリポジトリの道具を配列で起動し、秘密を伏せた結果を届ける', async () => {
  const s = setup(); let launch: Parameters<NonNullable<Runtime['spawnTool']>>[0] | undefined;
  s.runtime.spawnTool = jest.fn((input) => {
    launch = input; const c = child(); setImmediate(() => { c.stdout.write(`結果 ${secret}`); c.stderr.write('診断'); c.emit('close', 4); }); return c;
  });
  s.spawnCodex.mockImplementation(({ cwd }) => {
    const c = child();
    writeFileSync(join(cwd, '.relay', 'sample.req'), Buffer.from('mesh\0a b\0'));
    const timer = setInterval(() => {
      if (!existsSync(join(cwd, '.relay', 'sample.done'))) return;
      clearInterval(timer); c.stdout.write(header); c.emit('close', 0);
    }, 5);
    return c;
  });
  expect(await main(s.args, s.runtime)).toBe(0);
  expect(launch?.args.slice(-4)).toEqual(['--run', s.dirs[0], 'mesh', 'a b']);
  expect(launch?.args[0]?.replace(/\\/g, '/')).toMatch(/node_modules\/tsx\/dist\/cli.mjs$/);
  expect(launch?.args[1]?.replace(/\\/g, '/')).toMatch(/experiments\/protocol-to-formula-loop\/src\/tool.ts$/);
  expect(launch?.cwd).toBe(s.dirs[0]); expect(launch?.env).toMatchObject({ P2F_NCBI_RPS: '1', PYTHONUTF8: '1', NCBI_API_KEY: secret });
  expect(s.read('.relay/sample.out')).toBe('結果 [REDACTED]'); expect(s.read('.relay/sample.err')).toBe('診断'); expect(s.read('.relay/sample.code')).toBe('4');
});
