import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { generateDraftFormula } from '../../src/app/services/draftService';
import { runQueryOptimization } from '../../src/app/services/queryOptimizationService';
import { fetchMeshContext } from '../../src/app/services/meshContextService';
import { extractProtocol } from '../../src/features/formula/skills/extractProtocol';
import { HIT_THRESHOLD } from '../../src/features/formula/skills/filterDesigner';
import { expandFormula } from '../../src/features/validation/expandFormula';
import { GeminiProvider } from '../../src/lib/llm/GeminiProvider';
import { withRetry } from '../../src/lib/llm/retry';
import type { LLMProvider } from '../../src/lib/llm/LLMProvider';
import type { LlmProviderFactory } from '../../src/app/services/llmProviderService';
import type { EutilsDeps } from '../../src/lib/ncbi/eutils';
import type { ProjectStoreDeps } from '../../src/features/project/projectStore';
import { esearch } from '../../src/lib/ncbi/eutils';
import { FIXTURES, validateSeeds } from './prepare';
import { capturedGold, createEvalFetch, evaluateSearch, redact, seedTitles } from './ncbiEval';
import { calculateMetrics, compareMetrics } from './metrics';
import { CASES, PROFILES, type BenchCase, type GoldAudit, type RunResult, type ConditionResult } from './types';

export const RESULTS = resolve(__dirname, 'results');

export function memoryCheckpoint(): ProjectStoreDeps {
  const values: Record<string, unknown> = {};
  return { read: async <T>(key: string) => values[key] as T | undefined, write: async (items) => { Object.assign(values, items); } };
}

export function loggedFactory(provider: LLMProvider, write: (path: string, value: unknown) => void,
  paths: string[]): LlmProviderFactory {
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
        return response;
      } catch (err) {
        write(path, { purpose, model: provider.model, messages, options, response: null, tokensIn: null,
          tokensOut: null, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err),
          responseBody: err && typeof err === 'object' && 'responseBody' in err ? err.responseBody : null });
        throw err;
      }
    },
  }, { onRequestState }) };
}

export function parseArgs(args: string[]): { ids: string[]; dryRun: boolean; profile: typeof PROFILES[number] } {
  let selected: string | undefined;
  let dryRun = false;
  let profileId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--case' && selected === undefined && args[i + 1]) selected = args[++i];
    else if (args[i] === '--profile' && profileId === undefined && args[i + 1]) profileId = args[++i];
    else throw new Error(`未対応の引数: ${args[i]}`);
  }
  if (selected && !CASES.some((item) => item.id === selected)) throw new Error('未知のケースです');
  const profile = PROFILES.find((item) => item.id === (profileId ?? 'default'));
  if (!profile) throw new Error('未知のプロファイルです');
  return { profile, ids: selected ? [selected] : CASES.map((item) => item.id), dryRun };
}

export interface ExecutionDeps {
  eutils: EutilsDeps;
  llmFactory: LlmProviderFactory;
  progress: (event: unknown) => void;
  save: () => void;
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
  if (HIT_THRESHOLD !== PROFILES.find((profile) => profile.id === 'default')!.maxHits) throw new Error('アプリの既定上限と固定評価条件が一致しません');
  validateSeeds(fixture.seeds, fixture.gold);
  // gold の範囲確認は検索式生成より先に行い、捕捉結果から分母を選ばない。
  const allPmids = [...new Set(fixture.gold.flatMap((group) => group.pmids))];
  const inDate = await capturedGold('', allPmids, eutils);
  const groups = fixture.gold.map((group) => ({ ...group, pmids: group.pmids.filter((pmid) => inDate.includes(pmid)),
    members: group.members.map((study) => ({ ...study, pmids: study.pmids.filter((pmid) => inDate.includes(pmid)) }))
      .filter((study) => study.pmids.length > 0) })).filter((group) => group.pmids.length > 0);
  const heldOut = fixture.heldOut.filter((id) => groups.some((group) => group.id === id));
  result.denominator = { groups, heldOut, outsideDatePmids: allPmids.filter((pmid) => !inDate.includes(pmid)),
    outsideDateGroups: fixture.gold.filter((group) => !groups.some((g) => g.id === group.id)).map((g) => g.id),
    manualReviewPending: audit.manual_review };
  save();
  const seedPmids = fixture.seeds.selections.map((seed) => seed.pmid);
  if (seedPmids.some((pmid) => !inDate.includes(pmid))) throw new Error('凍結済みシードが検索日範囲外です。自動で差し替えません');
  const papers = await seedTitles(seedPmids, eutils);
  const extracted = await extractProtocol(protocolText, llmFactory.forPurpose('extract_protocol'));
  const protocol = { ...extracted, sourceType: 'markdown' as const, sourceFilename: 'protocol.md', rawTextRef: null,
    rawTextPreview: protocolText.slice(0, 500), rawTextInline: protocolText };
  const blocks = { blocks: extracted.blocks.map((block) => ({ ...block, aiGenerated: true, note: '' })),
    combinationExpression: extracted.combinationExpression };
  // C0 は適格基準だけから生成し、既知 3 群を与える追加工程の効果を C1 で測る。
  const draft = await generateDraftFormula({ protocol, blocks, targetHits: result.maxHits,
    seedContext: { titles: [], samples: [], meshSummary: { seedCount: 0, concepts: [], checkTags: [] } } },
  { llmFactory, onProgress: progress, countBlockHits: async (query) => (await esearch(query, eutils, { retmax: 0 })).count });
  const measure = async (query: string): Promise<ConditionResult> => {
    const measurement = await evaluateSearch(query, inDate, eutils);
    return { query, measurement, metrics: measurement.status === 'success' && !audit.manual_review
      ? calculateMetrics(groups, heldOut, measurement.capturedPmids, measurement.hits) : null };
  };
  result.conditions.C0 = { ...await measure(expandFormula(draft.formula)), formula: draft.formula };
  save();
  result.optimization = await runQueryOptimization({ projectId: fixture.id, runId: result.runId,
    initialFormula: draft.formula, seedPmids, seedPapers: papers, maxHits: result.maxHits, maxIterations: result.maxIterations,
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
  result.status = result.optimization.status === 'error' || candidates.some((candidate) => candidate.error)
    || Object.values(result.conditions).some((condition) => condition.measurement.status === 'failure') ? 'failed' : 'completed';
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { ids, dryRun, profile } = parseArgs(args);
  if (!dryRun) config();
  const secrets = [process.env.GEMINI_API_KEY ?? '', process.env.NCBI_API_KEY ?? ''];
  for (const id of ids) {
    const dir = join(RESULTS, profile.id, id);
    const resultPath = join(dir, 'run.json');
    if (!dryRun && existsSync(resultPath) && (JSON.parse(readFileSync(resultPath, 'utf8')) as RunResult).status === 'completed') {
      process.stdout.write(`${id}: 完了済みのためスキップ\n`); continue;
    }
    const start = Date.now();
    const runId = `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const attemptDir = join(dir, runId);
    const result: RunResult = { id, runId, profileId: profile.id, status: dryRun ? 'dry-run' : 'running', startedAt: new Date().toISOString(),
      model: '', searchDate: '', maxHits: profile.maxHits, maxIterations: profile.maxIterations, conditions: {}, apiCalls: { ncbi: 0, llm: 0 },
      apiElapsedMs: { ncbi: 0, llm: 0 }, elapsedMs: 0, llmLogs: [] };
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
      const fixtureDir = join(FIXTURES, id);
      const fixture = JSON.parse(readFileSync(join(fixtureDir, 'case.json'), 'utf8')) as BenchCase;
      const audit = JSON.parse(readFileSync(join(fixtureDir, 'audit.json'), 'utf8')) as GoldAudit;
      const protocolText = readFileSync(join(fixtureDir, fixture.protocolPath), 'utf8');
      validateSeeds(fixture.seeds, fixture.gold);
      result.searchDate = fixture.searchDate;
      const network: typeof fetch = dryRun ? async () => { throw new Error('dry-run での通信は禁止です'); } : globalThis.fetch;
      const observed = createEvalFetch(fixture.searchDate, network, (event) => {
        const category = new URL(event.url).hostname === 'generativelanguage.googleapis.com' ? 'llm' : 'ncbi';
        result.apiCalls[category]++;
        result.apiElapsedMs[category] += event.elapsedMs;
        progress({ api: category, ...event });
      }, secrets);
      const provider = new GeminiProvider({ apiKey: dryRun ? '' : process.env.GEMINI_API_KEY ?? '', fetch: observed });
      const llmFactory = loggedFactory(provider, (path, value) => {
        if (!dryRun) writeFileSync(join(attemptDir, path), serialize(value));
      }, result.llmLogs);
      result.model = llmFactory.model;
      const eutils: EutilsDeps = { fetch: observed, apiKey: dryRun ? undefined : process.env.NCBI_API_KEY, strictCounts: true };
      if (dryRun) {
        const checkpoint = memoryCheckpoint();
        await checkpoint.write({ probe: true });
        if (!await checkpoint.read('probe') || !protocolText.trim() || HIT_THRESHOLD !== PROFILES.find((profile) => profile.id === 'default')!.maxHits) throw new Error('配線確認に失敗しました');
        llmFactory.forPurpose('extract_protocol');
        process.stdout.write(`${id}: dry-run OK (profile=${profile.id}, maxHits=${profile.maxHits}, maxIterations=${profile.maxIterations}, API calls=0, groups=${fixture.gold.length}, heldOut=${fixture.heldOut.length})\n`);
        continue;
      }
      save();
      if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です');
      const b1Path = join(fixtureDir, 'b1.json');
      const b1 = existsSync(b1Path) ? JSON.parse(readFileSync(b1Path, 'utf8')) as { query: string } : undefined;
      if (b1 && (typeof b1.query !== 'string' || !b1.query.trim())) throw new Error('b1.json には query が必要です');
      await executeCase(fixture, audit, protocolText, result, { eutils, llmFactory, save, progress }, b1);
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
