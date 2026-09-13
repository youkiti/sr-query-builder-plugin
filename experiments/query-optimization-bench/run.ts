import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import type { ProtocolDraft, BlocksDraft } from '../../src/app/store';
import { generateDraftFormula } from '../../src/app/services/draftService';
import { runQueryOptimization } from '../../src/app/services/queryOptimizationService';
import { fetchMeshContext } from '../../src/app/services/meshContextService';
import { DEFAULT_OPTIMIZATION_MAX_HITS } from '../../src/app/services/queryOptimizationSettingsService';
import { extractProtocol } from '../../src/features/formula/skills/extractProtocol';
import { expandFormula } from '../../src/features/validation/expandFormula';
import { GeminiProvider } from '../../src/lib/llm/GeminiProvider';
import { withRetry } from '../../src/lib/llm/retry';
import type { LLMProvider } from '../../src/lib/llm/LLMProvider';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';
import type { PubmedFormula } from '../../src/lib/search-formula-md';
import type { EutilsDeps } from '../../src/lib/ncbi/eutils';
import type { ProjectStoreDeps } from '../../src/features/project/projectStore';
import { esearch } from '../../src/lib/ncbi/eutils';
import { installDomParser } from './domParser';
import { FIXTURES, SEED, computeHeldOut, loadSeedsFile, seedSplitId, validateSeeds } from './prepare';
import { capturedGold, createEvalFetch, evaluateSearch, observeRateLimiter, redact, seedTitles } from './ncbiEval';
import { calculateMetrics, compareMetrics } from './metrics';
import { loadC0Artifact, type C0Variant } from './c0Artifact';
import { getGitCommit, isGitDirty } from './gitInfo';
import { computeAdoptionAudit } from './adoptionAudit';
import { computeConfirmation } from './confirmationAudit';
import { createLlmUsageTracker } from './llmUsage';
import { CASES, PROFILES, type BenchCase, type FrozenSeeds, type GoldAudit, type RunResult, type ConditionResult } from './types';

export const RESULTS = resolve(__dirname, 'results');

/** results ディレクトリ配下の 1 run の格納先。run.ts / candidates.ts で共有する。 */
export function resultDir(resultsRoot: string, profileId: string, caseId: string, c0Key: string, splitKey: string, label?: string): string {
  return join(resultsRoot, profileId, caseId, c0Key, label ? `${splitKey}+${label}` : splitKey);
}

export function memoryCheckpoint(): ProjectStoreDeps {
  const values: Record<string, unknown> = {};
  return { read: async <T>(key: string) => values[key] as T | undefined, write: async (items) => { Object.assign(values, items); } };
}

/**
 * @param onUsage 呼び出し 1 回（リトライの各試行を含む）ごとに model/tokensIn/tokensOut と成否を通知する。
 *   失敗した呼び出しも通知する（tokensIn/tokensOut は null）。run.ts の RunResult.llmUsage、
 *   run の使用量集計に使う。
 */
export function loggedFactory(provider: LLMProvider, write: (path: string, value: unknown) => void,
  paths: string[], onUsage?: (model: string, tokensIn: number | null, tokensOut: number | null, succeeded: boolean) => void): LlmProviderFactory {
  let sequence = 0;
  return { model: provider.model, forPurpose: (purpose, onRequestState) => withRetry({
    providerId: provider.providerId, model: provider.model,
    chat: async (messages, options) => {
      const path = `llm/${String(++sequence).padStart(4, '0')}_${purpose}.json`;
      const start = Date.now();
      paths.push(path);
      try {
        const response = await provider.chat(messages, options);
        write(path, { purpose, model: provider.model, messages, options, response, tokensIn: response.tokensIn,
          tokensOut: response.tokensOut, latencyMs: Date.now() - start });
        onUsage?.(provider.model, response.tokensIn, response.tokensOut, true);
        return response;
      } catch (err) {
        write(path, { purpose, model: provider.model, messages, options, response: null, tokensIn: null,
          tokensOut: null, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err),
          responseBody: err && typeof err === 'object' && 'responseBody' in err ? err.responseBody : null });
        onUsage?.(provider.model, null, null, false);
        throw err;
      }
    },
  }, { onRequestState }) };
}

export interface ParsedArgs {
  ids: string[];
  dryRun: boolean;
  profile: { id: string; maxHits: number; maxIterations: number };
  /** tight-1000 または --max-hits による事後探索条件かどうか（default は false）。 */
  postHoc: boolean;
  /** シード分割の乱数。既定は SEED（`fixtures/<id>/seeds.json`）。 */
  seed: number;
  /** --c0 で指定した凍結 C0 の名前（`fixtures/<id>/c0/<name>.json`、拡張子なし）。 */
  c0Name?: string;
  label?: string;
}

export function parseArgs(args: string[]): ParsedArgs {
  let selected: string | undefined;
  let dryRun = false;
  let profileId: string | undefined;
  let maxHitsArg: string | undefined;
  let seedArg: string | undefined;
  let c0Name: string | undefined;
  let label: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--case' && selected === undefined && args[i + 1]) selected = args[++i];
    else if (args[i] === '--profile' && profileId === undefined && args[i + 1]) profileId = args[++i];
    else if (args[i] === '--max-hits' && maxHitsArg === undefined && args[i + 1]) maxHitsArg = args[++i];
    else if (args[i] === '--seeds' && seedArg === undefined && args[i + 1]) seedArg = args[++i];
    else if (args[i] === '--c0' && c0Name === undefined && args[i + 1]) c0Name = args[++i];
    else if (args[i] === '--label' && label === undefined && args[i + 1] !== undefined) label = args[++i];
    else throw new Error(`未対応の引数: ${args[i]}`);
  }
  if (label !== undefined && (!/^[A-Za-z0-9._-]{1,40}$/.test(label) || label.trim() !== label)) throw new Error('--label は英数字・.・_・- の 1〜40 文字で指定してください');
  if (selected && !CASES.some((item) => item.id === selected)) throw new Error('未知のケースです');
  if (profileId !== undefined && maxHitsArg !== undefined) throw new Error('--profile と --max-hits は同時に指定できません');
  let profile: { id: string; maxHits: number; maxIterations: number };
  let postHoc = false;
  if (maxHitsArg !== undefined) {
    const maxHits = Number(maxHitsArg);
    if (!Number.isSafeInteger(maxHits) || maxHits <= 0) throw new Error('--max-hits には正の整数を指定してください');
    profile = { id: `custom-${maxHits}`, maxHits, maxIterations: PROFILES.find((item) => item.id === 'default')!.maxIterations };
    postHoc = true;
  } else {
    const found = PROFILES.find((item) => item.id === (profileId ?? 'default'));
    if (!found) throw new Error('未知のプロファイルです');
    profile = found;
    postHoc = found.postHoc;
  }
  let seed = SEED;
  if (seedArg !== undefined) {
    seed = Number(seedArg);
    if (!Number.isSafeInteger(seed)) throw new Error('--seeds には整数を指定してください');
  }
  return { profile, ids: selected ? [selected] : CASES.map((item) => item.id), dryRun, postHoc, seed, c0Name, label };
}

/** --c0 で読み込み・検証済みの凍結 C0（run.ts のみで組み立て、executeCase はそのまま信用する）。 */
export interface FrozenC0Input {
  id: string;
  sha256: string;
  variant: C0Variant;
  draftIndex: number;
  protocol: ProtocolDraft;
  blocks: BlocksDraft;
  formula: PubmedFormula;
}

export interface ExecutionDeps {
  eutils: EutilsDeps;
  llmFactory: LlmProviderFactory;
  progress: (event: unknown) => void;
  save: () => void;
  /** 選択したシード分割。未指定なら fixture 埋め込みの既定分割（SEED）を使う。 */
  seeds?: FrozenSeeds;
  /** --c0 検証済みの凍結 C0。未指定なら従来どおり extractProtocol/generateDraftFormula でその場生成する。 */
  frozenC0?: FrozenC0Input;
}

export async function measureRejectedCandidates(result: RunResult, eutils: EutilsDeps): Promise<NonNullable<RunResult['rejectedCandidates']>> {
  const proposals = result.optimization?.trials.filter((trial) => trial.kind === 'proposal') ?? [];
  if (!proposals.some((trial) => !trial.accepted)) {
    process.stdout.write(`${result.id}: 却下候補なし; 追加計測なし\n`);
    return [];
  }
  if (!result.denominator) throw new Error(`${result.id}: 保存済みの分母がありません`);
  const { groups, heldOut, manualReviewPending } = result.denominator;
  const pmids = [...new Set(groups.flatMap((group) => group.pmids))];
  const dated = { ...eutils, fetch: createEvalFetch(result.searchDate, eutils.fetch, () => undefined) };
  const c0 = result.conditions.C0?.metrics;
  const candidates: NonNullable<RunResult['rejectedCandidates']> = [];
  for (const trial of proposals) {
    const prior = result.rejectedCandidates?.find((candidate) => candidate.candidateId === trial.candidateId && !candidate.error);
    if (prior) continue;
    let measurement;
    try { measurement = await evaluateSearch(expandFormula(trial.formula), pmids, dated); }
    catch (err) { measurement = { status: 'failure' as const, error: err instanceof Error ? err.message : String(err) }; }
    const metrics = measurement.status === 'success' && !manualReviewPending
      ? calculateMetrics(groups, heldOut, measurement.capturedPmids, measurement.hits) : null;
    candidates.push({ candidateId: trial.candidateId, accepted: trial.accepted, changes: trial.changes ?? null,
      hits: measurement.status === 'success' ? measurement.hits : null, metrics,
      comparedToC0: c0 && metrics ? compareMetrics(c0, metrics) : null,
      ...(measurement.status === 'failure' ? { error: measurement.error } : {}) });
  }
  return candidates;
}

export async function executeCase(fixture: BenchCase, audit: GoldAudit, protocolText: string, result: RunResult,
  deps: ExecutionDeps, b1?: { query: string }): Promise<void> {
  const { eutils, llmFactory, progress, save } = deps;
  if (DEFAULT_OPTIMIZATION_MAX_HITS !== PROFILES.find((profile) => profile.id === 'default')!.maxHits) throw new Error('アプリの既定上限と固定評価条件が一致しません');
  const seeds = deps.seeds ?? fixture.seeds;
  validateSeeds(seeds, fixture.gold);
  // gold の範囲確認は検索式生成より先に行い、捕捉結果から分母を選ばない。
  const allPmids = [...new Set(fixture.gold.flatMap((group) => group.pmids))];
  const inDate = await capturedGold('', allPmids, eutils);
  const groups = fixture.gold.map((group) => ({ ...group, pmids: group.pmids.filter((pmid) => inDate.includes(pmid)),
    members: group.members.map((study) => ({ ...study, pmids: study.pmids.filter((pmid) => inDate.includes(pmid)) }))
      .filter((study) => study.pmids.length > 0) })).filter((group) => group.pmids.length > 0);
  // held-out は「選択した分割のシード群を除いた残り全群」。分割ごとに実行時に求め、case.json の値は既定分割にしか対応しない。
  const heldOut = computeHeldOut(groups, seeds);
  result.seedSplit = seedSplitId(seeds.seed);
  result.denominator = { groups, heldOut, outsideDatePmids: allPmids.filter((pmid) => !inDate.includes(pmid)),
    outsideDateGroups: fixture.gold.filter((group) => !groups.some((g) => g.id === group.id)).map((g) => g.id),
    manualReviewPending: audit.manual_review };
  save();
  const seedPmids = seeds.selections.map((seed) => seed.pmid);
  if (seedPmids.some((pmid) => !inDate.includes(pmid))) throw new Error('凍結済みシードが検索日範囲外です。自動で差し替えません');
  const papers = await seedTitles(seedPmids, eutils);
  let protocol: ProtocolDraft;
  let blocks: BlocksDraft;
  let formula: PubmedFormula;
  if (deps.frozenC0) {
    protocol = deps.frozenC0.protocol;
    blocks = deps.frozenC0.blocks;
    formula = deps.frozenC0.formula;
    result.c0 = { source: 'frozen', id: deps.frozenC0.id, sha256: deps.frozenC0.sha256,
      variant: deps.frozenC0.variant, draftIndex: deps.frozenC0.draftIndex };
  } else {
    const extracted = await extractProtocol(protocolText, llmFactory.forPurpose('extract_protocol'));
    protocol = { ...extracted, sourceType: 'markdown' as const, sourceFilename: 'protocol.md', rawTextRef: null,
      rawTextPreview: protocolText.slice(0, 500), rawTextInline: protocolText };
    blocks = { blocks: extracted.blocks.map((block) => ({ ...block, aiGenerated: true, note: '' })),
      combinationExpression: extracted.combinationExpression };
    // C0 は適格基準だけから生成し、既知 3 群を与える追加工程の効果を C1 で測る。
    const draft = await generateDraftFormula({ protocol, blocks, targetHits: result.maxHits,
      seedContext: { titles: [], samples: [], meshSummary: { seedCount: 0, concepts: [], checkTags: [] } } },
    { llmFactory, onProgress: progress, countBlockHits: async (query) => (await esearch(query, eutils, { retmax: 0 })).count });
    formula = draft.formula;
    result.c0 = { source: 'live' };
  }
  const measure = async (query: string): Promise<ConditionResult> => {
    const measurement = await evaluateSearch(query, inDate, eutils);
    return { query, measurement, metrics: measurement.status === 'success' && !audit.manual_review
      ? calculateMetrics(groups, heldOut, measurement.capturedPmids, measurement.hits) : null };
  };
  result.conditions.C0 = { ...await measure(expandFormula(formula)), formula };
  save();
  result.optimization = await runQueryOptimization({ projectId: fixture.id, runId: result.runId,
    initialFormula: formula, seedPmids, seedPapers: papers, maxHits: result.maxHits, maxIterations: result.maxIterations,
    approvedBlocks: blocks.blocks.map((block, index) => ({ id: String(index + 1), approvedBlockId: String(index + 1), label: block.blockLabel })),
    criteria: { researchQuestion: protocol.researchQuestion, inclusionCriteria: protocol.inclusionCriteria, exclusionCriteria: protocol.exclusionCriteria } },
  { eutils, llmFactory, checkpoint: memoryCheckpoint(), fetchMeshContext: (request, observed) => fetchMeshContext(request, observed ?? eutils),
    onProgress: progress, measureTermDetails: true });
  const best = result.optimization.best;
  if (best) result.conditions.C1 = { ...await measure(expandFormula(best.formula)), formula: best.formula };
  else result.conditions.C1 = { query: '', measurement: { status: 'failure', error: '自動調整の有効な最良式がありません' }, metrics: null };
  save();
  if (b1) { result.conditions.B1 = await measure(b1.query); save(); }
  const c0 = result.conditions.C0.metrics;
  const c1 = result.conditions.C1.metrics;
  result.comparison = c0 && c1 ? compareMetrics(c0, c1) : null;
  const candidates = await measureRejectedCandidates(result, eutils);
  if (candidates.length) { result.rejectedCandidates = candidates; save(); }
  // 有害採用の監査と確認負荷の集計は、既存の測定失敗判定とは独立させる（両方とも失敗しても run を
  // failed にはしない。前者は分母欠落時のみ例外を投げるが、それ以外は自身のエラーを記録して続行する）。
  result.adoptionAudit = await computeAdoptionAudit(result, eutils);
  result.confirmation = await computeConfirmation(result, protocol, seedPmids, { eutils, llmFactory });
  save();
  result.status = result.optimization.status === 'error' || candidates.some((candidate) => candidate.error)
    || Object.values(result.conditions).some((condition) => condition.measurement.status === 'failure') ? 'failed' : 'completed';
}

/** 完了結果を別コミットで上書きしないため、保存処理より前に判定する。 */
export function decideExisting(existing: RunResult, profile: Pick<ParsedArgs['profile'], 'maxHits'>, gitCommit: string | null): 'run' | 'skip' {
  if (existing.status !== 'completed' || existing.maxHits !== profile.maxHits) return 'run';
  if (existing.gitCommit === gitCommit) return 'skip';
  throw new Error(`別コミット（既存=${existing.gitCommit?.slice(0, 12) ?? '欠測'}, 現在=${gitCommit?.slice(0, 12) ?? '欠測'}）の完了結果があります。比較用に残すなら --label を付けて実行してください`);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { ids, dryRun, profile, postHoc, seed, c0Name, label } = parseArgs(args);
  if (!dryRun) {
    config();
    // searchOutsideCandidates（confirmation の集計）が efetchArticles を使うため、非 dry-run では必ず補う。
    installDomParser();
  }
  const secrets = [process.env.GEMINI_API_KEY ?? '', process.env.NCBI_API_KEY ?? ''];
  const splitId = seedSplitId(seed);
  const c0Key = c0Name ?? 'live';
  const gitCommit = getGitCommit();
  for (const id of ids) {
    const dir = resultDir(RESULTS, profile.id, id, c0Key, splitId, label);
    const resultPath = join(dir, 'run.json');
    if (!dryRun && existsSync(resultPath)) {
      try {
        const existing = JSON.parse(readFileSync(resultPath, 'utf8')) as RunResult;
        if (decideExisting(existing, profile, gitCommit) === 'skip') {
          process.stdout.write(`${id}: 完了済みのためスキップ\n`); continue;
        }
      } catch (err) {
        process.stdout.write(`${id}: failed (${redact(err instanceof Error ? err.message : String(err), secrets)})\n`);
        process.exitCode = 1;
        continue;
      }
    }
    const start = Date.now();
    const runId = `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const attemptDir = join(dir, runId);
    const role = CASES.find((item) => item.id === id)!.role;
    const result: RunResult = { id, runId, profileId: profile.id, status: dryRun ? 'dry-run' : 'running', startedAt: new Date().toISOString(),
      model: '', searchDate: '', maxHits: profile.maxHits, maxIterations: profile.maxIterations, conditions: {}, apiCalls: { ncbi: 0, llm: 0 },
      apiElapsedMs: { ncbi: 0, llm: 0 }, elapsedMs: 0, llmLogs: [], gitCommit, gitDirty: isGitDirty(),
      seedSplit: splitId, role, postHoc, label };
    const serialize = (value: unknown) => redact(JSON.stringify(value, null, 2), secrets) + '\n';
    const save = () => {
      if (dryRun) return;
      result.elapsedMs = Date.now() - start;
      writeFileSync(join(attemptDir, 'run.json'), serialize(result));
      writeFileSync(`${resultPath}.tmp`, serialize(result));
      renameSync(`${resultPath}.tmp`, resultPath);
    };
    const progress = (event: unknown) => {
      if (!dryRun) appendFileSync(join(attemptDir, 'progress.jsonl'), redact(JSON.stringify({ at: new Date().toISOString(), event }), secrets) + '\n');
    };
    try {
      if (!dryRun) mkdirSync(join(attemptDir, 'llm'), { recursive: true });
      progress({ process: { pid: process.pid, hasApiKey: Boolean(process.env.NCBI_API_KEY), caseCount: ids.length,
        caseExecution: 'sequential', requestConcurrency: 'caller-dependent', externalConcurrency: 'unknown',
        gitCommit, gitDirty: result.gitDirty, runId } });
      const fixtureDir = join(FIXTURES, id);
      const fixture = JSON.parse(readFileSync(join(fixtureDir, 'case.json'), 'utf8')) as BenchCase;
      const audit = JSON.parse(readFileSync(join(fixtureDir, 'audit.json'), 'utf8')) as GoldAudit;
      const protocolText = readFileSync(join(fixtureDir, fixture.protocolPath), 'utf8');
      const seeds = loadSeedsFile(fixtureDir, seed);
      validateSeeds(seeds, fixture.gold);
      result.searchDate = fixture.searchDate;
      // --c0 の検証（ケース ID・ハッシュ・シード分割の整合）はネットワーク不要なので dry-run でも行う。
      let frozenC0: FrozenC0Input | undefined;
      if (c0Name) {
        const artifact = loadC0Artifact(FIXTURES, id, c0Name);
        if (artifact.seedSplit !== null && artifact.seedSplit !== splitId) {
          throw new Error(`凍結 C0 のシード分割 (${artifact.seedSplit}) が実行時の分割 (${splitId}) と一致しません`);
        }
        frozenC0 = { id: c0Name, sha256: artifact.sha256, variant: artifact.variant, draftIndex: artifact.draftIndex,
          protocol: artifact.protocol, blocks: artifact.blocks, formula: artifact.formula };
      }
      const network: typeof fetch = dryRun ? async () => { throw new Error('dry-run での通信は禁止です'); } : globalThis.fetch;
      const observed = createEvalFetch(fixture.searchDate, network, (event) => {
        const category = new URL(event.url).hostname === 'generativelanguage.googleapis.com' ? 'llm' : 'ncbi';
        result.apiCalls[category]++;
        result.apiElapsedMs[category] += event.elapsedMs;
        progress({ api: category, ...event });
      }, secrets);
      const provider = new GeminiProvider({ apiKey: dryRun ? '' : process.env.GEMINI_API_KEY ?? '', fetch: observed });
      const usageTracker = createLlmUsageTracker();
      result.llmUsage = usageTracker.usage;
      const llmFactory = loggedFactory(provider, (path, value) => {
        if (!dryRun) writeFileSync(join(attemptDir, path), serialize(value));
      }, result.llmLogs, usageTracker.record);
      result.model = llmFactory.model;
      const eutils: EutilsDeps = { fetch: observed, apiKey: dryRun ? undefined : process.env.NCBI_API_KEY, strictCounts: true };
      eutils.rateLimiter = observeRateLimiter(eutils, (limiter) => progress({ limiter }));
      if (dryRun) {
        const checkpoint = memoryCheckpoint();
        await checkpoint.write({ probe: true });
        if (!await checkpoint.read('probe') || !protocolText.trim()
          || DEFAULT_OPTIMIZATION_MAX_HITS !== PROFILES.find((profile) => profile.id === 'default')!.maxHits) throw new Error('配線確認に失敗しました');
        llmFactory.forPurpose('extract_protocol');
        process.stdout.write(`${id}: dry-run OK (profile=${profile.id}, maxHits=${profile.maxHits}, maxIterations=${profile.maxIterations}, `
          + `seedSplit=${splitId}, c0=${c0Key}, label=${label ?? '-'}, API calls=0, groups=${fixture.gold.length}, heldOut=${computeHeldOut(fixture.gold, seeds).length})\n`);
        continue;
      }
      save();
      if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です');
      const b1Path = join(fixtureDir, 'b1.json');
      const b1 = existsSync(b1Path) ? JSON.parse(readFileSync(b1Path, 'utf8')) as { query: string } : undefined;
      if (b1 && (typeof b1.query !== 'string' || !b1.query.trim())) throw new Error('b1.json には query が必要です');
      await executeCase(fixture, audit, protocolText, result, { eutils, llmFactory, save, progress, seeds, frozenC0 }, b1);
    } catch (err) {
      result.status = 'failed';
      result.error = redact(err instanceof Error ? err.message : String(err), secrets);
      process.exitCode = 1;
    } finally {
      if (!dryRun && existsSync(attemptDir)) {
        progress({ status: result.status, error: result.error ?? null });
        save();
      }
    }
    process.stdout.write(`${id}: ${result.status}${result.error ? ` (${result.error})` : ''}\n`);
  }
}

if (require.main === module) void main().catch(() => { process.stderr.write('引数または実行環境を確認してください。\n'); process.exitCode = 1; });
