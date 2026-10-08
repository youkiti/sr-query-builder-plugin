import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { config, parse } from 'dotenv';
import { redact } from '../../query-optimization-bench/ncbiEval';
import { loadConditions, type Conditions } from './conditions';
import { serveRun, type ToolReply } from './relay';
import { readBudget, runPath } from './runDir';
import { parseRunOptions, targetReviews, type RunRuntime } from './startRuns';
import { defaultRuntime } from './tool';

type Status = 'finished' | 'failed' | 'timeout' | 'launch-failed' | 'mismatch';
interface Launch { bin?: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
export interface Runtime extends RunRuntime {
  spawnCodex?: (launch: Launch) => ChildProcessWithoutNullStreams;
  spawnTool?: (launch: Launch) => ChildProcessWithoutNullStreams;
  kill?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
  codexTimeoutMs?: number;
  relayIntervalMs?: number;
}

export function parseOptions(args: string[]) {
  const rest: string[] = [];
  const extra = new Map<string, string>();
  const keys = ['--env-file', '--rps', '--effort', '--concurrency', '--timeout-min', '--codex-bin'];
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (!keys.includes(key)) { rest.push(key); continue; }
    if (extra.has(key) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('実行引数が不正です');
    extra.set(key, args[++i]!);
  }
  const options = parseRunOptions(rest, '--runs');
  const concurrency = Number(extra.get('--concurrency'));
  const rps = Number(extra.get('--rps'));
  const effort = extra.get('--effort') ?? '';
  const timeoutMin = Number(extra.get('--timeout-min') ?? '30');
  const envFile = extra.get('--env-file');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('並行数は 1〜8 の整数を指定してください');
  if (!Number.isFinite(rps) || rps <= 0 || rps * concurrency > 10) throw new Error('通信頻度は正数で、rps × concurrency を 10 以下にしてください');
  if (!['low', 'medium', 'high'].includes(effort)) throw new Error('推論の強さは low / medium / high を指定してください');
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0 || timeoutMin * 60_000 > 2_147_483_647) throw new Error('制限時間が不正です');
  if (!envFile || !isAbsolute(envFile) || !existsSync(envFile) || !statSync(envFile).isFile()) throw new Error('--env-file に存在するファイルの絶対パスが必要です');
  return { ...options, root: resolve(options.root), concurrency, rps, effort, timeoutMin, envFile, codexBin: extra.get('--codex-bin') };
}

function spawnCodex(launch: Launch): ChildProcessWithoutNullStreams {
  const script = launch.env.APPDATA && join(launch.env.APPDATA, 'npm/node_modules/@openai/codex/bin/codex.js');
  const useScript = !launch.bin && process.platform === 'win32' && script && existsSync(script);
  return spawn(useScript ? process.execPath : launch.bin ?? 'codex', useScript ? [script, ...launch.args] : launch.args,
    { cwd: launch.cwd, env: launch.env, shell: false });
}

async function kill(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) return;
  if (process.platform !== 'win32') { child.kill('SIGKILL'); return; }
  await new Promise<void>((resolve, reject) => {
    const task = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
    task.once('error', reject);
    task.once('close', (code) => code === 0 || child.exitCode !== null || child.signalCode !== null
      ? resolve() : reject(new Error('子プロセスを停止できませんでした')));
  });
}

function runTool(launch: Launch, runtime: Runtime, signal: AbortSignal): Promise<ToolReply> {
  return new Promise((resolve, reject) => {
    const child = (runtime.spawnTool ?? ((input) => spawn(process.execPath, input.args,
      { cwd: input.cwd, env: input.env, shell: false })))(launch);
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => { stdout += text; });
    child.stderr.on('data', (text: string) => { stderr += text; });
    const abort = () => { void (runtime.kill ?? kill)(child).catch(reject); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', reject);
    child.once('close', (code) => { signal.removeEventListener('abort', abort); resolve({ code: code ?? 3, stdout, stderr }); });
    child.stdin.end();
  });
}

export function parseLog(text: string) {
  const header = /^OpenAI Codex[^\r\n]*\r?\n--------\r?\n([\s\S]*?)\r?\n--------(?:\r?\n|$)/.exec(text)?.[1];
  const field = (name: string) => header?.split(/\r?\n/).find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2).trim() ?? null;
  const matches = [...text.matchAll(/^tokens used\r?\n([\d,]+)\s*$/gm)];
  const token = matches[matches.length - 1]?.[1];
  const value = token ? Number(token.replace(/,/g, '')) : NaN;
  return { model: field('model'), reasoningEffort: field('reasoning effort'), sandbox: field('sandbox'),
    tokensUsed: Number.isSafeInteger(value) ? value : null };
}

async function runOne(dir: string, attempt: number, conditions: Conditions, options: ReturnType<typeof parseOptions>, runtime: Runtime,
  safe: (text: string) => string, toolEnv: NodeJS.ProcessEnv): Promise<{ status: Status; submitted: boolean }> {
  const startedAt = runtime.now().toISOString();
  const save = (value: unknown) => writeFileSync(join(dir, 'codex-run.json'), safe(JSON.stringify(value, null, 2)) + '\n');
  save({ status: 'started', startedAt, attempt });
  const root = resolve(__dirname, '../../..');
  const relay = serveRun(dir, { conditions, intervalMs: runtime.relayIntervalMs,
    runTool: async (args, signal) => {
      const reply = await runTool({ args: [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'experiments/protocol-to-formula-loop/src/tool.ts'),
        '--run', dir, ...args], cwd: dir, env: toolEnv }, runtime, signal);
      return { ...reply, stdout: safe(reply.stdout), stderr: safe(reply.stderr) };
    } });
  let timedOut = false, launchFailed = false, exitCode: number | null = null, log = '';
  const codexEnv = { ...runtime.env };
  // 道具用の秘密と読み込み設定は作業者へ渡さない。
  for (const key of [...Object.keys(parse(readFileSync(options.envFile))), 'NCBI_API_KEY', 'DOTENV_CONFIG_PATH', 'NODE_OPTIONS']) delete codexEnv[key];
  try {
    await new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = (runtime.spawnCodex ?? spawnCodex)({ bin: options.codexBin, cwd: dir, env: codexEnv,
          args: ['exec', '-m', conditions.model, '-c', `model_reasoning_effort=${options.effort}`, '-s', 'workspace-write',
            '--skip-git-repo-check', '-C', dir, '-o', join(dir, 'codex-last.txt'), '-'] });
      } catch { launchFailed = true; resolve(); return; }
      let pending = '';
      const append = (text: string) => { const clean = safe(text); log += clean; appendFileSync(join(dir, 'codex.log'), clean); };
      const output = (text: string) => {
        pending += text;
        const end = pending.lastIndexOf('\n');
        if (end >= 0) { append(pending.slice(0, end + 1)); pending = pending.slice(end + 1); }
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', output); child.stderr.on('data', output);
      const timer = setTimeout(() => {
        timedOut = true;
        void (runtime.kill ?? kill)(child).catch(reject);
      }, runtime.codexTimeoutMs ?? options.timeoutMin * 60_000);
      child.once('error', () => { launchFailed = true; clearTimeout(timer); });
      child.stdin.on('error', () => undefined);
      child.once('close', (code) => { clearTimeout(timer); append(pending); exitCode = code; resolve(); });
      child.stdin.end(readFileSync(join(dir, 'prompt.txt'), 'utf8'));
    });
  } finally { await relay.stop(); }
  const metadata = parseLog(log);
  const status: Status = timedOut ? 'timeout' : launchFailed ? 'launch-failed' : exitCode !== 0 ? 'failed'
    : metadata.model !== conditions.model || metadata.reasoningEffort !== options.effort || !metadata.sandbox?.startsWith('workspace-write') ? 'mismatch' : 'finished';
  const submitted = existsSync(join(dir, 'submission.json'));
  save({ status, attempt, startedAt, finishedAt: runtime.now().toISOString(), exitCode, ...metadata, submitted });
  return { status, submitted };
}

async function execute(options: ReturnType<typeof parseOptions>, runtime: Runtime, safe: (text: string) => string): Promise<number> {
  const conditions = loadConditions(options.version, runtime.harnessDir);
  if (conditions.runner !== 'codex-relay') throw new Error('実行役が codex-relay の版を指定してください');
  const fileEnv = parse(readFileSync(options.envFile));
  const env = { ...fileEnv, ...runtime.env };
  // 短い値まで伏せると、道具が返す件数などの数字を壊しうるので、8 文字以上の値だけを伏せる。
  const clean = (text: string) => safe(redact(text, [env.NCBI_API_KEY ?? '', ...Object.values(fileEnv).filter((value) => value.length >= 8)]));
  const root = resolve(__dirname, '../../..');
  const dotenv = join(root, 'node_modules/dotenv/config').replace(/\\/g, '/');
  const toolEnv = { ...env, DOTENV_CONFIG_PATH: options.envFile, NODE_OPTIONS: `--require ${/\s/.test(dotenv) ? JSON.stringify(dotenv) : dotenv}`,
    P2F_NCBI_RPS: String(options.rps), PYTHONUTF8: '1' };
  const dirs = targetReviews(options, runtime).flatMap((review) => Array.from({ length: options.runsPerReview }, (_, i) =>
    runPath(options.root, options.version, review.pmcid, i + 1)));
  for (const dir of dirs) if (['prompt.txt', 'tool.sh'].some((file) => !existsSync(join(dir, file)) || !statSync(join(dir, file)).isFile())) {
    throw new Error('prompt.txt または tool.sh がありません');
  }
  const counts = { finished: 0, submitted: 0, failed: 0, timeout: 0, 'launch-failed': 0, mismatch: 0 };
  let skipped = 0, interrupted = 0, executed = 0, next = 0, done = 0;
  const jobs: { dir: string; attempt: number }[] = [];
  for (const dir of dirs) {
    const path = join(dir, 'codex-run.json');
    let previous: { status?: string; attempt?: number; submitted?: boolean } = {};
    if (existsSync(path)) {
      try { previous = JSON.parse(readFileSync(path, 'utf8')) ?? {}; } catch { previous = {}; }
      if (previous.status === 'finished') { skipped++; counts.finished++; if (previous.submitted) counts.submitted++; continue; }
      let unused = false;
      try { const budget = readBudget(dir); unused = budget.measurements === 0 && budget.submissions === 0 && !existsSync(join(dir, 'submission.json')); } catch { /* 不明な予算は再実行しない。 */ }
      if (!unused) { interrupted++; continue; }
    }
    jobs.push({ dir, attempt: Number.isSafeInteger(previous.attempt) && previous.attempt! > 0 ? previous.attempt! + 1 : 1 });
  }
  await Promise.all(Array.from({ length: options.concurrency }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      executed++;
      let result: { status: Status; submitted: boolean };
      try { result = await runOne(job.dir, job.attempt, conditions, options, runtime, clean, toolEnv); }
      catch (error) {
        runtime.stderr(clean(String(error)) + '\n');
        result = { status: 'failed', submitted: existsSync(join(job.dir, 'submission.json')) };
        const path = join(job.dir, 'codex-run.json');
        const started = JSON.parse(readFileSync(path, 'utf8')) as { startedAt: string };
        writeFileSync(path, clean(JSON.stringify({ ...result, attempt: job.attempt, startedAt: started.startedAt,
          finishedAt: runtime.now().toISOString(), exitCode: null, model: null, reasoningEffort: null, sandbox: null, tokensUsed: null }, null, 2)) + '\n');
      }
      counts[result.status]++; if (result.submitted) counts.submitted++;
      const label = job.dir.slice(options.root.length + 1).replace(/\\/g, '/');
      runtime.stdout(clean(`[${++done}/${dirs.length}] ${label}: ${result.status}\n`));
    }
  }));
  runtime.stdout(clean(`対象: ${dirs.length}・今回実行: ${executed}・済みで飛ばした: ${skipped}・finished: ${counts.finished}・submitted: ${counts.submitted}`
    + `・failed: ${counts.failed}・timeout: ${counts.timeout}・launch-failed: ${counts['launch-failed']}・mismatch: ${counts.mismatch}・中断（道具を使った後）: ${interrupted}\n`));
  return counts.finished === dirs.length ? 0 : 1;
}

export async function main(args: string[], runtime: Runtime = defaultRuntime()): Promise<number> {
  const secrets = [runtime.env.NCBI_API_KEY ?? ''];
  const safe = (text: string) => redact(text, secrets);
  try {
    const options = parseOptions(args);
    secrets.push(...Object.values(parse(readFileSync(options.envFile))).filter((value) => value.length >= 8));
    return await execute(options, runtime, safe);
  }
  catch (error) { throw new Error(safe(String(error))); }
}
if (require.main === module) {
  config();
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(redact(String(error), [process.env.NCBI_API_KEY ?? '']) + '\n'); process.exitCode = 1;
  });
}
