import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { c0FileName, c0FixturePath, type C0Variant } from './c0Artifact';
import { FIXTURES, SEED, seedSplitId } from './prepare';
import { redact } from './ncbiEval';
import { getGitCommit } from './gitInfo';
import { CASES, PROFILES, type RunResult } from './types';

export const BENCH = resolve(__dirname);
export const RESULTS = join(BENCH, 'results');
export const CONFIG = join(BENCH, 'rerun/config.json');
export interface RerunConfig {
  cases: string[]; splits: number[]; drafts: number; draftStart: number; maxDraftAttempts: number;
  legacyWorktree: string | null; labels: Record<Arm, string>; legacyProfile: string; legacyResultsSubdir: string;
  oracleRounds: number; liveRunsPerSplit: number;
}
export type Arm = 'current' | 'legacy' | 'legacyLive';
export interface Slot {
  id: string; caseId: string; variant: C0Variant; split: number | null; slot: number; name: string | null;
  attempts: { draft: number; success: boolean; error: string | null }[];
  pendingDraft?: number;
}
export interface Job {
  id: string; arm: Arm | 'prepare' | 'freeze' | 'score'; caseId: string; c0: string; split: number;
  variant?: C0Variant; command: string[]; cwd: string; expected: string; blocked?: string;
}
export interface LedgerRow {
  id: string; arm: Job['arm']; command: string[]; startedAt: string; finishedAt: string; exitCode: number; runStatus: string | null; error?: string;
}
export interface Options { stage: string; config: string; legacyDir?: string; filter?: string; limit: number; dryRun: boolean }
export interface Paths { root: string; fixtures: string; results: string }
export const defaultPaths: Paths = { root: resolve(BENCH, '../..'), fixtures: FIXTURES, results: RESULTS };
export const readJson = <T>(path: string): T | null => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : null;
const secrets = () => Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)).map(([, value]) => value ?? '');
export const mask = (value: string): string => redact(value, secrets());
export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, mask(JSON.stringify(value, null, 2)) + '\n');
  renameSync(temp, path);
}
export function readConfig(path = CONFIG): RerunConfig {
  const config = readJson<RerunConfig>(path);
  if (!config) throw new Error(`設定がありません: ${path}`);
  const segment = (s: unknown) => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s);
  if (!Array.isArray(config.cases) || !config.cases.length || new Set(config.cases).size !== config.cases.length
    || config.cases.some((id) => !CASES.some((c) => c.id === id))) throw new Error('cases は登録済みの重複しないケースを指定してください');
  if (!Array.isArray(config.splits) || !config.splits.length || config.splits[0] !== SEED || new Set(config.splits).size !== config.splits.length
    || config.splits.some((n) => !Number.isSafeInteger(n) || n < 0)) throw new Error('splits は既定分割を先頭に、重複しない非負整数を指定してください');
  for (const key of ['drafts', 'draftStart', 'maxDraftAttempts', 'liveRunsPerSplit'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} は正の整数です`);
  }
  if (!Number.isSafeInteger(config.oracleRounds) || config.oracleRounds < 0 || config.oracleRounds > 2) throw new Error('oracleRounds は 0〜2 です');
  if (!segment(config.legacyProfile) || !segment(config.legacyResultsSubdir)) throw new Error('旧版保存先の名前が不正です');
  for (const arm of ['current', 'legacy', 'legacyLive'] as const) {
    const label = config.labels?.[arm];
    if (typeof label !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(label) || /^replay-/i.test(label)
      || (arm === 'legacyLive' && `${label}-${config.liveRunsPerSplit}`.length > 40)) throw new Error('label が不正です');
  }
  if (config.labels.legacy === config.labels.legacyLive || config.legacyWorktree !== null && !isAbsolute(config.legacyWorktree)) throw new Error('旧版設定が不正です');
  return config;
}
export function parseOptions(args: string[]): Options {
  const stage = args[0] ?? '';
  if (!['prepare', 'freeze', 'run', 'score', 'all'].includes(stage)) throw new Error('prepare / freeze / run / score / all を指定してください');
  const options: Options = { stage, config: CONFIG, limit: Infinity, dryRun: false };
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) throw new Error(`引数が重複しています: ${flag}`);
    seen.add(flag);
    if (flag === '--dry-run') { options.dryRun = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`引数の値がありません: ${flag}`);
    if (flag === '--config') options.config = resolve(value);
    else if (flag === '--legacy-dir') { if (!isAbsolute(value)) throw new Error('--legacy-dir は絶対パスです'); options.legacyDir = value; }
    else if (flag === '--filter') options.filter = value;
    else if (flag === '--limit') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--limit は非負整数です');
      options.limit = Number(value);
    } else throw new Error(`未知の引数: ${flag}`);
  }
  return options;
}
export function slotName(slot: Slot, draft: number): string {
  return c0FileName(slot.variant, draft, slot.split !== null && slot.split !== SEED ? seedSplitId(slot.split) : null);
}
export function makeSlots(config: RerunConfig, saved: Slot[] = []): Slot[] {
  return config.cases.flatMap((caseId) => ([null, ...config.splits] as (number | null)[]).flatMap((split) =>
    Array.from({ length: config.drafts }, (_, i) => {
      const variant = split === null ? 'criteria-only' : 'seeded';
      const id = `${caseId}:${variant}:${split === null ? 'shared' : seedSplitId(split)}:${i + 1}`;
      return saved.find((slot) => slot.id === id) ?? { id, caseId, variant, split, slot: i + 1, name: null, attempts: [] };
    })));
}
const command = (root: string, script: string, args: string[]) => ['npx', 'tsx', join(root, 'experiments/query-optimization-bench', script), ...args];
export function buildRunJobs(config: RerunConfig, slots: Slot[], paths = defaultPaths): Job[] {
  const jobs: Job[] = [];
  for (const caseId of config.cases) {
    for (const arm of ['current', 'legacy', 'legacyLive'] as const) {
      const root = arm === 'current' ? paths.root : config.legacyWorktree ?? '<legacyWorktree 未設定>';
      const resultRoot = arm === 'current' ? paths.results : join(paths.results, config.legacyResultsSubdir);
      const profile = arm === 'current' ? 'default' : config.legacyProfile;
      for (const split of config.splits) {
        const entries = arm === 'legacyLive'
          ? Array.from({ length: config.liveRunsPerSplit }, (_, i) => ({ c0: `live-${i + 1}`, label: `${config.labels.legacyLive}-${i + 1}`, slot: null }))
          : slots.filter((slot) => slot.caseId === caseId && (slot.split === null || slot.split === split)).map((slot) => ({
            c0: slot.name ?? slotName(slot, config.draftStart + slot.slot - 1), label: config.labels[arm], slot,
          }));
        for (const entry of entries) {
          const args = ['--case', caseId, '--seeds', String(split), '--label', entry.label];
          if (arm !== 'legacyLive') args.push('--c0', entry.c0);
          if (arm === 'current') args.push('--oracle-rounds', String(config.oracleRounds));
          else args.push('--profile', config.legacyProfile, '--fixtures', paths.fixtures, '--results', resultRoot);
          jobs.push({ id: `${arm}:${caseId}:${entry.c0}:${seedSplitId(split)}`, arm, caseId, c0: entry.c0, split,
            variant: entry.slot?.variant, command: command(root, 'run.ts', args), cwd: root,
            expected: join(resultRoot, profile, caseId, arm === 'legacyLive' ? 'live' : entry.c0, `${seedSplitId(split)}+${entry.label}`, 'run.json'),
            blocked: arm !== 'current' && !config.legacyWorktree ? 'legacyWorktree または --legacy-dir が必要です'
              : entry.slot && (!entry.slot.name || !existsSync(c0FixturePath(paths.fixtures, caseId, entry.c0))) ? 'C0 枠が未凍結です' : undefined });
        }
      }
    }
  }
  return jobs;
}
export function logName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 140)}-${createHash('sha256').update(id).digest('hex').slice(0, 8)}.log`;
}
export function readLedger(path: string): Map<string, LedgerRow> {
  const rows = new Map<string, LedgerRow>();
  if (!existsSync(path)) return rows;
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i] && i === lines.length - 1) continue;
    try { const row = JSON.parse(lines[i]!) as LedgerRow; if (!row.id) throw new Error(); rows.set(row.id, row); }
    catch { if (i === lines.length - 1 && !raw.endsWith('\n')) { process.stderr.write('ledger の書きかけの末尾行を読み飛ばしました\n'); break; } throw new Error(`ledger の ${i + 1} 行目が不正です`); }
  }
  return rows;
}
export type Launch = (job: Job, env: NodeJS.ProcessEnv, log: (text: string) => void) => Promise<number>;
export const launch: Launch = (job, env, log) => new Promise((resolveExit) => {
  // Windows の cmd shim をシェル文字列へ展開せず、npm 同梱の npx CLI を Node で起動する。
  const npmExec = env.npm_execpath;
  const executable = process.platform === 'win32' ? process.execPath : job.command[0]!;
  const args = process.platform === 'win32'
    ? [npmExec ? join(dirname(npmExec), 'npx-cli.js') : join(dirname(process.execPath), 'node_modules/npm/bin/npx-cli.js'), ...job.command.slice(1)]
    : job.command.slice(1);
  const child = spawn(executable, args, { cwd: job.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // チャンク境界で秘密値が分割されても漏れないよう、行単位でマスクする。
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => { pending += chunk; const end = pending.lastIndexOf('\n'); if (end >= 0) { log(pending.slice(0, end + 1)); pending = pending.slice(end + 1); } });
    stream.on('end', () => { if (pending) log(pending); });
  }
  child.on('error', (error) => { log(String(error)); resolveExit(1); });
  child.on('close', (code) => resolveExit(code ?? 1));
});

export async function executeRerun(config: RerunConfig, options: Options, start: Launch = launch, paths = defaultPaths) {
  const stages = options.stage === 'all' ? ['prepare', 'freeze', 'run', 'score'] : [options.stage];
  if (!options.dryRun && stages.some((stage) => stage === 'freeze' || stage === 'run') && !process.env.GEMINI_API_KEY?.trim()) {
    throw new Error('GEMINI_API_KEY が未設定です。環境変数に設定するか、worktree ルートの .env（別の場所なら DOTENV_CONFIG_PATH）を dotenv/config で親プロセスに事前読み込みしてください');
  }
  if (options.legacyDir) config = { ...config, legacyWorktree: options.legacyDir };
  const ledgerPath = join(paths.results, 'rerun/ledger.jsonl');
  if (!options.dryRun && existsSync(ledgerPath)) {
    const raw = readFileSync(ledgerPath, 'utf8');
    if (raw && !raw.endsWith('\n')) {
      const temp = `${ledgerPath}.${process.pid}.tmp`;
      writeFileSync(temp, raw.slice(0, raw.lastIndexOf('\n') + 1));
      renameSync(temp, ledgerPath);
      process.stdout.write('ledger の書きかけの末尾を取り除きました\n');
    }
  }
  const slotsPath = join(paths.results, 'rerun/c0-slots.json');
  const slots = makeSlots(config, readJson<Slot[]>(slotsPath) ?? []);
  const summary = { completed: 0, skipped: 0, failed: [] as string[], executed: 0 };
  const selected = (job: Job) => !options.filter || job.id.includes(options.filter);
  const perform = async (job: Job, skip: boolean): Promise<{ success: boolean; error: string | null; artifactFailure: boolean } | null> => {
    if (!selected(job)) return null;
    if (!skip && summary.executed >= options.limit) return null;
    process.stdout.write(mask(`${job.id} | ${JSON.stringify(job.command)} | ${job.expected} | ${skip ? 'スキップ' : job.blocked ?? '実行'}\n`));
    if (skip) { summary.skipped++; return null; }
    summary.executed++;
    if (options.dryRun) return null;
    const startedAt = new Date().toISOString();
    const logPath = join(paths.results, 'rerun/logs', logName(job.id));
    mkdirSync(dirname(logPath), { recursive: true });
    let output = '';
    // c0Generation.ts の validateC0Formula が投げ、freezeC0.ts の末尾の catch が出力する凍結前実測の拒否文言。
    const rejection = '実測できない C0 は凍結しない。再生成するには --draft で別番号を指定する';
    let rejectionTail = '';
    let artifactFailure = false;
    const log = (text: string) => {
      if (job.arm === 'freeze') {
        const combined = rejectionTail + text;
        artifactFailure ||= combined.includes(rejection);
        // チャンク境界や末尾ログの切り詰めによって判定を失わない。
        rejectionTail = combined.slice(-(rejection.length - 1));
      }
      const safe = mask(text); output = (output + safe).slice(-4000); appendFileSync(logPath, safe);
    };
    let exitCode = 1;
    try { if (job.blocked) throw new Error(job.blocked); exitCode = await start(job, process.env, log); }
    catch (error) { log(`${String(error)}\n`); }
    let runStatus: string | null = null;
    try { if (['current', 'legacy', 'legacyLive'].includes(job.arm)) runStatus = readJson<RunResult>(job.expected)?.status ?? null; }
    catch { log('run.json の読み込みに失敗しました\n'); }
    const success = exitCode === 0 && (job.arm === 'freeze' ? existsSync(job.expected)
      : ['current', 'legacy', 'legacyLive'].includes(job.arm) ? runStatus === 'completed' : true);
    const row: LedgerRow = { id: job.id, arm: job.arm, command: job.command.map(mask), startedAt, finishedAt: new Date().toISOString(), exitCode, runStatus };
    if (!success) row.error = output.trim() || `exitCode=${exitCode}, runStatus=${runStatus}`;
    appendFileSync(ledgerPath, mask(JSON.stringify(row)) + '\n');
    if (success) summary.completed++; else summary.failed.push(job.id);
    return { success, error: success ? null : output.trim() || `exitCode=${exitCode}, runStatus=${runStatus}`, artifactFailure };
  };
  for (const stage of stages) {
    if (stage === 'prepare') {
      for (const split of config.splits.slice(1)) await perform({ id: `prepare:all:seeds:${seedSplitId(split)}`, arm: 'prepare', caseId: 'all', c0: 'seeds', split,
        cwd: paths.root, command: command(paths.root, 'prepare.ts', ['--seed', String(split)]), expected: paths.fixtures }, false);
    } else if (stage === 'freeze') {
      for (const slot of slots) {
        const complete = slot.name && existsSync(c0FixturePath(paths.fixtures, slot.caseId, slot.name));
        let attemptsThisPass = 0;
        do {
          let draft = config.draftStart + slot.slot - 1;
          const sameScope = slots.filter((s) => s.caseId === slot.caseId && s.variant === slot.variant && s.split === slot.split);
          // 再試行待ちの番号を他の枠が消費しないよう、過去の試行番号と共に予約する。
          const used = new Set(sameScope.flatMap((s) => [...s.attempts.map((a) => a.draft), ...(s.pendingDraft === undefined ? [] : [s.pendingDraft])]));
          if (slot.attempts.length) draft = config.draftStart + config.drafts;
          if (slot.pendingDraft !== undefined) draft = slot.pendingDraft;
          else while (used.has(draft) || (!complete && existsSync(c0FixturePath(paths.fixtures, slot.caseId, slotName(slot, draft))))) draft++;
          const name = complete ? slot.name! : slotName(slot, draft);
          const args = ['--case', slot.caseId, '--variant', slot.variant, '--draft', String(draft)];
          if (slot.split !== null) args.push('--seeds', String(slot.split));
          const exhausted = slot.attempts.length >= config.maxDraftAttempts;
          const job: Job = { id: `freeze:${slot.caseId}:${name}:${slot.split === null ? 'shared' : seedSplitId(slot.split)}`, arm: 'freeze',
            caseId: slot.caseId, c0: name, split: slot.split ?? SEED, cwd: paths.root, command: command(paths.root, 'freezeC0.ts', args),
            expected: c0FixturePath(paths.fixtures, slot.caseId, name), blocked: exhausted ? 'C0 枠の最大試行数に到達しました' : undefined };
          const result = await perform(job, !!complete);
          if (!result || exhausted) break;
          // 設定・通信・判定不能の失敗は枠を消費せず、次回の実行で同じ番号を再試行する。
          if (!result.success && !result.artifactFailure) {
            slot.pendingDraft = draft;
            atomicJson(slotsPath, slots);
            break;
          }
          delete slot.pendingDraft;
          slot.attempts.push({ draft, success: result.success, error: result.error });
          if (result.success) slot.name = name;
          atomicJson(slotsPath, slots);
          attemptsThisPass++;
          if (result.success) break;
        } while (attemptsThisPass < config.maxDraftAttempts && slot.attempts.length < config.maxDraftAttempts);
      }
    } else if (stage === 'run') {
      const commits = new Map<string, string | null>();
      for (const job of buildRunJobs(config, slots, paths)) {
        if (!selected(job)) continue;
        if (!commits.has(job.cwd)) commits.set(job.cwd, getGitCommit(job.cwd));
        const commit = commits.get(job.cwd);
        let completed = false;
        try {
          const result = readJson<RunResult>(job.expected);
          if (result?.status === 'completed') {
            const mismatches = [];
            if (!commit || result.gitCommit !== commit) mismatches.push('gitCommit');
            if (result.maxHits !== (job.arm === 'current' ? PROFILES.find((p) => p.id === 'default')!.maxHits : 2000)) mismatches.push('maxHits');
            if (job.arm === 'current' && (result.oracleRounds ?? 0) !== config.oracleRounds) mismatches.push('oracleRounds');
            completed = mismatches.length === 0;
            if (!completed) job.blocked = `完了結果の条件が一致しません（${mismatches.join(' / ')}）。label を変えてください`;
          }
        } catch { /* 壊れた結果は再実行の対象。 */ }
        await perform(job, completed);
      }
    } else {
      const expected = join(paths.results, config.legacyResultsSubdir);
      await perform({ id: 'score:all:legacy:all', arm: 'score', caseId: 'all', c0: 'legacy', split: SEED, cwd: paths.root,
        command: command(paths.root, 'scoreLegacy.ts', [expected]), expected }, false);
    }
  }
  process.stdout.write(`完了 ${summary.completed} / スキップ ${summary.skipped} / 失敗 ${summary.failed.length}${options.dryRun ? '（dry-run）' : ''}${summary.failed.length ? `\n${summary.failed.join('\n')}` : ''}\n`);
  return summary;
}
export async function main(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const result = await executeRerun(readConfig(options.config), options);
  if (result.failed.length) process.exitCode = 1;
}
if (require.main === module) main(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(mask(String(error)) + '\n'); process.exitCode = 1; });
