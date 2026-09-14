import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { searchOutsideCandidates, type OutsideSearchStages } from '../../src/app/services/expandService';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';
import { expandFormula } from '../../src/features/validation/expandFormula';
import { GeminiProvider } from '../../src/lib/llm/GeminiProvider';
import { esearch, type EutilsDeps } from '../../src/lib/ncbi/eutils';
import { loadC0Artifact, type C0Artifact } from './c0Artifact';
import { installDomParser } from './domParser';
import { loadMarginArtifact, validateMarginName, type MarginArtifact } from './freezeMargin';
import { getGitCommit, isGitDirty } from './gitInfo';
import { createLlmUsageTracker } from './llmUsage';
import { capturedGold, createEvalFetch, observeBackoff, observeRateLimiter, redact } from './ncbiEval';
import { computeHeldOut, FIXTURES, loadSeedsFile, parseSeedSplit, SEED, seedSplitId, validateSeeds, type SeedSplit } from './prepare';
import { loggedFactory, reportError, RESULTS } from './run';
import { CASES, type BenchCase, type FrozenSeeds } from './types';

export interface OutsideStagesArgs {
  caseId: string;
  marginName: string;
  seed: SeedSplit;
  retmax: number;
  candidateLimit: number;
  sort?: 'relevance';
  retrieval: 'head' | 'year-stratified';
  rankDepth: number;
  label?: string;
  dryRun: boolean;
}

export function parseOutsideStagesArgs(args: string[]): OutsideStagesArgs {
  const values: Record<string, string> = {};
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--dry-run' && !dryRun) dryRun = true;
    else if (['--case', '--margin', '--seeds', '--retmax', '--candidate-limit', '--sort', '--retrieval', '--rank-depth', '--label'].includes(key)
      && values[key] === undefined && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) values[key] = args[++i]!;
    else throw new Error(`未対応・重複または値のない引数: ${key}`);
  }
  const caseId = values['--case'] ?? '';
  if (!CASES.some((item) => item.id === caseId)) throw new Error('--case には既知のケース ID を指定してください');
  const marginName = values['--margin'] ?? '';
  validateMarginName(marginName);
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const raw = values[key];
    const value = raw === undefined ? fallback : Number(raw);
    if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${key} には ${min}〜${max} の整数を指定してください`);
    }
    return value;
  };
  const sort = values['--sort'];
  const retrieval = values['--retrieval'] ?? 'head';
  if (retrieval !== 'head' && retrieval !== 'year-stratified') throw new Error('--retrieval には head または year-stratified を指定してください');
  if (sort !== undefined && sort !== 'relevance') throw new Error('--sort には relevance を指定してください');
  const label = values['--label'];
  if (label !== undefined && (!/^[A-Za-z0-9._-]{1,40}$/.test(label) || /^replay-/i.test(label))) {
    throw new Error('--label は英数字・.・_・- の 1〜40 文字で指定してください（replay- で始まる名前は使用できません）');
  }
  return { caseId, marginName, seed: values['--seeds'] === undefined ? SEED : parseSeedSplit(values['--seeds']),
    retmax: integer('--retmax', 50, 1, 10000), candidateLimit: integer('--candidate-limit', 20, 1, Number.MAX_SAFE_INTEGER),
    sort, retrieval, rankDepth: integer('--rank-depth', 10000, 0, 10000), label, dryRun };
}

export const STAGE_NAMES = ['captured_by_current', 'not_in_margin', 'beyond_retmax', 'excluded_as_known', 'beyond_candidate_limit',
  'efetch_missing', 'not_picked', 'presented'] as const;
export type OutsideStage = typeof STAGE_NAMES[number];
export interface StudyStage {
  studyId: string;
  pmids: string[];
  stage: OutsideStage;
  retrievedRank: number | null;
  deepRank: number | null;
  stratum: string | null;
  stratumDeepRank: number | null;
}

/** 複数報告のいずれかが通過すれば、その研究が到達した段階として数える。 */
export function classifyStudy(study: { studyId: string; pmids: string[] }, inCurrent: readonly string[], inMargin: readonly string[],
  stages: OutsideSearchStages, deepPmids: readonly string[] | null): StudyStage {
  const has = (pmids: readonly string[]) => study.pmids.some((pmid) => pmids.includes(pmid));
  const rank = (pmids: readonly string[] | null): number | null => {
    const index = pmids?.findIndex((pmid) => study.pmids.includes(pmid)) ?? -1;
    return index < 0 ? null : index + 1;
  };
  const passed = [inMargin, stages.retrievedPmids, stages.novelPmids, stages.requestedPmids, stages.fetchedPmids, stages.pickedPmids];
  const firstMissing = passed.findIndex((pmids) => !has(pmids));
  return { ...study, stage: has(inCurrent) ? 'captured_by_current' : STAGE_NAMES[firstMissing < 0 ? 7 : firstMissing + 1]!,
    retrievedRank: rank(stages.retrievedPmids), deepRank: rank(deepPmids), stratum: null, stratumDeepRank: null };
}

export function outsideResultDir(resultsDir: string, options: OutsideStagesArgs): string {
  return join(resultsDir, 'outside-stages', options.caseId, options.marginName, seedSplitId(options.seed),
    `r${options.retmax}-l${options.candidateLimit}-${options.sort ?? 'default'}${options.retrieval === 'year-stratified' ? '-yearstrat' : ''}${options.label ? `+${options.label}` : ''}`);
}

export function decideOutsideExisting(existing: { status: string; gitCommit: string | null }, gitCommit: string | null): 'run' | 'skip' {
  if (existing.status !== 'completed') return 'run';
  if (existing.gitCommit === gitCommit) return 'skip';
  throw new Error('別コミットの完了結果があります。上書きせず比較するには --label を付けて実行してください');
}

export interface OutsideRun {
  status: 'completed' | 'failed';
  error: string | null;
  runId: string;
  caseId: string;
  margin: { name: string; sha256: string };
  c0: { name: string; sha256: string };
  seedSplit: string;
  config: { retmax: number; candidateLimit: number; sort: 'relevance' | null; retrieval: 'head' | 'year-stratified'; rankDepth: number };
  label: string | null;
  searchDate: string;
  model: string;
  gitCommit: string | null;
  gitDirty: boolean | null;
  originalHits: number | null;
  marginHits: number | null;
  stages: OutsideSearchStages | null;
  candidates: { pmid: string; reason: string }[];
  heldOutStages: StudyStage[];
  missedHeldOutCount: number | null;
  stageCounts: Record<OutsideStage, number>;
  /** 順位の追加取得は候補選定終了後の事後集計専用。選定には戻さない。 */
  deepRankPurpose: string;
  apiCalls: { ncbi: number; llm: number };
  apiElapsedMs: { ncbi: number; llm: number };
  llmUsage: ReturnType<typeof createLlmUsageTracker>['usage'];
  elapsedMs: number;
  llmLogs: string[];
}

/** 候補抽出に gold を渡さず、すべての選定が終わった後でのみ分母・段階を集計する。 */
export async function executeOutsideStages(fixture: BenchCase, seeds: FrozenSeeds, c0: C0Artifact, margin: MarginArtifact,
  options: OutsideStagesArgs, result: OutsideRun,
  deps: { eutils: EutilsDeps; llmFactory: LlmProviderFactory; progress: (event: unknown) => void }): Promise<void> {
  const outside = await searchOutsideCandidates({ formula: c0.formula,
    researchQuestion: c0.protocol.researchQuestion, inclusionCriteria: c0.protocol.inclusionCriteria,
    exclusionCriteria: c0.protocol.exclusionCriteria, existingPmids: new Set(seeds.selections.map((seed) => seed.pmid)),
    additions: margin.additions, retmax: options.retmax, skillCandidateLimit: options.candidateLimit, sort: options.sort ?? 'none', retrieval: options.retrieval,
    eutils: deps.eutils, llmFactory: deps.llmFactory, onProgress: (step) => deps.progress({ step }) });
  if (!outside.stages || outside.stages.marginQuery !== margin.marginQuery) {
    throw new Error('凍結した margin クエリと段階測定のクエリが一致しません');
  }
  result.originalHits = outside.originalHits;
  result.marginHits = outside.marginHits;
  result.stages = outside.stages;
  result.candidates = outside.candidates.map(({ pmid, reason }) => ({ pmid, reason }));

  // ここから事後集計。gold を使う通信は候補抽出・LLM の入力に一切戻さない。
  deps.progress({ phase: '事後集計', deepRankPurpose: result.deepRankPurpose });
  const allPmids = [...new Set(fixture.gold.flatMap((group) => group.pmids))];
  const inDate = await capturedGold('', allPmids, deps.eutils);
  const groups = fixture.gold.map((group) => ({ ...group, pmids: group.pmids.filter((pmid) => inDate.includes(pmid)),
    members: group.members.map((study) => ({ ...study, pmids: study.pmids.filter((pmid) => inDate.includes(pmid)) }))
      .filter((study) => study.pmids.length > 0) })).filter((group) => group.pmids.length > 0);
  if (seeds.selections.some((seed) => !inDate.includes(seed.pmid))) throw new Error('凍結済みシードが検索日範囲外です。自動で差し替えません');
  const heldOut = new Set(computeHeldOut(groups, seeds));
  const studies = groups.filter((group) => heldOut.has(group.id)).flatMap((group) => group.members);
  const heldOutPmids = [...new Set(studies.flatMap((study) => study.pmids))];
  const inCurrent = await capturedGold(expandFormula(c0.formula).trim(), heldOutPmids, deps.eutils);
  const inMargin = await capturedGold(margin.marginQuery, heldOutPmids, deps.eutils);
  const deepPmids = options.rankDepth === 0 ? null : (await esearch(margin.marginQuery, deps.eutils,
    { retmax: options.rankDepth, ...(options.sort ? { sort: options.sort } : {}) })).pmids;
  const deepStrata: { label: string; pmids: string[] }[] = [];
  if (options.retrieval === 'year-stratified' && options.rankDepth > 0) {
    for (const stratum of outside.stages.strata ?? []) {
      const searched = await esearch(`(${margin.marginQuery}) AND (${stratum.dateRange})`, deps.eutils,
        { retmax: options.rankDepth, ...(options.sort ? { sort: options.sort } : {}) });
      deepStrata.push({ label: stratum.label, pmids: searched.pmids });
    }
  }
  for (const study of studies) {
    const classified = classifyStudy(study, inCurrent, inMargin, outside.stages, deepPmids);
    // 複数の層に報告があれば、古い層から最初に見つかった報告の順位を記録する。
    for (const stratum of deepStrata) {
      const index = stratum.pmids.findIndex((pmid) => study.pmids.includes(pmid));
      if (index < 0) continue;
      classified.stratum = stratum.label;
      classified.stratumDeepRank = index + 1;
      break;
    }
    result.heldOutStages.push(classified);
    result.stageCounts[classified.stage]++;
  }
  result.missedHeldOutCount = studies.length - result.stageCounts.captured_by_current;
  result.status = 'completed';
}

export function printOutsideStages(result: OutsideRun): void {
  process.stdout.write('研究名 / 判定 / 取得順位 / 深い取得の順位（事後集計） / 出版年代の層 / 層内順位（事後集計）\n');
  if (result.heldOutStages.length === 0) process.stdout.write('対象研究 0 件（失敗時は未集計）\n');
  for (const study of result.heldOutStages) {
    process.stdout.write(`${study.studyId} / ${study.stage} / ${study.retrievedRank ?? '-'} / ${study.deepRank ?? '-'} / ${study.stratum ?? '-'} / ${study.stratumDeepRank ?? '-'}\n`);
  }
  process.stdout.write(`判定別研究数: ${JSON.stringify(result.stageCounts)}\n`);
  process.stdout.write(`取りこぼし（現式で未捕捉）: ${result.missedHeldOutCount ?? '未集計'} 研究\n`);
}

export async function main(args = process.argv.slice(2), fixturesDir = FIXTURES, resultsDir = RESULTS): Promise<void> {
  const options = parseOutsideStagesArgs(args);
  const { caseId, marginName, seed, dryRun } = options;
  const margin = loadMarginArtifact(fixturesDir, caseId, marginName);
  const c0 = loadC0Artifact(fixturesDir, caseId, margin.c0.name);
  if (c0.sha256 !== margin.c0.sha256) throw new Error('margin が参照する C0 のハッシュが一致しません');
  const splitId = seedSplitId(seed);
  if (c0.seedSplit !== null && c0.seedSplit !== splitId) throw new Error(`凍結 C0 のシード分割 (${c0.seedSplit}) が実行時の分割 (${splitId}) と一致しません`);
  const fixtureDir = join(fixturesDir, caseId);
  const fixture = JSON.parse(readFileSync(join(fixtureDir, 'case.json'), 'utf8')) as BenchCase;
  if (margin.searchDate !== fixture.searchDate) throw new Error('margin とケースの検索日が一致しません');
  const seeds = loadSeedsFile(fixtureDir, seed);
  validateSeeds(seeds, fixture.gold);
  const dir = outsideResultDir(resultsDir, options);
  const outPath = join(dir, 'run.json');
  const gitCommit = getGitCommit();
  if (existsSync(outPath) && decideOutsideExisting(JSON.parse(readFileSync(outPath, 'utf8')) as OutsideRun, gitCommit) === 'skip') {
    process.stdout.write(`${caseId}: 同じコミットの完了結果をスキップ -> ${outPath}\n`);
    return;
  }
  if (dryRun) {
    process.stdout.write(`${caseId}: dry-run OK (margin・C0 ハッシュ照合済み、通信・書き込みなし) -> ${outPath}\n`);
    return;
  }
  config();
  installDomParser();
  const secrets = [process.env.GEMINI_API_KEY ?? '', process.env.NCBI_API_KEY ?? ''];
  const serialize = (value: unknown) => redact(JSON.stringify(value, null, 2), secrets) + '\n';
  const runId = randomUUID();
  const attemptDir = join(dir, runId);
  mkdirSync(join(attemptDir, 'llm'), { recursive: true });
  const progress = (event: unknown) => appendFileSync(join(attemptDir, 'progress.jsonl'),
    redact(JSON.stringify({ at: new Date().toISOString(), event }), secrets) + '\n');
  const usage = createLlmUsageTracker();
  const result: OutsideRun = { status: 'failed', error: null, runId, caseId, margin: { name: marginName, sha256: margin.sha256 },
    c0: margin.c0, seedSplit: splitId, config: { retmax: options.retmax, candidateLimit: options.candidateLimit,
      sort: options.sort ?? null, retrieval: options.retrieval, rankDepth: options.rankDepth }, label: options.label ?? null,
    searchDate: fixture.searchDate, model: '', gitCommit, gitDirty: isGitDirty(), originalHits: null, marginHits: null,
    stages: null, candidates: [], heldOutStages: [], missedHeldOutCount: null,
    stageCounts: Object.fromEntries(STAGE_NAMES.map((stage) => [stage, 0])) as Record<OutsideStage, number>,
    deepRankPurpose: '候補選定終了後の事後集計専用。候補選定には使用しない。rankDepth=0 は取得省略。',
    apiCalls: { ncbi: 0, llm: 0 }, apiElapsedMs: { ncbi: 0, llm: 0 }, llmUsage: usage.usage, elapsedMs: 0, llmLogs: [] };
  const start = Date.now();
  try {
    progress({ process: { pid: process.pid, hasApiKey: Boolean(process.env.NCBI_API_KEY), caseCount: 1,
      caseExecution: 'sequential', requestConcurrency: 'caller-dependent', externalConcurrency: 'unknown',
      gitCommit, gitDirty: result.gitDirty, runId } });
    const observed = createEvalFetch(fixture.searchDate, globalThis.fetch, (event) => {
      const category = new URL(event.url).hostname === 'generativelanguage.googleapis.com' ? 'llm' : 'ncbi';
      result.apiCalls[category]++;
      result.apiElapsedMs[category] += event.elapsedMs;
      progress({ api: category, ...event });
    }, secrets);
    const provider = new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY ?? '', fetch: observed });
    const llmFactory = loggedFactory(provider, (path, value) => writeFileSync(join(attemptDir, path), serialize(value)), result.llmLogs, usage.record);
    result.model = llmFactory.model;
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です');
    const eutils: EutilsDeps = { fetch: observed, apiKey: process.env.NCBI_API_KEY, strictCounts: true,
      sleep: observeBackoff((backoff) => progress({ backoff })) };
    eutils.rateLimiter = observeRateLimiter(eutils, (limiter) => progress({ limiter }));
    await executeOutsideStages(fixture, seeds, c0, margin, options, result, { eutils, llmFactory, progress });
  } catch (err) {
    result.status = 'failed';
    result.error = redact(err instanceof Error ? err.message : String(err), secrets);
  } finally {
    result.elapsedMs = Date.now() - start;
    progress({ status: result.status, error: result.error });
    const temporary = join(attemptDir, 'run.json.tmp');
    writeFileSync(temporary, serialize(result));
    renameSync(temporary, outPath);
  }
  const safeResult = JSON.parse(serialize(result)) as OutsideRun;
  printOutsideStages(safeResult);
  if (result.status === 'failed') throw new Error(result.error ?? '段階測定に失敗しました');
}

if (require.main === module) void main().catch(reportError);
