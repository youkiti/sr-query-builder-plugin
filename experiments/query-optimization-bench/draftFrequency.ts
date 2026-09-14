import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { generateDraftFormula, type DraftGeneration } from '../../src/app/services/draftService';
import { DEFAULT_OPTIMIZATION_MAX_HITS } from '../../src/app/services/queryOptimizationSettingsService';
import { designDefaultFilters } from '../../src/features/formula/skills/filterDesigner';
import { GeminiProvider } from '../../src/lib/llm/GeminiProvider';
import type { LLMProvider } from '../../src/lib/llm';
import { esearch, type EutilsDeps } from '../../src/lib/ncbi/eutils';
import { FIXTURES } from './prepare';
import { CASES, type BenchCase, type LlmUsage } from './types';
import { loadC0Artifact, type C0Variant } from './c0Artifact';
import { loggedFactory, RESULTS, reportError } from './run';
import { createEvalFetch, observeBackoff, observeRateLimiter, redact } from './ncbiEval';
import { getGitCommit, isGitDirty } from './gitInfo';
import { createLlmUsageTracker } from './llmUsage';
import { diagnoseFormula, diagnosticOutcome, generationOutcome, FetchFailure, errorText, type Diagnostic, type MeshLookup, type Outcome } from './draftDiagnosis';

export interface FrequencyArgs { trials?: number; caseId?: string; variant?: C0Variant; label: string; dryRun: boolean; report: boolean }
export interface Condition { caseId: string; variant: C0Variant; c0Name: string; c0Sha256: string }
export interface Plan { trials: number; conditions: Condition[]; createdAt: string; gitCommit: string | null }
export interface Trial {
  caseId: string; variant: C0Variant; trial: number; c0: { name: string; sha256: string };
  model: string; targetHits: number; startedAt: string; elapsedMs: number; gitCommit: string | null; gitDirty: boolean | null;
  complete: boolean; outcome: Outcome; error: string | null; formulaMd: string | null; formula: DraftGeneration['formula'] | null;
  generationBlockHits: DraftGeneration['blockHits']; diagnostics: Diagnostic[]; meshLookups: MeshLookup[];
  apiCalls: { ncbi: number; llm: number }; llmUsage: LlmUsage; llmLogs: string[];
}

export function parseFrequencyArgs(args: string[]): FrequencyArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (values.has(arg) || flags.has(arg)) throw new Error(`引数が重複しています: ${arg}`);
    if (arg === '--dry-run' || arg === '--report') flags.add(arg);
    else if (['--trials', '--case', '--variant', '--label'].includes(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`引数の値がありません: ${arg}`);
      values.set(arg, value);
    } else throw new Error(`未知の引数です: ${arg}`);
  }
  const trialArg = values.get('--trials');
  const trials = trialArg === undefined ? undefined : Number(trialArg);
  const report = flags.has('--report');
  const dryRun = flags.has('--dry-run');
  if (report && (dryRun || trialArg !== undefined)) throw new Error('--report は --dry-run / --trials と併用できません');
  if (!report && (trialArg === undefined || !/^[1-9]\d*$/.test(trialArg) || !Number.isSafeInteger(trials))) throw new Error('--trials には正の整数が必要です');
  const caseId = values.get('--case');
  if (caseId !== undefined && !CASES.some((item) => item.id === caseId)) throw new Error('--case が未知のケース ID です');
  const variant = values.get('--variant');
  if (variant !== undefined && variant !== 'criteria-only' && variant !== 'seeded') throw new Error('--variant は criteria-only または seeded です');
  const label = values.get('--label') ?? 'default';
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(label) || /^replay-/i.test(label) || label === '.' || label === '..') throw new Error('--label は英数字・.・_・- の1〜40文字です。replay- 接頭辞と . / .. は使用できません');
  return { trials, caseId, variant, label, dryRun, report };
}

export function validatePlan(plan: Plan, trials: number, conditions: Condition[]): void {
  if (plan.trials !== trials) throw new Error('plan の試行数と --trials が一致しません');
  for (const condition of conditions) {
    const frozen = plan.conditions.find((item) => item.caseId === condition.caseId && item.variant === condition.variant);
    if (!frozen) throw new Error(`plan の条件外です: ${condition.caseId}/${condition.variant}`);
    if (frozen.c0Name !== condition.c0Name || frozen.c0Sha256 !== condition.c0Sha256) throw new Error(`plan の C0 sha256 が一致しません: ${condition.caseId}/${condition.variant}`);
  }
}

function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T; }
function atomicWrite(path: string, value: unknown, secrets: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, redact(JSON.stringify(value, null, 2), secrets) + '\n', { flag: 'wx' });
  renameSync(temp, path);
}
const trialPath = (root: string, condition: Condition, trial: number): string => join(root, condition.caseId, condition.variant, `trial-${trial}.json`);

export interface FrequencyDeps {
  fetch?: typeof fetch; provider?: (network: typeof fetch) => LLMProvider;
  generate?: typeof generateDraftFormula; secrets?: string[]; eutils?: Pick<EutilsDeps, 'maxRetries' | 'sleep'>;
}

export async function main(args = process.argv.slice(2), fixturesDir = FIXTURES, resultsDir = RESULTS, deps: FrequencyDeps = {}): Promise<void> {
  const options = parseFrequencyArgs(args);
  const root = join(resultsDir, 'draft-frequency', options.label);
  const planPath = join(root, 'plan.json');
  const existingPlan = existsSync(planPath) ? readJson<Plan>(planPath) : undefined;
  if (options.report) { reportFrequency(root, existingPlan, options); return; }
  const inputs = [];
  for (const caseId of options.caseId ? [options.caseId] : CASES.map((item) => item.id)) {
    for (const variant of options.variant ? [options.variant] : ['criteria-only', 'seeded'] as const) {
      const c0Name = `${variant}-draft1`;
      const artifact = loadC0Artifact(fixturesDir, caseId, c0Name);
      if (artifact.variant !== variant || (variant === 'seeded' && !artifact.seedContext)) throw new Error(`C0 の入力条件が不正です: ${caseId}/${c0Name}`);
      const fixture = readJson<BenchCase>(join(fixturesDir, caseId, 'case.json'));
      inputs.push({ artifact, fixture, condition: { caseId, variant, c0Name, c0Sha256: artifact.sha256 } });
    }
  }
  const trials = options.trials!;
  const conditions = inputs.map((item) => item.condition);
  if (existingPlan) validatePlan(existingPlan, trials, conditions);
  if (options.dryRun) {
    for (const { artifact, condition } of inputs) {
      const n = artifact.blocks.blocks.length;
      const f = designDefaultFilters({ studyDesign: artifact.protocol.studyDesign }).filters.length;
      process.stdout.write(`${condition.caseId}/${condition.variant}: ブロック=${n}, フィルタ=${f}, 1試行 LLM=${3 * n}, NCBI=${2 * n + f + 1}（生成 ${n} + 診断 ${n + f + 1}、MeSH照会と再送は別途） -> ${dirname(trialPath(root, condition, 1))} (trials=${trials})\n`);
    }
    return;
  }
  if (!deps.provider) config();
  if (!deps.provider && !process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です');
  const secrets = deps.secrets ?? [process.env.GEMINI_API_KEY ?? '', process.env.NCBI_API_KEY ?? ''];
  const gitCommit = getGitCommit();
  if (!existingPlan) {
    mkdirSync(root, { recursive: true });
    writeFileSync(planPath, JSON.stringify({ trials, conditions, createdAt: new Date().toISOString(), gitCommit } satisfies Plan, null, 2) + '\n', { flag: 'wx' });
  }
  for (const { artifact, fixture, condition } of inputs) {
    for (let trial = 1; trial <= trials; trial++) {
      const path = trialPath(root, condition, trial);
      const historyPath = path.replace(/\.json$/, '.history.jsonl');
      if (existsSync(path)) {
        const previous = readJson<Trial>(path);
        if (previous.complete) continue;
        appendFileSync(historyPath, redact(JSON.stringify(previous), secrets) + '\n');
      }
      let attempt = BigInt(existsSync(historyPath) ? readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean).length + 1 : 1);
      const logDir = path.slice(0, -5);
      mkdirSync(join(logDir, 'llm'), { recursive: true });
      for (const entry of readdirSync(join(logDir, 'llm'), { withFileTypes: true })) {
        const match = entry.isFile() ? /^a([1-9]\d*)-/.exec(entry.name) : null;
        if (match && BigInt(match[1]!) >= attempt) attempt = BigInt(match[1]!) + BigInt(1);
      }
      const progress = (event: unknown): void => appendFileSync(join(logDir, 'progress.jsonl'), redact(JSON.stringify({ at: new Date().toISOString(), event }), secrets) + '\n');
      const apiCalls = { ncbi: 0, llm: 0 };
      let fetchFailed = false;
      const observed = createEvalFetch(fixture.searchDate, deps.fetch ?? globalThis.fetch, (api) => {
        apiCalls[new URL(api.url).hostname === 'eutils.ncbi.nlm.nih.gov' ? 'ncbi' : 'llm']++;
        if (api.status === null) fetchFailed = true;
        progress({ api });
      }, secrets);
      const network: typeof fetch = async (input, init) => {
        fetchFailed = false;
        try { return await observed(input, init); }
        catch (error) { if (fetchFailed) throw new FetchFailure(errorText(error)); throw error; }
      };
      const provider = deps.provider ? deps.provider(network) : new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY!, fetch: network });
      const tracker = createLlmUsageTracker();
      const llmLogs: string[] = [];
      const factory = loggedFactory(provider, (file, value) => atomicWrite(join(logDir, file), value, secrets), llmLogs, tracker.record, `a${attempt}-`);
      const eutils: EutilsDeps = { fetch: network, apiKey: process.env.NCBI_API_KEY, strictCounts: true, maxRetries: deps.eutils?.maxRetries,
        sleep: observeBackoff((backoff) => progress({ backoff }), deps.eutils?.sleep) };
      eutils.rateLimiter = observeRateLimiter(eutils, (limiter) => progress({ limiter }));
      const start = Date.now();
      const result: Trial = { caseId: condition.caseId, variant: condition.variant, trial, c0: { name: condition.c0Name, sha256: condition.c0Sha256 },
        model: provider.model, targetHits: DEFAULT_OPTIMIZATION_MAX_HITS, startedAt: new Date(start).toISOString(), elapsedMs: 0, gitCommit, gitDirty: isGitDirty(),
        complete: false, outcome: 'generation_failed', error: null, formulaMd: null, formula: null, generationBlockHits: [], diagnostics: [], meshLookups: [], apiCalls, llmUsage: tracker.usage, llmLogs };
      progress({ process: { pid: process.pid, hasApiKey: Boolean(eutils.apiKey), caseExecution: 'sequential', gitCommit, gitDirty: result.gitDirty } });
      let draft: DraftGeneration | undefined;
      try {
        draft = await (deps.generate ?? generateDraftFormula)({ protocol: artifact.protocol, blocks: artifact.blocks,
          seedContext: condition.variant === 'seeded' ? artifact.seedContext! : { titles: [], samples: [], meshSummary: { seedCount: 0, concepts: [], checkTags: [] } },
          targetHits: DEFAULT_OPTIMIZATION_MAX_HITS }, { llmFactory: factory, countBlockHits: async (query) => (await esearch(query, eutils, { retmax: 0 })).count });
      } catch (error) { result.outcome = generationOutcome(error); result.error = errorText(error); }
      if (draft) {
        result.formula = draft.formula; result.formulaMd = draft.markdown; result.generationBlockHits = draft.blockHits;
        Object.assign(result, await diagnoseFormula(draft.formula, eutils));
        result.outcome = diagnosticOutcome(result.diagnostics);
      }
      result.complete = result.outcome !== 'generation_transient' && result.outcome !== 'network_error';
      result.elapsedMs = Date.now() - start;
      atomicWrite(path, result, secrets);
      process.stdout.write(`${condition.caseId}/${condition.variant}/trial-${trial}: ${result.outcome}\n`);
    }
  }
}

export function reportFrequency(root: string, plan: Plan | undefined, options: Pick<FrequencyArgs, 'caseId' | 'variant'> = {}): string {
  const conditions = plan?.conditions.filter((item) => (!options.caseId || item.caseId === options.caseId) && (!options.variant || item.variant === options.variant)) ?? [];
  const headers = ['条件', '計画試行数', '完了', '未完了（再試行待ち）', '未実行', 'generation_failed/完了', 'syntax_error/完了', 'other_error/完了', 'zero/完了', 'ok/完了', '構文エラーブロック/診断ブロック', '構文エラー式/診断式', 'unresolved語', 'ambiguous語', 'resolved語', 'lookup_failed語', 'not_mesh語'];
  const all: Trial[] = [];
  const row = (name: string, records: Trial[], planned: number): (string | number)[] => {
    const complete = records.filter((item) => item.complete);
    const diagnostics = complete.flatMap((item) => item.diagnostics);
    const lookups = complete.flatMap((item) => item.meshLookups);
    return [name, planned, complete.length, records.length - complete.length, planned - records.length,
      ...(['generation_failed', 'syntax_error', 'other_error', 'zero', 'ok'] as const).map((outcome) => `${complete.filter((item) => item.outcome === outcome).length}/${complete.length}`),
      ...(['block', 'formula'] as const).map((target) => { const items = diagnostics.filter((item) => item.target === target); return `${items.filter((item) => item.status === 'syntax_error').length}/${items.length}`; }),
      ...(['unresolved', 'ambiguous', 'resolved', 'lookup_failed', 'not_mesh'] as const).map((status) => lookups.filter((item) => item.status === status).length)];
  };
  const rows = conditions.map((condition) => {
    const records: Trial[] = [];
    for (let k = 1; k <= plan!.trials; k++) { const path = trialPath(root, condition, k); if (existsSync(path)) records.push(readJson<Trial>(path)); }
    all.push(...records);
    return row(`${condition.caseId}/${condition.variant}`, records, plan!.trials);
  });
  rows.push(row(all.length === 0 ? '全体（0 件）' : '全体', all, (plan?.trials ?? 0) * conditions.length));
  const markdown = [headers, headers.map(() => '---'), ...rows].map((cells) => `| ${cells.join(' | ')} |`).join('\n') + '\n';
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'summary.md'), markdown, 'utf8');
  writeFileSync(join(root, 'summary.csv'), [headers, ...rows].map((cells) => cells.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n', 'utf8');
  process.stdout.write(markdown);
  return markdown;
}

if (require.main === module) void main().catch(reportError);
