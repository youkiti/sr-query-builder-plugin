import {
  optimizeQuery,
  type ApprovedOptimizationBlock,
  type OptimizationCriteria,
  type OptimizationMeasurement,
  type OptimizationMeshNode,
  type OptimizationMeshRequest,
  type OptimizationMeshRequestResult,
  type OptimizationTrial,
  type OptimizationApiEvent,
  type OptimizeQueryProposal,
} from '@/features/formula/skills/optimizeQuery';
import type { ProjectStoreDeps } from '@/features/project';
import { extractBlockTerms } from '@/features/validation/blockTerms';
import { analyzeFreewordDelta } from '@/features/validation/freewordDelta';
import { expandFormula } from '@/features/validation/expandFormula';
import { tokenizeExpression } from '@/lib/search-formula-md/expression';
import {
  extractBlockReferences, findUnreachableBlockIds, wouldCreateReferenceCycle,
} from '@/lib/search-formula-md/references';
import { tokenizeCombination, validateCombinationExpression, validateReferences } from '@/lib/combination-expression';
import type { PubmedFormula } from '@/lib/search-formula-md';
import { esearch, type EutilsDeps } from '@/lib/ncbi';
import { resolveRateLimiter } from '@/lib/ncbi/eutils';
import type { LlmProviderFactory } from './llmProviderService';
import { evaluateQuery, type QueryEvaluation } from './queryEvaluationService';
import { saveQueryOptimizationCheckpoint } from './queryOptimizationCheckpointService';

export interface QueryOptimizationInput {
  projectId: string;
  runId: string;
  initialFormula: PubmedFormula;
  /** 概念ブロックだけを対応づける。結合行と対応外のフィルタは固定する。 */
  approvedBlocks: ApprovedOptimizationBlock[];
  /** 適格判定は呼び出し側で完了している前提。 */
  seedPmids: string[];
  criteria: OptimizationCriteria;
  maxHits: number;
  maxIterations?: number;
  seedPapers?: { pmid: string; title: string | null }[];
  /** 呼び出し側で取得済みの周辺ツリー。未提供なら未取得として AI に明示する。 */
  meshContext?: OptimizationMeshNode[];
}

export type QueryOptimizationStep =
  /** bootstrap で初期式を生成・準備している段階。 */
  | 'initial_formula'
  /** 初期式または AI が提案した候補の実測。 */
  | 'measuring'
  /** 語別分析、AI の修正提案、追加 MeSH 文脈の取得。 */
  | 'adjusting'
  /** 条件達成候補をキャッシュに依存せず測り直す最終確認。 */
  | 'revalidating'
  /** 処理が終了し、人によるレビューへ渡す段階。 */
  | 'review';

export interface QueryOptimizationProgress {
  /** 情報要求と通信リトライを含まない、修正案の評価数。 */
  evaluatedTrials?: number;
  task?: { kind: 'terms' | 'seeds'; completed: number; total: number } | null;
  apiEvents?: OptimizationApiEvent[];
  apiWaiting?: OptimizationApiEvent | null;
  step: QueryOptimizationStep;
  iterations: number;
  bestTotalHits: number | null;
  bestCapturedSeedCount: number | null;
  /** 試行確定時だけ設定する。段階通知では null。 */
  trial: OptimizationTrial | null;
}

export interface QueryOptimizationDeps {
  /**
   * 詳細表示用の追加計測。未指定なら従来の通信・候補評価を維持する。
   * 全概念行が OR、フリーワード総数 F、その語を含むブロック数 B、MeSH 語数 M なら、
   * 候補ごとの語別計測は概ね 3F − B + M 回（再試行・キャッシュ重複を除く）。
   * 1 ブロックで F=20、M=5 なら約64回、うち固有寄与は20回。
   * 有効時は通信予算200回を早く消費し、通常の実測や初期式分析もあるため、
   * 候補3本より前でも api_budget で停止し得る。採用後の語別計測は再利用する。
   */
  measureTermDetails?: boolean;
  /** run 共通の MeSH 文脈。初期化・追加取得時だけ通知し、表示側の例外は隔離する。 */
  onMeshContext?: (nodes: OptimizationMeshNode[]) => void;
  /** 未注入なら通知しない。表示側の例外は最適化へ伝播させない。 */
  onProgress?: (progress: QueryOptimizationProgress) => void;
  eutils: EutilsDeps;
  /** 注入ファクトリの LLM 監査ログ保存は許容する。サービス自身は Sheets/Drive を書かない。 */
  llmFactory: LlmProviderFactory;
  checkpoint: ProjectStoreDeps;
  /**
   * 指定された descriptor / 枝の周辺を取得し、実際に確認できたノードだけを返す。
   * 1 回の追加取得を通信予算の 1 単位として数える。内部の通信・再試行は取得側で制限する。
   * fetchMeshTreeNumbers / fetchMeshChildren / fetchMeshLabels の組立ては注入側が担う。
   */
  fetchMeshContext?: (request: Readonly<OptimizationMeshRequest>, eutils?: EutilsDeps) => Promise<OptimizationMeshNode[]>;
  shouldStop?: () => boolean;
  now?: () => number;
  maxApiCalls?: number;
  maxElapsedMs?: number;
}

export interface VerifiedOptimizationCandidate {
  formula: PubmedFormula;
  evaluation: QueryEvaluation;
  measurement: OptimizationMeasurement;
}

export type OptimizationStopReason =
  | 'conditions_met' | 'iteration_limit' | 'repeated_formula' | 'no_improvement'
  | 'user_stop' | 'api_error' | 'api_budget' | 'time_budget' | 'invalid_input'
  | 'revalidation_failed';

/** NCBI の失敗とは区別する、反復サービスの制御用例外。 */
export class QueryOptimizationStopError extends Error {
  constructor(readonly stopReason: OptimizationStopReason) {
    const messages: Record<OptimizationStopReason, string> = {
      conditions_met: '目標条件を達成したため終了しました。',
      iteration_limit: '反復回数の上限に達したため終了しました。',
      repeated_formula: '評価済みの同じ式に戻ったため終了しました。',
      no_improvement: '改善が連続して得られなかったため終了しました。',
      user_stop: 'ユーザーの停止要求により処理を停止しました。',
      api_error: 'API エラーにより処理を続けられません。',
      api_budget: '通信回数の予算上限に達したため処理を停止しました。',
      time_budget: '実行時間の予算上限に達したため処理を停止しました。',
      invalid_input: '入力が不正なため処理を開始できません。',
      revalidation_failed: '最終再検証で条件を満たさなかったため終了しました。',
    };
    super(messages[stopReason]);
    this.name = 'QueryOptimizationStopError';
  }
}

export interface QueryOptimizationResult {
  status: 'achieved' | 'needs_review' | 'stopped' | 'error';
  stopReason: OptimizationStopReason;
  best: VerifiedOptimizationCandidate | null;
  trials: OptimizationTrial[];
  unmetReasons: string[];
  iterations: number;
  apiCalls: number;
  elapsedMs: number;
}

// 最大 5 候補＋初期・最終測定と語別分析を収めつつ、暴走を有限にする既定値。
// NCBI の実 HTTP（リトライ含む）＋ LLM chat ＋ MeSH 追加取得の単位で 200 回、待機込み 10 分。
// 注入プロバイダ内部の再試行・監査通信は外側から観測できないため chat 1 回に数える。
export const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_MAX_API_CALLS = 200;
const DEFAULT_MAX_ELAPSED_MS = 10 * 60 * 1000;
// 一度に全階層を取得せず、優先する少数の枝を調べる。既定 5 反復でも追加取得は最大 15 回。
const MAX_MESH_REQUESTS_PER_ITERATION = 3;
// 候補由来の単発失敗は修正機会を残す。改善なしの停止基準と揃え、2 回連続の測定失敗は
// 通信障害の可能性もあるため追加の LLM 呼び出しを止める。成功した測定で回数を戻す。
const MAX_CONSECUTIVE_MEASUREMENT_FAILURES = 2;

/** 保存なしの候補評価と局面別の採否判定を直列実行する。公開版の保存・store 更新は行わない。 */
export async function runQueryOptimization(
  input: QueryOptimizationInput,
  deps: QueryOptimizationDeps
): Promise<QueryOptimizationResult> {
  const fixed: QueryOptimizationInput = {
    projectId: input.projectId, runId: input.runId,
    initialFormula: {
      blocks: input.initialFormula.blocks.map(({ id, expression, isCombination }) => ({ id, expression, isCombination })),
      combinationExpression: input.initialFormula.combinationExpression,
    },
    approvedBlocks: input.approvedBlocks.map(({ id, approvedBlockId, label }) => ({ id, approvedBlockId, label })),
    seedPmids: [...new Set(input.seedPmids)],
    criteria: {
      researchQuestion: input.criteria.researchQuestion,
      inclusionCriteria: input.criteria.inclusionCriteria,
      exclusionCriteria: input.criteria.exclusionCriteria,
    },
    maxHits: input.maxHits, maxIterations: input.maxIterations,
    seedPapers: input.seedPapers?.map(({ pmid, title }) => ({ pmid, title })),
    meshContext: input.meshContext?.map(copyMeshNode),
  };
  let meshContext = fixed.meshContext;
  const notifyMeshContext = (): void => {
    try { deps.onMeshContext?.((meshContext ?? []).map(copyMeshNode)); } catch {
      // 表示側の失敗で取得済み文脈や反復処理を変えない。
    }
  };
  const meshRequestResults: OptimizationMeshRequestResult[] = [];
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const maxIterations = fixed.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxApiCalls = deps.maxApiCalls ?? DEFAULT_MAX_API_CALLS;
  const maxElapsedMs = deps.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
  let apiCalls = 0;
  let iterations = 0;
  let evaluatedTrials = 0;
  let task: QueryOptimizationProgress['task'] = null;
  let apiWaiting: OptimizationApiEvent | null = null;
  let apiEvents: OptimizationApiEvent[] = [];
  let apiSource: OptimizationApiEvent['source'] = 'PubMed';
  let best: VerifiedOptimizationCandidate | null = null;
  const trials: OptimizationTrial[] = [];
  let step: QueryOptimizationStep = 'measuring';
  const notify = (trial: OptimizationTrial | null = null): void => {
    if (!deps.onProgress) return;
    try {
      deps.onProgress({ step, iterations,
        evaluatedTrials, task: task ? { ...task } : null,
        apiWaiting: apiWaiting ? { ...apiWaiting } : null,
        apiEvents: apiEvents.map((event) => ({ ...event })),
        bestTotalHits: best?.measurement.totalHits ?? null,
        bestCapturedSeedCount: best?.measurement.capturedPmids?.length ?? null,
        // 通知先による変更が確定済み試行に戻らないよう、値として渡す。
        trial: trial ? JSON.parse(JSON.stringify(trial)) as OptimizationTrial : null,
      });
    } catch {
      // 画面の通知失敗で実測・停止判定を変えない。
    }
  };
  const apiEvent = (status: OptimizationApiEvent['status']): void => {
    const event = { status, source: apiSource };
    apiWaiting = status === 'failure' ? null : event;
    if (!apiEvents.some((item) => item.status === status && item.source === apiSource)) apiEvents.push(event);
    notify();
  };
  const seen = new Set<string>();
  let terminal: OptimizationStopReason | null = null;

  // 一度停止したら callback が false に戻っても再開しない。応答の前後で同じ境界を使う。
  // 通信予算を使い切る最後の応答も破棄する。上限到達後の結果更新を許さないため。
  function boundary(): void {
    if (!terminal && deps.shouldStop?.()) terminal = 'user_stop';
    if (!terminal && now() - startedAt >= maxElapsedMs) terminal = 'time_budget';
    if (!terminal && apiCalls >= maxApiCalls) terminal = 'api_budget';
    if (terminal) throw new QueryOptimizationStopError(terminal);
  }
  const rateLimiter = resolveRateLimiter(deps.eutils);
  const eutils: EutilsDeps = {
    ...deps.eutils,
    strictCounts: true,
    rateLimiter: {
      acquire: async () => {
        boundary();
        await (deps.onProgress ? rateLimiter.acquire(() => apiEvent('rate_limit')) : rateLimiter.acquire());
        apiWaiting = null;
        notify();
        boundary();
      },
    },
    // 制御用例外は NCBI のリトライ判定を変更しない。待機の境界で停止を再送出する。
    sleep: async (ms) => {
      boundary();
      apiEvent('retry');
      await (deps.eutils.sleep ? deps.eutils.sleep(ms) : new Promise<void>((resolve) => setTimeout(resolve, ms)));
      apiWaiting = null;
      notify();
      boundary();
    },
    fetch: async (resource, init) => {
      boundary();
      apiCalls += 1;
      const response = await deps.eutils.fetch(resource, { ...init, cache: 'no-store' });
      boundary();
      return response;
    },
  };
  // MeSH 取得は従来どおり外側で一単位に数える。内部通信は表示だけを観測する。
  const meshEutils: EutilsDeps = {
    ...deps.eutils,
    rateLimiter: { acquire: async () => {
      await (deps.onProgress ? rateLimiter.acquire(() => apiEvent('rate_limit')) : rateLimiter.acquire());
      apiWaiting = null;
      notify();
    } },
    sleep: async (ms) => {
      apiEvent('retry');
      await (deps.eutils.sleep ? deps.eutils.sleep(ms) : new Promise<void>((resolve) => setTimeout(resolve, ms)));
      apiWaiting = null;
      notify();
    },
  };
  const expandMesh = async (requests: readonly OptimizationMeshRequest[], canContinue: boolean) => {
    const results: OptimizationMeshRequestResult[] = [];
    for (const [index, request] of requests.entries()) {
      boundary();
      let note: string;
      if (!canContinue) {
        note = '未取得: 反復上限に達したため追加取得を打ち切りました。';
      } else if (index >= MAX_MESH_REQUESTS_PER_ITERATION) {
        note = `未取得: 1 反復あたり ${MAX_MESH_REQUESTS_PER_ITERATION} 件の追加取得上限で打ち切りました。`;
      } else if (!request.descriptor && !request.treeNumber) {
        note = '未取得: descriptor と tree number の両方が未指定です。';
      } else if (!deps.fetchMeshContext) {
        note = '未取得: MeSH 取得 callback が注入されていません。';
      } else {
        boundary();
        apiCalls += 1;
        try {
          apiSource = 'MeSH';
          const nodes = await (deps.onProgress
            ? deps.fetchMeshContext({ ...request }, meshEutils)
            : deps.fetchMeshContext({ ...request }));
          boundary();
          // 取得した関係だけを統合する。未取得理由を実在ノードとして捏造しない。
          const merged = new Map((meshContext ?? []).map((node) => [node.id, node]));
          for (const node of nodes) {
            const previous = merged.get(node.id);
            const added = copyMeshNode(node);
            merged.set(node.id, previous ? {
              ...added,
              treeNumbers: [...new Set([...previous.treeNumbers, ...added.treeNumbers])],
              parentIds: [...new Set([...previous.parentIds, ...added.parentIds])],
              childIds: [...new Set([...previous.childIds, ...added.childIds])],
            } : added);
          }
          meshContext = [...merged.values()];
          notifyMeshContext();
          note = nodes.length > 0 ? '追加取得した周辺ノードを文脈へ反映しました。'
            : '未取得: 取得結果が空のため追加の親子関係は確認できませんでした。';
        } catch (err) {
          if (err instanceof QueryOptimizationStopError) throw err;
          boundary();
          apiEvent('failure');
          note = `未取得: MeSH 取得に失敗しました。理由: ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          apiSource = 'PubMed';
        }
      }
      results.push({ request: { ...request }, note });
    }
    meshRequestResults.push(...results);
    return results.map(({ request, note }) => `${request.descriptor || '(未指定)'} / ${request.treeNumber || '(未指定)'}: ${note}`).join('\n');
  };
  const save = async () => {
    const latest = trials[trials.length - 1];
    if (latest) latest.apiEvents = apiEvents.map((event) => ({ ...event }));
    task = null;
    notify(trials[trials.length - 1] ?? null);
    boundary();
    await saveQueryOptimizationCheckpoint(fixed.projectId, fixed.runId, fixed.maxHits,
      trials, deps.checkpoint, () => new Date(now()).toISOString());
    boundary();
  };
  const measure = async (formula: PubmedFormula, candidateId: string) => {
    boundary();
    task = fixed.seedPmids.length ? { kind: 'seeds', completed: 0, total: fixed.seedPmids.length } : null;
    notify();
    const evaluation = await evaluateQuery(formula, fixed.seedPmids, { eutils });
    boundary();
    if (task && evaluation.finalQuery.status === 'success') task = { ...task, completed: fixed.seedPmids.length };
    if (evaluation.status === 'failure') apiEvent('failure');
    notify();
    const measurement: OptimizationMeasurement = {
      id: `${fixed.runId}:${candidateId}`, fingerprint: evaluation.fingerprint,
      measuredAt: evaluation.measuredAt, totalHits: evaluation.finalQuery.totalHits,
      capturedPmids: evaluation.finalQuery.capturedPmids, missedPmids: evaluation.finalQuery.missedPmids,
      blocks: evaluation.lineHits.map((line) => ({ id: line.blockId, hits: line.hitCount, error: line.error })),
    };
    return { formula, evaluation, measurement };
  };
  async function finish(reason: OptimizationStopReason,
    latestMeasurement: OptimizationMeasurement | undefined = best?.measurement): Promise<QueryOptimizationResult> {
    terminal = reason;
    const unmetReasons: string[] = [];
    if (!best) unmetReasons.push('検証済み候補がありません');
    if (fixed.seedPmids.length === 0) unmetReasons.push('シードが未指定です');
    // 最良候補は保持し、最終再検証で崩れた値だけを未達理由の根拠に切り替える。
    if (latestMeasurement?.missedPmids?.length) unmetReasons.push(`未捕捉シード: ${latestMeasurement.missedPmids.join(', ')}`);
    if (latestMeasurement?.totalHits != null && latestMeasurement.totalHits > fixed.maxHits) {
      unmetReasons.push(`最大件数 ${fixed.maxHits} 件を超えています（実測 ${latestMeasurement.totalHits} 件）`);
    }
    if (reason !== 'conditions_met') unmetReasons.push(`終了理由: ${reason}`);
    const result: QueryOptimizationResult = {
      status: reason === 'conditions_met' ? 'achieved' : reason === 'user_stop' ? 'stopped'
        : reason === 'api_error' || reason === 'invalid_input' ? 'error' : 'needs_review',
      stopReason: reason, best, trials, unmetReasons, iterations, apiCalls, elapsedMs: now() - startedAt,
    };
    // 終了後に残すのは確定した終了記録だけ。停止境界を通さず、候補・測定は更新しない。
    // まだ試行を記録していない run は、既存の別 run のチェックポイントに触れない。
    if (trials.length > 0) {
      try {
        await saveQueryOptimizationCheckpoint(fixed.projectId, fixed.runId, fixed.maxHits,
          trials, deps.checkpoint, () => new Date(now()).toISOString(), {
            status: result.status, stopReason: result.stopReason, unmetReasons: result.unmetReasons,
          });
      } catch (err) {
        result.unmetReasons.push(`終了記録の保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    step = 'review';
    task = null;
    apiWaiting = null;
    notify();
    return result;
  }
  const meetsTarget = (candidate: VerifiedOptimizationCandidate) =>
    fixed.seedPmids.length > 0 && candidate.evaluation.status === 'success'
      && candidate.measurement.missedPmids?.length === 0 && candidate.measurement.totalHits! <= fixed.maxHits;

  try {
    boundary();
    const error = validateInput(fixed, maxIterations, maxApiCalls, maxElapsedMs);
    if (error) {
      const result = await finish('invalid_input');
      result.unmetReasons.push(error);
      return result;
    }
    notifyMeshContext();
    notify();
    const initial = await measure(fixed.initialFormula, 'initial');
    trials.push(makeTrial({ kind: 'initial', candidateId: 'initial', formula: initial.formula,
      before: null, after: initial.measurement, accepted: initial.evaluation.status === 'success',
      reason: '初期式の実測', rationale: '' }));
    if (initial.evaluation.status === 'success') best = initial;
    seen.add(initial.evaluation.fingerprint);
    await save();
    if (!best) return finish('api_error');
    let noImprovement = 0;
    let measurementFailures = 0;
    let reason: OptimizationStopReason = 'iteration_limit';
    for (let round = 1; round <= maxIterations; round += 1) {
      boundary();
      apiEvents = [];
      step = 'adjusting';
      notify();
      // 初回と採用後だけ語を測る。同じ最良式の却下後は取得済み文脈を共有する。
      if (!best.measurement.terms) {
        const terms = await measureTerms(best.formula, fixed.approvedBlocks, {
          eutils, check: boundary,
          onProgress: (completed, total) => { task = { kind: 'terms', completed, total }; notify(); },
          finalHits: deps.measureTermDetails ? best.measurement.totalHits : undefined,
          onFailure: () => apiEvent('failure'),
        });
        boundary();
        // 記録済み試行が参照する測定は不変とし、AI 文脈を付加した新しい測定へ差し替える。
        best = { ...best, measurement: { ...best.measurement, terms } };
      }
      task = null;
      notify();
      boundary();
      const provider = deps.onProgress ? deps.llmFactory.forPurpose('optimize_query', (state) => {
        if (state === 'idle') { apiWaiting = null; notify(); return; }
        apiSource = 'AI';
        apiEvent(state);
        apiSource = 'PubMed';
      }) : deps.llmFactory.forPurpose('optimize_query');
      apiCalls += 1;
      const proposal = await optimizeQuery({
        formula: best.formula, approvedBlocks: fixed.approvedBlocks, criteria: fixed.criteria,
        maxHits: fixed.maxHits, measurement: best.measurement,
        seedPapers: fixed.seedPapers ?? fixed.seedPmids.map((pmid) => ({ pmid, title: null })),
        meshContext, meshRequestResults, trials,
      }, provider);
      boundary();
      iterations = round;
      const candidateId = `candidate-${round}`;
      if (proposal.meshRequests.length > 0) {
        // 情報要求だけの回は候補評価を保留する。同一式回帰とせず、未達なら次の AI が取得結果を読む。
        // この回も反復上限に数え、情報要求だけが続いても無限に継続しない。
        const note = await expandMesh(proposal.meshRequests, round < maxIterations);
        trials.push(makeTrial({ kind: 'information', candidateId, formula: best.formula,
          before: best.measurement, after: null, accepted: false, reason: note, rationale: proposal.rationale,
          meshRequests: proposal.meshRequests.map((request) => ({ ...request })) }));
        await save();
      } else {
        evaluatedTrials += 1;
        const details = {
          kind: 'proposal' as const,
          changes: { targetBlockId: proposal.targetBlockId, addedTerms: [...proposal.addedTerms],
            removedTerms: [...proposal.removedTerms], replacedTerms: proposal.replacedTerms.map((term) => ({ ...term })) },
        };
        const candidate = applyProposal(best.formula, proposal);
        const invalid = validateOptimizationCandidate(fixed.initialFormula, candidate, fixed.approvedBlocks, proposal);
        if (invalid) {
          trials.push(makeTrial({ ...details, candidateId, formula: candidate, before: best.measurement,
            after: null, accepted: false, reason: invalid, rationale: proposal.rationale }));
          noImprovement += 1;
          await save();
        } else {
          boundary();
          step = 'measuring';
          notify();
          const measured = await measure(candidate, candidateId);
          if (deps.measureTermDetails && measured.evaluation.status === 'success') {
            try {
              measured.measurement = { ...measured.measurement, terms: await measureTerms(candidate, fixed.approvedBlocks, {
                eutils, check: boundary,
                onProgress: (completed, total) => { task = { kind: 'terms', completed, total }; notify(); },
                finalHits: measured.measurement.totalHits, onFailure: () => apiEvent('failure'),
              }) };
            } catch (err) {
              if (err instanceof QueryOptimizationStopError) throw err;
              // 詳細だけの取得失敗で、既に実測した候補や採否を失わない。
              apiEvent('failure');
            }
            boundary();
          }
          const failed = measured.evaluation.status === 'failure';
          measurementFailures = failed ? measurementFailures + 1 : 0;
          // 失敗測定は回帰判定の根拠にしない。次の候補で再び測定する機会を残す。
          const repeated = !failed && seen.has(measured.evaluation.fingerprint);
          if (!failed) seen.add(measured.evaluation.fingerprint);
          const before = best.measurement;
          const lostSeeds = before.capturedPmids!.filter((pmid) => !measured.measurement.capturedPmids?.includes(pmid));
          const improved = measured.evaluation.status === 'success' && lostSeeds.length === 0
            && isImprovement(before, measured.measurement, fixed.maxHits);
          const rejection = failed ? describeMeasurementFailure(measured.evaluation)
            : lostSeeds.length > 0 ? `捕捉済みシードを失う: ${lostSeeds.join(', ')}`
              : repeated ? '評価済みの同一式への回帰' : '局面の指標に改善がありません';
          trials.push(makeTrial({ ...details, candidateId, formula: candidate, before, after: measured.measurement,
            accepted: improved && !repeated, reason: improved && !repeated ? '局面の指標が改善しました' : rejection,
            rationale: proposal.rationale }));
          if (improved && !repeated) best = measured;
          noImprovement = improved && !repeated ? 0 : noImprovement + 1;
          await save();
          if (measurementFailures >= MAX_CONSECUTIVE_MEASUREMENT_FAILURES) return finish('api_error');
          if (repeated) reason = 'repeated_formula';
        }
      }
      boundary();
      // 条件達成時の最終測定は候補反復の一部。反復上限を終了状態へ確定する前に行う。
      if (meetsTarget(best)) {
        const invalidFinal = validateOptimizationCandidate(fixed.initialFormula, best.formula, fixed.approvedBlocks);
        if (invalidFinal) return finish('revalidation_failed');
        step = 'revalidating';
        apiEvents = [];
        notify();
        const verified = await measure(best.formula, `final-${round}`);
        const achieved = meetsTarget(verified);
        trials.push(makeTrial({ kind: 'final', candidateId: `final-${round}`, formula: best.formula,
          before: best.measurement, after: verified.measurement, accepted: achieved,
          reason: achieved ? '最終再検証で条件達成' : '最終再検証で条件未達', rationale: '' }));
        if (achieved) best = verified;
        await save();
        if (verified.evaluation.status === 'failure') return finish('api_error', verified.measurement);
        return finish(achieved ? 'conditions_met' : 'revalidation_failed', verified.measurement);
      }
      if (reason === 'repeated_formula') return finish(reason);
      if (noImprovement >= 2) return finish('no_improvement');
    }
    return finish(reason);
  } catch (err) {
    let failure = err;
    if (failure instanceof QueryOptimizationStopError) terminal = failure.stopReason;
    // 測定層に例外が変換された場合や、通信失敗と停止が重なった場合も境界で再判定する。
    try { boundary(); } catch (stopped) {
      if (stopped instanceof QueryOptimizationStopError) {
        terminal = stopped.stopReason;
        failure = stopped;
      }
    }
    const result = await finish(terminal ?? 'api_error');
    result.unmetReasons.push(failure instanceof Error ? failure.message : String(failure));
    return result;
  }
}

function describeMeasurementFailure(evaluation: QueryEvaluation): string {
  const errors = evaluation.lineHits.flatMap((line) => line.status === 'failure' ? [line.error] : []);
  if (evaluation.finalQuery.status === 'failure') errors.push(evaluation.finalQuery.error);
  return `候補の測定に失敗したため却下しました: ${[...new Set(errors)].join(' / ')}`;
}

function copyMeshNode(node: OptimizationMeshNode): OptimizationMeshNode {
  return {
    id: node.id, descriptor: node.descriptor, label: node.label, explode: node.explode, note: node.note,
    treeNumbers: [...node.treeNumbers], parentIds: [...node.parentIds], childIds: [...node.childIds],
  };
}

/** 未捕捉時は捕捉数増加だけ、全件捕捉後は上限超過分の減少だけを改善とする。 */
function isImprovement(before: OptimizationMeasurement, after: OptimizationMeasurement, maxHits: number): boolean {
  if (before.missedPmids!.length > 0) return after.capturedPmids!.length > before.capturedPmids!.length;
  return Math.max(0, after.totalHits! - maxHits) < Math.max(0, before.totalHits! - maxHits);
}

type TrialInput = Omit<OptimizationTrial, 'kind' | 'changes' | 'meshRequests' | 'apiEvents'> & (
  | { kind: 'initial' | 'final' }
  | { kind: 'proposal'; changes: NonNullable<OptimizationTrial['changes']> }
  | { kind: 'information'; meshRequests: OptimizationMeshRequest[] }
);

function makeTrial(input: TrialInput): OptimizationTrial {
  return { ...input, apiEvents: [] };
}

function applyProposal(formula: PubmedFormula, proposal: OptimizeQueryProposal): PubmedFormula {
  return {
    blocks: formula.blocks.map((block) => ({ ...block,
      expression: block.id === proposal.targetBlockId ? proposal.proposedExpression : block.expression })),
    combinationExpression: formula.combinationExpression,
  };
}

function validateInput(input: QueryOptimizationInput, iterations: number, calls: number, elapsed: number): string | null {
  if (![input.maxHits, iterations, calls, elapsed].every((value) => Number.isSafeInteger(value) && value > 0)) {
    return '件数・反復・通信・時間の上限は正の整数で指定してください';
  }
  if (input.maxHits < input.seedPmids.length) return '最大件数がシード数より少なく、条件を両立できません';
  if (input.approvedBlocks.length === 0 || new Set(input.approvedBlocks.map((block) => block.id)).size !== input.approvedBlocks.length
    || input.approvedBlocks.some((approved) => !input.initialFormula.blocks.some((block) => block.id === approved.id && !block.isCombination))) {
    return '承認済みブロックの対応が不正です';
  }
  return validateOptimizationCandidate(input.initialFormula, input.initialFormula, input.approvedBlocks);
}

/** AI の操作は単一概念行の差替えに限定し、既存パーサで参照・結合構文を検査する。 */
export function validateOptimizationCandidate(initial: PubmedFormula, candidate: PubmedFormula,
  approved: ApprovedOptimizationBlock[], proposal?: OptimizeQueryProposal): string | null {
  if (proposal && !approved.some((block) => block.id === proposal.targetBlockId)) return '承認済みブロック ID 以外は変更できません（結合行・フィルタを保護）';
  const ids = new Set(candidate.blocks.map((block) => block.id));
  if (ids.size !== candidate.blocks.length || candidate.blocks.length === 0
    || candidate.blocks.map((block) => block.id).join(',') !== initial.blocks.map((block) => block.id).join(',')) return 'ブロック ID の変更・増減・重複は禁止です';
  if (candidate.combinationExpression !== initial.combinationExpression) return '承認済み結合構造を変更できません';
  for (const block of candidate.blocks) {
    if (!block.expression.trim() || /[\r\n]/.test(block.expression)) return '式は空でない単一行で指定してください';
    const original = initial.blocks.find((item) => item.id === block.id)!;
    if (block.isCombination !== original.isCombination
      || ((original.isCombination || !approved.some((item) => item.id === block.id)) && original.expression !== block.expression)) return '結合構造・研究デザインフィルタは変更できません';
    const known = new Set([...ids].filter((id) => id !== block.id));
    const refs = extractBlockReferences(block.expression, block.id, ids);
    if (block.isCombination || block.expression.includes('#')) {
      const parsed = validateCombinationExpression(block.expression, known);
      const referenceErrors = validateReferences(parsed.tokens, known);
      if (parsed.errors.length || referenceErrors.length) return '結合構文またはブロック参照が不正です';
      if (wouldCreateReferenceCycle(candidate, block.id, block.expression)) return '循環参照は禁止です';
      if (!block.isCombination || refs.length === 0) return '概念ブロックへの参照追加は禁止です';
    } else if (proposal?.targetBlockId === block.id) {
      // 既存の語分解でタグ付き語を仮の参照へ置き換え、既存の結合文法で括弧・演算子を検査する。
      // タグなしの自由文は自動変更の許可範囲外とし、自前の PubMed パーサは持たない。
      const operands = new Set<string>();
      const syntax = tokenizeExpression(block.expression).map((segment) => {
        if (segment.kind === 'plain') return segment.text;
        const id = `term${operands.size}`;
        operands.add(id);
        return `#${id}`;
      }).join('');
      if (validateCombinationExpression(normalizeConceptNotForValidation(syntax), operands).errors.length) return '検索語のタグ・括弧・演算子が不正、または自動変更の許可範囲外です';
    }
  }
  const combination = candidate.blocks.filter((block) => block.isCombination).pop()?.expression ?? null;
  if (combination !== candidate.combinationExpression) return '最終結合行と結合構造が一致しません';
  if (findUnreachableBlockIds(candidate).length) return '最終式から到達できないブロックがあります';
  return null;
}

/** 検査用の仮参照列だけ、被演算子直後の NOT を AND NOT にする。候補原文は変更しない。 */
function normalizeConceptNotForValidation(syntax: string): string {
  const { tokens, errors } = tokenizeCombination(syntax);
  if (errors.length > 0) return syntax;
  return tokens.map((token, index) => {
    const previous = tokens[index - 1];
    return token.kind === 'op' && token.op === 'NOT' && (previous?.kind === 'ref' || previous?.kind === 'rparen')
      ? `AND ${token.raw}` : token.raw;
  }).join(' ');
}

interface MeasureTermsOptions {
  eutils: EutilsDeps;
  check: () => void;
  onProgress?: (completed: number, total: number) => void;
  finalHits?: number | null;
  onFailure?: () => void;
}

/** 原タグを保持した単独件数と累積 OR の純増。最終式の固有寄与と混同しない。 */
async function measureTerms(formula: PubmedFormula, approvedBlocks: readonly ApprovedOptimizationBlock[],
  { eutils, check, onProgress, finalHits, onFailure }: MeasureTermsOptions): Promise<NonNullable<OptimizationMeasurement['terms']>> {
  const terms: NonNullable<OptimizationMeasurement['terms']> = [];
  const cache = new Map<string, number>();
  const count = async (query: string) => {
    check();
    const cached = cache.get(query);
    if (cached !== undefined) return cached;
    try {
      const value = (await esearch(query, eutils, { retmax: 0 })).count;
      cache.set(query, value);
      return value;
    } catch (err) {
      check();
      onFailure?.();
      throw err;
    }
  };
  const approvedIds = new Set(approvedBlocks.map((block) => block.id));
  const blocks = formula.blocks.filter((item) => !item.isCombination && approvedIds.has(item.id));
  const total = blocks.reduce((sum, block) => sum + new Set(extractBlockTerms(block.expression).freewordTerms
    .map((term) => term.query.trim()).filter(Boolean)).size
    + tokenizeExpression(block.expression).filter((item) => item.kind === 'mesh').length, 0);
  onProgress?.(0, total);
  for (const block of blocks) {
    check();
    const segments = tokenizeExpression(block.expression);
    const orOnly = segments.every((segment) => segment.kind !== 'plain'
      || /^[\s()]*$/.test(segment.text.replace(/\bOR\b/gi, '')));
    const freewords = extractBlockTerms(block.expression).freewordTerms;
    const delta = await analyzeFreewordDelta(freewords, count);
    // 部分失敗・逆転のクランプは Δ=0 の実測ではない。以降の累積差分も不確かとして捨てる。
    let uncertain = false;
    for (const row of delta.rows) {
      uncertain = uncertain || row.clamped || row.individualError;
      let finalContribution: number | null = null;
      if (finalHits != null && !row.individualError && orOnly) {
        // OR の概念ブロック内の該当語を偽の式に置換し、最終式から失う論文を直接数える。
        // AND / NOT を含む概念行は語の除去規則が異なるため未測定に留める。
        const without: PubmedFormula = { ...formula, blocks: formula.blocks.map((item) => item.id !== block.id ? item : {
          ...item, expression: tokenizeExpression(item.expression).map((segment) => segment.kind === 'freeword'
            && segment.text.trim() === row.query ? `(${segment.text} NOT ${segment.text})` : segment.text).join(''),
        }) };
        try {
          const value = await count(`(${expandFormula(formula)}) NOT (${expandFormula(without)})`);
          if (value <= finalHits) finalContribution = value;
        } catch {
          check();
        }
      }
      terms.push({ blockId: block.id, query: row.query, hits: row.individualError ? null : row.individual,
        delta: uncertain ? null : row.delta,
        ...(finalHits !== undefined ? { finalContribution } : {}) });
      onProgress?.(terms.length, total);
    }
    for (const segment of tokenizeExpression(block.expression).filter((item) => item.kind === 'mesh')) {
      const hits = await count(segment.text);
      terms.push({ blockId: block.id, query: segment.text, hits, delta: null });
      onProgress?.(terms.length, total);
    }
  }
  return terms;
}
