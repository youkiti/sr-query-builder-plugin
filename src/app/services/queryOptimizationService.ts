import { waitWithSignal } from '@/utils/abort';
import { annotateLostSample, type AnnotateLostSampleInput } from '@/features/formula/skills/annotateLostSample';
import {
  optimizeQuery,
  type ApprovedOptimizationBlock,
  type OptimizationCriteria,
  type OptimizationMeasurement,
  type OptimizationSeedCapture,
  type OptimizationMissedSeed,
  type OptimizationSeedDiagnosis,
  type OptimizationMeshNode,
  type OptimizationMeshRequest,
  type OptimizationMeshRequestResult,
  type OptimizationTrial,
  type OptimizationImpact,
  type OptimizationApiEvent,
  type OptimizeQueryProposal,
  type PreviousOptimizationRejection,
} from '@/features/formula/skills/optimizeQuery';
import type { ProjectStoreDeps } from '@/features/project';
import { fetchMeshTreeNumbers } from '@/lib/ncbi/mesh';
import { diagnoseStructure, diagnosisTargets, meshOccurrences, queryWithoutBlock, diagnoseNarrowing, MAX_DIAGNOSIS_API_CALLS, DIAGNOSIS_LIMIT_NOTE, DIAGNOSIS_CHANGED_NOTE, type BlockDiagnosis } from '@/features/validation/blockDiagnosis';
import { diagnosedHeldBlock } from './queryOptimizationDiagnosis';
import { extractBlockTerms } from '@/features/validation/blockTerms';
import { analyzeFreewordDelta } from '@/features/validation/freewordDelta';
import { expandFormula } from '@/features/validation/expandFormula';
import { tokenizeExpression } from '@/lib/search-formula-md/expression';
import {
  extractBlockReferences, findUnreachableBlockIds, wouldCreateReferenceCycle,
} from '@/lib/search-formula-md/references';
import { tokenizeCombination, validateCombinationExpression, validateReferences } from '@/lib/combination-expression';
import type { PubmedFormula } from '@/lib/search-formula-md';
import { esearch, efetchArticles, type EutilsDeps } from '@/lib/ncbi';
import { resolveRateLimiter } from '@/lib/ncbi/eutils';
import type { LlmProviderFactory } from './llmProviderService';
import { formulaFingerprint, evaluateQuery, type QueryEvaluation } from './queryEvaluationService';
import { saveQueryOptimizationCheckpoint, type OptimizationBudget } from './queryOptimizationCheckpointService';
import { HELD_CANDIDATE_ADOPTION_LOST_HITS_THRESHOLD } from './queryOptimizationReviewSections';

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
  /** 固定した研究基準・承認ブロック・シード集合・目安件数の指標。 */
  inputIdentity?: string;
  previousRejectedTrials?: PreviousOptimizationRejection[];
  resumeBudget?: { limits: OptimizationBudget; consumed: OptimizationBudget; runId: string };
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
  /** 最良候補の式の外側から判定候補を取得する。 */
  | 'outside_check'
  /** 処理が終了し、人によるレビューへ渡す段階。 */
  | 'review';

export interface QueryOptimizationProgress {
  blockDiagnosis?: BlockDiagnosis;
  /** 情報要求と通信リトライを含まない、修正案の評価数。 */
  evaluatedTrials?: number;
  /** 候補評価とは別に数える、情報要求の回数。 */
  informationTrials?: number;
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
  fetchMeshTreeNumbers?: typeof fetchMeshTreeNumbers;
  /**
   * 詳細表示用の追加計測。単独件数・累積 OR は run 共通のクエリキャッシュを使う。
   * 全概念行が OR の初回は 3F − B + M 回（F: フリーワード数、B: そのブロック数、M: MeSH 数）。
   * 語別計測全体を run あたり最大 100 HTTP に制限し、候補の実測・最終再検証の予算を残す。
   * 上限後の未取得値は null。固有寄与は最終式を含むクエリで区別する。
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
  random?: () => number;
  maxApiCalls?: number;
  maxElapsedMs?: number;
  ncbiRequestTimeoutMs?: number;
  llmRequestTimeoutMs?: number;
}

export interface VerifiedOptimizationCandidate {
  formula: PubmedFormula;
  evaluation: QueryEvaluation;
  measurement: OptimizationMeasurement;
}

export type OptimizationStopReason =
  | 'conditions_met' | 'iteration_limit' | 'repeated_formula' | 'no_improvement'
  | 'request_timeout' | 'user_stop' | 'api_error' | 'api_budget' | 'time_budget' | 'invalid_input'
  | 'revalidation_failed' | 'diagnosed_block_held' | 'seed_capture_stalled' | 'held_candidates_collected';

/** NCBI の失敗とは区別する、反復サービスの制御用例外。 */
export class QueryOptimizationStopError extends Error {
  constructor(readonly stopReason: OptimizationStopReason) {
    const messages: Record<OptimizationStopReason, string> = {
      conditions_met: '目安件数と既知シードの捕捉を満たしたため終了しました。',
      iteration_limit: '反復回数の上限に達したため終了しました。',
      diagnosed_block_held: '診断したブロックを狭める案が、既に捕捉している文献を失うため連続して保留になり、終了しました。',
      repeated_formula: '評価済みの同じ式に戻ったため終了しました。',
      no_improvement: '採用できる変更も、人に判断を求める保留候補も得られない回が 2 回続いたため終了しました。',
      held_candidates_collected: `実測で失う集合のある保留候補が ${MAX_HELD_CANDIDATES} 件そろったため終了しました。自動調整は既に捕捉している文献を失う変更を自動採用しないため、保留候補を最終レビューで判定してください。`,
      seed_capture_stalled: 'ブロックの捕捉を増やす中間手を承認済みブロック数と同じ回数続けて採用しましたが、最終式の捕捉数が増えなかったため終了しました。',
      user_stop: 'ユーザーの停止要求により処理を停止しました。',
      api_error: 'API エラーにより処理を続けられません。',
      api_budget: '通信回数の予算上限に達したため処理を停止しました。',
      request_timeout: '通信の応答待ち時間の上限に達したため処理を停止しました。',
      time_budget: '実行時間の予算上限に達したため処理を停止しました。',
      invalid_input: '入力が不正なため処理を開始できません。',
      revalidation_failed: '最終再検証で条件を満たさなかったため終了しました。',
    };
    super(messages[stopReason]);
    this.name = 'QueryOptimizationStopError';
  }
}

export interface QueryOptimizationResult {
  blockDiagnosis?: BlockDiagnosis;
  /** 情報要求の回数。旧形式の結果との互換性のため省略可。 */
  informationTrials?: number;
  /** 旧形式の結果との互換性のため省略可。新しい run は必ず配列を返す。 */
  seedDiagnoses?: OptimizationSeedDiagnosis[];
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
// NCBI と optimize_query / annotate_lost_sample の実送信（リトライ含む）を数え、監査ログ通信は除く。
export const DEFAULT_MAX_ITERATIONS = 5;
export const MAX_HELD_CANDIDATES = 3;
export const DEFAULT_MAX_API_CALLS = 200;
export const MAX_TERM_API_CALLS = 100;
// 保存回数を約1/10に抑えつつ、中断時に払い戻されうる通信を最大9回に留める。
const CHECKPOINT_API_CALL_INTERVAL = 10;
// 先頭 N 件の書誌は確認対象の提示であって、集合全体を安全と判断する根拠にしない。
const INSPECT_LIMIT = 20;

/** 追加分析の予算切れは、候補評価全体を停止する理由にはしない。 */
class TermAnalysisBudgetError extends Error {}
export const DEFAULT_MAX_ELAPSED_MS = 10 * 60 * 1000;
// NCBI の取得には 1 分、生成待ちを伴う LLM には 2 分を許容する。
export const DEFAULT_NCBI_REQUEST_TIMEOUT_MS = 60 * 1000;
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120 * 1000;
const STOP_POLL_INTERVAL_MS = 100;
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
    inputIdentity: input.inputIdentity,
    previousRejectedTrials: input.previousRejectedTrials
      ? JSON.parse(JSON.stringify(input.previousRejectedTrials)) as PreviousOptimizationRejection[] : [],
    resumeBudget: input.resumeBudget ? { runId: input.resumeBudget.runId,
      limits: { ...input.resumeBudget.limits }, consumed: { ...input.resumeBudget.consumed } } : undefined,
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
  const consumedBefore = fixed.resumeBudget?.consumed ?? { apiCalls: 0, elapsedMs: 0, evaluatedTrials: 0 };
  const limits = fixed.resumeBudget?.limits ?? { apiCalls: maxApiCalls, elapsedMs: maxElapsedMs, evaluatedTrials: maxIterations };
  let blockDiagnosis: BlockDiagnosis | undefined;
  let diagnosedHeldId: string | null = null;
  let diagnosisApiCalls = 0;
  const diagnosisTrees = new Map<string, string[]>();
  const diagnosisTreeReasons = new Map<string, string>();
  const diagnosisCounts = new Map<string, number>();
  let apiCalls = 0;
  let lastSavedApiCalls = 0;
  let progressSave: Promise<void> | undefined;
  let termApiCalls = 0;
  let termBudgetExhausted = false;
  let termBudgetReserved = false;
  let reservedApiCalls = 0;
  const termCache = new Map<string, number>();
  let iterations = 0;
  let evaluatedTrials = 0;
  let informationTrials = 0;
  let pendingInformation: OptimizationTrial['informedBy'];
  let task: QueryOptimizationProgress['task'] = null;
  let apiWaiting: OptimizationApiEvent | null = null;
  let apiEvents: OptimizationApiEvent[] = [];
  let apiSource: OptimizationApiEvent['source'] = 'PubMed';
  let best: VerifiedOptimizationCandidate | null = null;
  let missedSeeds: OptimizationMissedSeed[] = [];
  let checkpointWritten = false;
  const trials: OptimizationTrial[] = [];
  let step: QueryOptimizationStep = 'measuring';
  const notify = (trial: OptimizationTrial | null = null): void => {
    if (!deps.onProgress) return;
    try {
      deps.onProgress({ step, iterations,
        blockDiagnosis: blockDiagnosis ? JSON.parse(JSON.stringify(blockDiagnosis)) as BlockDiagnosis : undefined,
        evaluatedTrials, informationTrials, task: task ? { ...task } : null,
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
  const seen = new Map<string, string>();
  let terminal: OptimizationStopReason | null = null;
  const runController = new AbortController();
  let llmSignal: AbortSignal | undefined;
  const ncbiRequestTimeoutMs = deps.ncbiRequestTimeoutMs ?? DEFAULT_NCBI_REQUEST_TIMEOUT_MS;

  // 一度停止したら callback が false に戻っても再開しない。応答の前後で同じ境界を使う。
  // 通信予算を使い切る最後の応答も破棄する。上限到達後の結果更新を許さないため。
  function boundary(checkApiBudget = true): void {
    if (!terminal && deps.shouldStop?.()) terminal = 'user_stop';
    if (!terminal && now() - startedAt >= maxElapsedMs) terminal = 'time_budget';
    if (!terminal && checkApiBudget && apiCalls >= maxApiCalls) terminal = 'api_budget';
    if (terminal) {
      const error = new QueryOptimizationStopError(terminal);
      runController.abort(error);
      throw error;
    }
  }
  // 注入した待機や遅い応答にも停止を伝える。通信固有の期限切れは呼び出し元で扱う。
  async function abortable<T>(work: Promise<T>, signal = runController.signal): Promise<T> {
    try { return await waitWithSignal(work, signal); }
    catch (err) {
      if (signal.aborted) {
        boundary(false);
        if (signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError') {
          throw new DOMException(`NCBI の応答が ${ncbiRequestTimeoutMs / 1000} 秒以内に返りませんでした`, 'TimeoutError');
        }
      }
      throw err;
    }
  }
  function requestSignal(timeoutMs: number): AbortSignal {
    return AbortSignal.any([runController.signal, AbortSignal.timeout(timeoutMs)]);
  }
  async function sleep(ms: number): Promise<void> {
    boundary(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await abortable(deps.eutils.sleep ? deps.eutils.sleep(ms)
        : new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }));
      boundary(false);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  const fetchWithDeadline: EutilsDeps['fetch'] = async (resource, init) => {
    boundary(false);
    const signal = requestSignal(ncbiRequestTimeoutMs);
    const response = await abortable(deps.eutils.fetch(resource, { ...init, cache: 'no-store', signal }), signal);
    boundary();
    // fetch 完了後も同じ期限を本文の読み取りまで使う。
    return new Proxy(response, {
      get(target, key) {
        if (key === 'json' || key === 'text') return () => abortable(target[key](), signal);
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const rateLimiter = resolveRateLimiter(deps.eutils);
  const eutils: EutilsDeps = {
    ...deps.eutils,
    strictCounts: true,
    rateLimiter: {
      acquire: async () => {
        boundary();
        await abortable(deps.onProgress ? rateLimiter.acquire(() => apiEvent('rate_limit')) : rateLimiter.acquire());
        apiWaiting = null;
        notify();
        boundary();
      },
    },
    // バックオフ待機中にも run の停止を伝える。
    sleep: async (ms) => {
      boundary();
      apiEvent('retry');
      await sleep(ms);
      apiWaiting = null;
      notify();
      boundary();
    },
    fetch: async (resource, init) => {
      boundary();
      apiCalls += 1;
      await persistProgress();
      // この通信の予算は加算前に確認済み。保存待ち中の停止・時間切れは引き続き確認する。
      boundary(false);
      return fetchWithDeadline(resource, init);
    },
  };
  const canMeasureTerm = (): boolean => {
    if (termApiCalls >= MAX_TERM_API_CALLS) {
      termBudgetExhausted = true;
      return false;
    }
    if (maxApiCalls - apiCalls <= reservedApiCalls) {
      termBudgetReserved = true;
      return false;
    }
    return true;
  };
  const termEutils: EutilsDeps = { ...eutils, fetch: async (resource, init) => {
    if (!canMeasureTerm()) throw new TermAnalysisBudgetError('語別計測の通信予算');
    termApiCalls += 1;
    return eutils.fetch(resource, init);
  } };
  const termOptions = {
    eutils: termEutils, cache: termCache, check: boundary,
    canMeasure: canMeasureTerm,
    onProgress: (completed: number, total: number) => { task = { kind: 'terms', completed, total }; notify(); },
    onFailure: () => apiEvent('failure'),
  };
  // MeSH 取得は外側で一単位に数える。内部通信にも同じ期限を適用する。
  const meshEutils: EutilsDeps = {
    ...deps.eutils,
    fetch: fetchWithDeadline,
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
    let obtained = 0;
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
        await persistProgress();
        boundary(false);
        try {
          apiSource = 'MeSH';
          const nodes = await abortable(deps.fetchMeshContext({ ...request }, meshEutils));
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
          if (nodes.length > 0) {
            obtained += 1;
          }
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
    return { requested: requests.length, obtained,
      notes: results.map(({ request, note }) => `${request.descriptor || '(未指定)'} / ${request.treeNumber || '(未指定)'}: ${note}`).join('\n') };
  };
  const save = async () => {
    const latest = trials[trials.length - 1];
    if (latest) latest.apiEvents = apiEvents.map((event) => ({ ...event }));
    task = null;
    notify(trials[trials.length - 1] ?? null);
    boundary();
    await saveQueryOptimizationCheckpoint(checkpointOptions(), deps.checkpoint);
    lastSavedApiCalls = apiCalls;
    checkpointWritten = true;
    boundary();
  };
  async function persistProgress(): Promise<void> {
    // 保存待ちの間も通信を進めると、未記録の通信が間隔の上限を超える。
    // 初回の未検証式しかない通常 run は、初期評価が終わるまで復元対象にしない。
    if (!best && !fixed.resumeBudget) return;
    if (apiCalls - lastSavedApiCalls < CHECKPOINT_API_CALL_INTERVAL) return progressSave;
    const options = checkpointOptions();
    // 判定と更新を await 前に済ませ、並行通信の重複保存を防ぐ。
    // 保存失敗は呼び出し側へ伝え、基準は戻さない。次の保存が最大9通信遅れるだけで、累積消費量は変えない。
    lastSavedApiCalls = apiCalls;
    const saving = saveQueryOptimizationCheckpoint(options, deps.checkpoint)
      .then(() => { checkpointWritten = true; })
      .finally(() => { if (progressSave === saving) progressSave = undefined; });
    progressSave = saving;
    await saving;
  }
  function checkpointOptions() {
    return { projectId: fixed.projectId, runId: fixed.runId, maxHits: fixed.maxHits, trials, blockDiagnosis,
      now: () => new Date(now()).toISOString(),
      resume: { bestFormula: best?.formula ?? (fixed.resumeBudget ? fixed.initialFormula : null),
        inputIdentity: fixed.inputIdentity ?? '', limits,
        consumed: { apiCalls: consumedBefore.apiCalls + apiCalls,
          elapsedMs: consumedBefore.elapsedMs + Math.max(0, now() - startedAt),
          evaluatedTrials: consumedBefore.evaluatedTrials + evaluatedTrials },
        previousRejectedTrials: fixed.previousRejectedTrials ?? [],
        ...(fixed.resumeBudget ? { resumedFromRunId: fixed.resumeBudget.runId } : {}),
      },
    };
  }
  async function updateDiagnosis(candidate: VerifiedOptimizationCandidate): Promise<void> {
    const changed = blockDiagnosis !== undefined;
    const { formula, measurement } = candidate;
    const { simple, refs, blocks } = diagnosisTargets(formula, fixed.approvedBlocks);
    const mergeTrees = (descriptor: string, treeNumbers: readonly string[]) => {
      const key = descriptor.toLowerCase();
      diagnosisTrees.set(key, [...new Set([...(diagnosisTrees.get(key) ?? []), ...treeNumbers])]);
    };
    for (const node of meshContext ?? []) mergeTrees(node.descriptor, node.treeNumbers);
    const budgetNote = () => diagnosisApiCalls >= MAX_DIAGNOSIS_API_CALLS ? DIAGNOSIS_LIMIT_NOTE
      : maxApiCalls - apiCalls <= reservedApiCalls ? '未判定: 候補評価・差集合・最終再検証の通信予算を確保するため打ち切った' : '';
    const observed: EutilsDeps = { ...eutils, maxRetries: 0, fetch: async (resource, init) => {
      boundary();
      const note = budgetNote();
      if (note) throw new Error(note);
      diagnosisApiCalls += 1;
      return eutils.fetch(resource, init);
    } };
    // 更新途中で停止しても、以前の式の件数を最新として保存しない。
    blockDiagnosis = { fingerprint: measurement.fingerprint,
      ...diagnoseStructure(formula, fixed.approvedBlocks, diagnosisTrees, diagnosisTreeReasons),
      narrowing: blocks.map((block) => diagnoseNarrowing(block, measurement.totalHits, null,
        changed ? DIAGNOSIS_CHANGED_NOTE : '未判定: 未測定')) };
    notify();
    boundary();
    if (!simple) return;
    for (const [index, block] of blocks.entries()) {
      boundary();
      const query = queryWithoutBlock(formula, refs, block.id);
      let hits: number | null = null;
      let note = measurement.totalHits === null ? '未判定: 最終式の件数が不明'
        : query === null ? '未判定: 対象ブロックを外すと参照が残らない' : '';
      if (!note && query !== null) {
        hits = diagnosisCounts.get(query) ?? null;
        if (hits === null) {
          note = budgetNote();
          if (note && changed) note = `${DIAGNOSIS_CHANGED_NOTE}（${note}）`;
          if (!note) {
            try {
              hits = (await esearch(query, observed, { retmax: 0 })).count;
              boundary();
              diagnosisCounts.set(query, hits);
            } catch (err) {
              if (err instanceof QueryOptimizationStopError) throw err;
              boundary();
              apiEvent('failure');
              note = `未判定: ${err instanceof Error ? err.message : String(err)}`;
            }
          }
        }
      }
      blockDiagnosis.narrowing[index] = diagnoseNarrowing(block, measurement.totalHits, hits, note);
    }
    // 初回だけ階層を取得する。採用後に登場した語は取得済みの文脈が無ければ未判定。
    const missing = [...new Set(blocks.flatMap((block) => meshOccurrences(block.expression))
      .filter((term) => !term.negative).map((term) => term.descriptor))]
      .filter((descriptor) => !diagnosisTrees.has(descriptor.toLowerCase()));
    if (!changed && missing.length) {
      const available = Math.max(0, Math.min(MAX_DIAGNOSIS_API_CALLS - diagnosisApiCalls,
        maxApiCalls - apiCalls - reservedApiCalls));
      // descriptor ごとの esearch に加え、最後のまとめた esummary 1 回を残す。
      const selected = missing.slice(0, Math.max(0, available - 1));
      for (const descriptor of missing.slice(selected.length)) diagnosisTreeReasons.set(descriptor.toLowerCase(),
        available === MAX_DIAGNOSIS_API_CALLS - diagnosisApiCalls ? DIAGNOSIS_LIMIT_NOTE
          : '未判定: 候補評価・差集合・最終再検証の通信予算を確保するため打ち切った');
      if (selected.length) {
        apiSource = 'MeSH';
        try {
          const { trees, reasons } = await (deps.fetchMeshTreeNumbers ?? fetchMeshTreeNumbers)(selected, observed);
          boundary();
          for (const descriptor of selected) mergeTrees(descriptor, trees.get(descriptor) ?? []);
          for (const [descriptor, reason] of reasons) diagnosisTreeReasons.set(descriptor.toLowerCase(), reason);
        } catch (err) {
          if (err instanceof QueryOptimizationStopError) throw err;
          boundary();
          apiEvent('failure');
          for (const descriptor of selected) diagnosisTreeReasons.set(descriptor.toLowerCase(),
            `未判定: 階層を取得できなかった: ${err instanceof Error ? err.message : String(err)}`);
        } finally { apiSource = 'PubMed'; }
      }
    }
    Object.assign(blockDiagnosis, diagnoseStructure(formula, fixed.approvedBlocks, diagnosisTrees, diagnosisTreeReasons));
    boundary();
    notify();
  }
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
  async function measureBlockSeedCapture(formula: PubmedFormula, blockId: string,
    seedPmids: string[]): Promise<OptimizationSeedCapture['rows'][number]> {
    task = null;
    step = 'measuring';
    notify();
    try {
      const expression = expandFormula(formula, blockId);
      const result = await esearch(`(${expression}) AND (${seedPmids.map((pmid) => `${pmid}[uid]`).join(' OR ')})`,
        eutils, { retmax: seedPmids.length });
      boundary();
      return { blockId, capturedPmids: seedPmids.filter((pmid) => result.pmids.includes(pmid)), error: null };
    } catch (err) {
      if (err instanceof QueryOptimizationStopError) throw err;
      boundary();
      apiEvent('failure');
      return { blockId, capturedPmids: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
  async function measureSeedCapture(formula: PubmedFormula, seedPmids: string[],
    measuredRows: OptimizationSeedCapture['rows'] = []): Promise<OptimizationSeedCapture> {
    const rows: OptimizationSeedCapture['rows'] = [];
    for (const block of formula.blocks) {
      // 候補評価で測った対象行は再利用し、採用後だけ残りの行を補う。
      rows.push(measuredRows.find((row) => row.blockId === block.id)
        ?? await measureBlockSeedCapture(formula, block.id, seedPmids));
    }
    return { seedPmids: [...seedPmids], rows };
  }
  async function addSeedCapture(candidate: VerifiedOptimizationCandidate,
    measuredRows: OptimizationSeedCapture['rows'] = []): Promise<VerifiedOptimizationCandidate> {
    if (!candidate.measurement.missedPmids?.length) return candidate;
    const seedCapture = await measureSeedCapture(candidate.formula, fixed.seedPmids, measuredRows);
    return { ...candidate, measurement: { ...candidate.measurement, seedCapture } };
  }
  async function fetchMissedSeeds(pmids: string[]): Promise<OptimizationMissedSeed[]> {
    try {
      const articles = await efetchArticles(pmids, eutils);
      boundary();
      return pmids.map((pmid) => {
        const article = articles.find((item) => item.pmid === pmid);
        return { pmid, title: article?.title ?? null, year: article?.year ?? null,
          hasAbstract: article?.abstract != null && article.abstract.trim() !== '',
          abstract: article?.abstract?.slice(0, 1500) ?? null, meshHeadings: article?.meshHeadings ?? [],
          note: !article ? '書誌の取得に失敗: 応答に文献がありません'
            : (article.abstract?.length ?? 0) > 1500 ? '抄録を 1500 文字で切り詰め' : null };
      });
    } catch (err) {
      if (err instanceof QueryOptimizationStopError) throw err;
      boundary();
      apiEvent('failure');
      return pmids.map((pmid) => ({ pmid, title: null, year: null, hasAbstract: false, abstract: null,
        meshHeadings: [], note: `書誌の取得に失敗: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }
  const measureImpact = async (before: PubmedFormula, after: PubmedFormula): Promise<{
    impact: OptimizationImpact; articles: AnnotateLostSampleInput['articles'];
  }> => {
    task = null;
    notify();
    const impact: OptimizationImpact = { lostHits: null, gainedHits: null, inspected: [], error: null, failedMeasurements: [] };
    let articles: AnnotateLostSampleInput['articles'] = [];
    const failure = (err: unknown, measurement: 'lost_search' | 'lost_fetch' | 'gained_search'): void => {
      if (err instanceof QueryOptimizationStopError) throw err;
      boundary();
      apiEvent('failure');
      const message = err instanceof Error ? err.message : String(err);
      impact.failedMeasurements!.push(measurement);
      impact.error = impact.error ? `${impact.error} / ${message}` : message;
    };
    const original = expandFormula(before);
    const candidate = expandFormula(after);
    let pmids: string[] = [];
    try {
      const lost = await esearch(`(${original}) NOT (${candidate})`, eutils, { retmax: 10000 });
      impact.lostHits = lost.count;
      if (lost.count > 0) {
        const retrieved = [...new Set(lost.pmids)];
        const seed = Math.floor((deps.random ?? Math.random)() * 2 ** 32) >>> 0;
        const inspectLimit = lost.count <= HELD_CANDIDATE_ADOPTION_LOST_HITS_THRESHOLD ? lost.count : INSPECT_LIMIT;
        pmids = samplePmids(retrieved, inspectLimit, seed);
        impact.sample = {
          method: lost.count <= 10000 && retrieved.length === lost.count ? 'all' : 'retrieved_subset',
          seed, populationCount: lost.count, retrievedCount: retrieved.length,
          pmids, sampledAt: new Date(now()).toISOString(),
        };
      }
    } catch (err) { failure(err, 'lost_search'); }
    try {
      impact.gainedHits = (await esearch(`(${candidate}) NOT (${original})`, eutils, { retmax: 0 })).count;
    } catch (err) { failure(err, 'gained_search'); }
    if (impact.lostHits !== null && impact.lostHits > 0) {
      try {
        articles = (await efetchArticles(pmids, eutils)).map(({ pmid, title, year, abstract, meshHeadings }) =>
          ({ pmid, title, year, abstract, meshHeadings }));
        impact.inspected = articles.map(({ pmid, title, year }) => ({ pmid, title, year }));
      } catch (err) { failure(err, 'lost_fetch'); }
    }
    return { impact, articles };
  };
  async function finish(reason: OptimizationStopReason,
    latestMeasurement: OptimizationMeasurement | undefined = best?.measurement): Promise<QueryOptimizationResult> {
    terminal = reason;
    runController.abort(new QueryOptimizationStopError(reason));
    const unmetReasons: string[] = [];
    if (reason === 'seed_capture_stalled') unmetReasons.push(new QueryOptimizationStopError(reason).message);
    const seedDiagnoses: OptimizationSeedDiagnosis[] = (latestMeasurement?.missedPmids ?? []).map((pmid) => {
      const article = missedSeeds.find((item) => item.pmid === pmid);
      const capture = best?.measurement.seedCapture;
      const measured = capture?.rows.filter((row) => row.capturedPmids !== null) ?? [];
      const unknown = capture?.rows.filter((row) => row.capturedPmids === null).map((row) => `#${row.blockId}`) ?? [];
      const blockingBlockIds = measured.length ? measured.filter((row) => !row.capturedPmids!.includes(pmid)).map((row) => row.blockId) : null;
      const blockingConceptIds = blockingBlockIds?.filter((id) =>
        best?.formula.blocks.some((block) => block.id === id && block.isCombination === false)) ?? [];
      const outside = blockingConceptIds.filter((id) => !fixed.approvedBlocks.some((block) => block.id === id));
      const combination = blockingBlockIds !== null && !blockingBlockIds.some((id) =>
        best?.formula.blocks.some((block) => block.id === id && !block.isCombination));
      const recoverableByTerms = blockingBlockIds === null ? null : outside.length > 0 || combination ? false : true;
      const meshHeadingCount = !article || article.note?.startsWith('書誌の取得に失敗') ? null : article.meshHeadings.length;
      const note = [blockingBlockIds === null ? '捕捉表が未測定のため判定不能'
        : combination ? unknown.length ? '測定できた概念ブロックはすべて捕捉しているが、未測定行があるため原因は判定不能'
          : '全概念ブロックが捕捉しているのに最終式で未捕捉（結合構造）'
          : `ブロック ${blockingConceptIds.map((id) => `#${id}`).join('、')} が落としている`,
      ...(outside.length ? [`${outside.map((id) => `#${id}`).join('、')} は承認外のブロック（研究デザインフィルタ等）`] : []),
      ...(unknown.length ? [`${unknown.join('、')} は未測定のため判定不能`] : []),
      `抄録${article?.hasAbstract ? 'あり' : 'なし'}・MeSH ${meshHeadingCount ?? '未取得'} 件`,
      ...(article?.note ? [article.note] : [])].join('。');
      return { pmid, title: article?.title ?? null, year: article?.year ?? null, hasAbstract: article?.hasAbstract ?? false,
        meshHeadingCount, blockingBlockIds, recoverableByTerms, note };
    });
    const unrecoverable = seedDiagnoses.filter((seed) => seed.recoverableByTerms === false);
    if (unrecoverable.length) unmetReasons.push(`語の調整では回収できないシードがあります（${unrecoverable.map((seed) => seed.pmid).join(', ')}）。検索概念・フィルタが強すぎる可能性があるため、ブロック承認（#/blocks）で見直してください`);
    if (diagnosedHeldId) unmetReasons.push(`ブロック #${diagnosedHeldId} を狭める案が 2 回続けて保留になりました（失う集合が残る）。このブロックは上位の MeSH でしか索引されない文献を含む可能性があります。狭めると適格文献を落とすおそれがあるため、目安件数の見直しを検討してください。`);
    if (!best) unmetReasons.push('検証済み候補がありません');
    if (pendingInformation) unmetReasons.push(`情報要求 ${pendingInformation.candidateId} への判断が未了です（文脈へ反映 ${pendingInformation.obtained} / 要求 ${pendingInformation.requested} 件）`);
    if (termBudgetExhausted) unmetReasons.push(`語別計測は ${MAX_TERM_API_CALLS} 通信の上限に達しました。追加取得していない語別件数・固有寄与は未測定です。`);
    if (termBudgetReserved) unmetReasons.push('候補評価・差集合の実測・最終再検証の通信予算を確保するため、語別計測を打ち切りました。追加取得していない語別件数・固有寄与は未測定です。');
    if (fixed.seedPmids.length === 0) unmetReasons.push('シードが未指定です');
    // 最良候補は保持し、最終再検証で崩れた値だけを未達理由の根拠に切り替える。
    if (latestMeasurement?.missedPmids?.length) unmetReasons.push(`未捕捉シード: ${latestMeasurement.missedPmids.join(', ')}`);
    if (latestMeasurement?.totalHits != null && latestMeasurement.totalHits > fixed.maxHits) {
      unmetReasons.push(`目安件数 ${fixed.maxHits} 件を超えています（実測 ${latestMeasurement.totalHits} 件）`);
      if (['no_improvement', 'diagnosed_block_held', 'held_candidates_collected', 'iteration_limit', 'repeated_formula'].includes(reason)) {
        const heldCount = trials.filter((trial) => trial.held
          && typeof trial.before?.totalHits === 'number' && typeof trial.after?.totalHits === 'number'
          && trial.after.totalHits < trial.before.totalHits).length;
        unmetReasons.push(heldCount > 0
          ? '件数を減らす候補は見つかりましたが、既に捕捉している文献を失うため自動採用していません。自動調整は捕捉済みの文献を失わない変更だけを自動採用するので、自動では件数は減りません。件数を減らすには、保留候補を最終レビューで判定して採用するか、検索戦略のレビュー・目安件数の見直しを検討してください。'
          : '件数を減らす変更案は得られませんでした。これは件数を減らせないことの証明ではありません。自動調整は捕捉済みの文献を失わない変更だけを自動採用するので、自動では件数は減りません。検索戦略のレビュー（概念と検索語の対応・AND/OR の論理・フィルタの適用対象）か、目安件数の見直しを検討してください。');
        if (heldCount > 0) unmetReasons.push(`件数を減らす候補を ${heldCount} 件保留しました（削除影響の確認を参照）。`);
      }
    }
    if (reason !== 'conditions_met') unmetReasons.push(`終了理由: ${reason}`);
    if (reason !== 'conditions_met') {
      for (const trial of trials.filter((item) => item.held)) {
        unmetReasons.push(`レビュー候補として保留: ${trial.candidateId}（失う ${trial.impact?.lostHits ?? '未測定'} 件・増える ${trial.impact?.gainedHits ?? '未測定'} 件）`);
      }
    }
    const result: QueryOptimizationResult = {
      status: reason === 'conditions_met' ? 'achieved' : reason === 'user_stop' || reason === 'request_timeout' ? 'stopped'
        : reason === 'api_error' || reason === 'invalid_input' ? 'error' : 'needs_review',
      stopReason: reason, best, trials, blockDiagnosis, unmetReasons, seedDiagnoses, iterations, informationTrials, apiCalls, elapsedMs: now() - startedAt,
    };
    // 終了後に残すのは確定した終了記録だけ。停止境界を通さず、候補・測定は更新しない。
    // 試行も通信消費も記録していない run は、既存の別 run のチェックポイントに触れない。
    if (trials.length > 0 || checkpointWritten) {
      try {
        await saveQueryOptimizationCheckpoint({ ...checkpointOptions(), completion: {
            status: result.status, stopReason: result.stopReason, unmetReasons: result.unmetReasons,
          } }, deps.checkpoint);
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

  // shouldStop は通知型ではないため、通信中も短い間隔で確認する。
  const stopPoll = setInterval(() => {
    try { boundary(false); } catch { /* abort により待機中の処理へ伝わる。 */ }
  }, STOP_POLL_INTERVAL_MS);
  // 実時間の期限でも boundary に判定を委ね、注入された now と食い違わせない。
  const deadline = setTimeout(() => {
    try { boundary(false); } catch { /* abort により待機中の処理へ伝わる。 */ }
  }, Math.max(0, maxElapsedMs));
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
    const beforeInitialApiCalls = apiCalls;
    const initial = await measure(fixed.initialFormula, 'initial');
    // 次候補・最終再検証の実コストと差集合3通信に、AI提案1回と上限応答を破棄する境界の余裕1回を加える。
    // 語別計測にも予算を残すため、確保分は全体の半分を上限とする。
    reservedApiCalls = Math.min(2 * (apiCalls - beforeInitialApiCalls) + 3 + 2, Math.floor(maxApiCalls / 2));
    let initialStop: QueryOptimizationStopError | null = null;
    if (initial.evaluation.status === 'success') {
      best = initial;
      try {
        best = await addSeedCapture(best);
        initial.measurement = best.measurement;
        if (best.measurement.missedPmids?.length) missedSeeds = await fetchMissedSeeds(best.measurement.missedPmids);
      } catch (err) {
        if (err instanceof QueryOptimizationStopError) initialStop = err;
        else throw err;
      }
    }
    trials.push(makeTrial({ kind: 'initial', candidateId: 'initial', formula: initial.formula,
      before: null, after: initial.measurement, accepted: initial.evaluation.status === 'success',
      reason: '初期式の実測', rationale: '' }));
    if (initial.evaluation.status === 'success') best = initial;
    seen.set(initial.evaluation.fingerprint, 'initial');
    // 停止しても実測済みの初期試行は履歴に残す。
    if (initialStop) throw initialStop;
    if (best) await updateDiagnosis(best);
    await save();
    if (!best) return finish('api_error');
    let noImprovement = 0;
    let heldCandidates = 0;
    let intermediateAcceptances = 0;
    // 各承認ブロックを一度ずつ直す機会を残す。入力検証済みなので上限は最低 1 回。
    const maxIntermediateAcceptances = fixed.approvedBlocks.length;
    let measurementFailures = 0;
    const reason: OptimizationStopReason = 'iteration_limit';
    for (let round = 1; round <= maxIterations; round += 1) {
      boundary();
      apiEvents = [];
      step = 'adjusting';
      notify();
      // 初回と採用後だけ語を測る。同じ最良式の却下後は取得済み文脈を共有する。
      if (!best.measurement.terms) {
        const terms = await measureTerms(best.formula, fixed.approvedBlocks, {
          ...termOptions, blocks: best.measurement.blocks,
          finalHits: deps.measureTermDetails ? best.measurement.totalHits : undefined,
        });
        boundary();
        // 記録済み試行が参照する測定は不変とし、AI 文脈を付加した新しい測定へ差し替える。
        best = { ...best, measurement: { ...best.measurement, terms } };
      }
      task = null;
      notify();
      boundary();
      const provider = deps.llmFactory.forPurpose('optimize_query', deps.onProgress ? (state) => {
        if (terminal) return;
        if (state === 'idle') { apiWaiting = null; notify(); return; }
        apiSource = 'AI';
        apiEvent(state);
        apiSource = 'PubMed';
      } : undefined, {
        beforeAttempt: async () => {
          boundary();
          apiCalls += 1;
          await persistProgress();
          boundary(false);
        },
        createSignal: () => {
          llmSignal = requestSignal(deps.llmRequestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS);
          return llmSignal;
        },
        sleep,
      });
      const proposal = await abortable(optimizeQuery({
        formula: best.formula, approvedBlocks: fixed.approvedBlocks, criteria: fixed.criteria,
        maxHits: fixed.maxHits, measurement: best.measurement,
        missedSeeds: missedSeeds.filter((seed) => best!.measurement.missedPmids?.includes(seed.pmid)),
        seedPapers: fixed.seedPapers ?? fixed.seedPmids.map((pmid) => ({ pmid, title: null })),
        blockDiagnosis, meshContext, meshRequestResults, trials, previousRejectedTrials: fixed.previousRejectedTrials,
      }, provider));
      llmSignal = undefined;
      boundary();
      iterations = round;
      const candidateId = `candidate-${round}`;
      if (proposal.meshRequests.length > 0) {
        // 情報要求だけの回は候補評価を保留する。同一式回帰とせず、次の AI が取得結果を読む。
        // この回も反復上限に数え、情報要求だけが続いても無限に継続しない。
        informationTrials += 1;
        const information = await expandMesh(proposal.meshRequests, round < maxIterations);
        trials.push(makeTrial({ kind: 'information', candidateId, formula: best.formula,
          before: best.measurement, after: null, accepted: false, reason: information.notes, rationale: proposal.rationale,
          informationResult: { requested: information.requested, obtained: information.obtained },
          meshRequests: proposal.meshRequests.map((request) => ({ ...request })) }));
        pendingInformation = { candidateId, requested: information.requested, obtained: information.obtained };
        await save();
        boundary();
        continue;
      } else {
        evaluatedTrials += 1;
        const candidate = applyProposal(best.formula, proposal);
        const formulaDiff = diffOptimizationFormula(best.formula, candidate);
        const details = {
          formulaDiff,
          kind: 'proposal' as const,
          ...(pendingInformation ? { informedBy: { ...pendingInformation } } : {}),
          changes: { targetBlockId: proposal.targetBlockId, addedTerms: [...proposal.addedTerms],
            removedTerms: [...proposal.removedTerms], replacedTerms: proposal.replacedTerms.map((term) => ({ ...term })) },
        };
        pendingInformation = undefined;
        const removed = proposal.removedTerms.length ? proposal.removedTerms : (() => {
          const replaced = new Set(proposal.replacedTerms.map((term) => normalizeOptimizationTerm(term.before)));
          return formulaDiff.flatMap((block) => block.removed)
            .filter((term) => !replaced.has(normalizeOptimizationTerm(term)));
        })();
        const invalid = validateOptimizationCandidate(fixed.initialFormula, candidate, fixed.approvedBlocks, proposal)
          ?? (best.measurement.missedPmids?.length && removed.length
            ? `未捕捉シードがある間は削除案を受け付けません（回収を優先: 同義語追加・MeSH 拡張。削除とみなした語: ${removed.join(', ')}）` : null);
        const candidateFingerprint = invalid ? undefined : await formulaFingerprint(candidate);
        // 人が最終レビューで「除外」を選んだ変更は、実測前に却下する（評価済み重複と同じ場所・別の理由）。
        const humanRejection = candidateFingerprint
          ? fixed.previousRejectedTrials?.find((rejection) => rejection.rejectedByHuman && rejection.fingerprint === candidateFingerprint)
          : undefined;
        const duplicateOf = candidateFingerprint && !humanRejection ? seen.get(candidateFingerprint) : undefined;
        if (invalid) {
          trials.push(makeTrial({ ...details, candidateId, formula: candidate, before: best.measurement,
            after: null, accepted: false, reason: invalid, rationale: proposal.rationale }));
          noImprovement += 1;
          await save();
        } else if (humanRejection) {
          trials.push(makeTrial({ ...details, candidateId, formula: candidate, before: best.measurement,
            after: null, accepted: false,
            reason: `人が除外した候補と同じ式のため測定せずに却下（${humanRejection.reason}）`, rationale: proposal.rationale }));
          noImprovement += 1;
          await save();
        } else if (duplicateOf !== undefined) {
          trials.push(makeTrial({ ...details, candidateId, formula: candidate, before: best.measurement,
            after: null, accepted: false, duplicateOf,
            reason: `評価済みの同一式の再提案のため測定せずに却下（${duplicateOf} と同じ式）`, rationale: proposal.rationale }));
          noImprovement += 1;
          await save();
        } else {
          boundary();
          step = 'measuring';
          notify();
          const measured = await measure(candidate, candidateId);
          const failed = measured.evaluation.status === 'failure';
          measurementFailures = failed ? measurementFailures + 1 : 0;
          const before = best.measurement;
          const lostSeeds = before.capturedPmids!.filter((pmid) => !measured.measurement.capturedPmids?.includes(pmid));
          // 対象行は判定と採用後の再利用に使い、完全な表が揃うまで measurement に保存しない。
          let targetRow: OptimizationSeedCapture['rows'][number] | undefined;
          if (!failed && lostSeeds.length === 0 && before.missedPmids!.length > 0) {
            targetRow = await measureBlockSeedCapture(candidate, proposal.targetBlockId, fixed.seedPmids);
          }
          const beforeBlock = before.seedCapture?.rows.find((row) => row.blockId === proposal.targetBlockId)?.capturedPmids;
          const afterBlock = targetRow?.capturedPmids;
          const improved = measured.evaluation.status === 'success' && lostSeeds.length === 0
            && isImprovement(before, measured.measurement, fixed.maxHits, beforeBlock?.length, afterBlock?.length);
          const redundant = !improved && !failed && lostSeeds.length === 0 && before.missedPmids!.length === 0
            && measured.measurement.totalHits === before.totalHits
            && proposal.addedTerms.length === 0 && proposal.replacedTerms.length === 0
            && formulaDiff.every((block) => block.added.length === 0)
            && formulaDiff.some((block) => block.removed.length > 0);
          const rejection = failed ? describeMeasurementFailure(measured.evaluation)
            : lostSeeds.length > 0 ? `捕捉済みシードを失う: ${lostSeeds.join(', ')}`
              : '局面の指標に改善がありません';
          // 採否に要る差集合を先に測る。追加詳細（語別計測）の途中で停止しても採否は確定している。
          const impactResult = improved || redundant
            ? await measureImpact(best.formula, candidate)
            : undefined;
          const impact = impactResult?.impact;
          const accepted = impact?.lostHits === 0 && impact.gainedHits !== null && (!redundant || impact.gainedHits === 0);
          const held = improved && impact !== undefined && !accepted;
          const intermediate = accepted && before.missedPmids!.length > 0
            && measured.measurement.capturedPmids!.length === before.capturedPmids!.length;
          const improvementReason = before.missedPmids!.length && beforeBlock && afterBlock
            ? `ブロック #${proposal.targetBlockId} のシード捕捉が ${beforeBlock.length} 件から ${afterBlock.length} 件に増えました${intermediate ? '（最終式の捕捉数は変わらない中間手を採用）' : ''}`
            : '局面の指標が改善しました';
          // 候補または差集合の測定失敗は照合対象にせず、再測定の機会を残す。
          if (!failed && !(impact && (impact.lostHits === null || impact.gainedHits === null))) {
            seen.set(measured.evaluation.fingerprint, candidateId);
          }
          const impactReason = impact && (redundant
            ? accepted ? '冗長整理: 検索集合が変わらない削除を採用しました（失う集合 0 件、増える集合 0 件）'
              : `冗長整理の不成立: 検索集合が同一と確認できないため却下しました（失う集合 ${impact.lostHits ?? '未測定'} 件、増える集合 ${impact.gainedHits ?? '未測定'} 件）${impact.error ? `: ${impact.error}` : ''}`
            : accepted
            ? `${improvementReason}（失う集合 0 件、増える集合 ${impact.gainedHits} 件）`
            : impact.lostHits !== null && impact.lostHits > 0
              ? `失う集合 ${impact.lostHits} 件のためレビュー候補に留めました（${impact.sample?.method === 'retrieved_subset' ? `取得できた ${impact.sample.retrievedCount} 件から無作為抽出した書誌` : '無作為抽出した書誌'} ${impact.inspected.length} 件 / 全体 ${impact.lostHits}、増える集合 ${impact.gainedHits ?? '未測定'} 件）`
              : `${impact.lostHits === null ? '失う集合' : '増える集合'}を実測できなかったためレビュー候補に留めました: ${impact.error}`);
          let detailStop: QueryOptimizationStopError | null = null;
          const productiveHold = held && impact!.lostHits !== null && impact!.lostHits >= 1;
          if (productiveHold) heldCandidates += 1;
          noImprovement = accepted || productiveHold ? 0 : noImprovement + 1;
          if (productiveHold && impactResult!.articles.length) {
            let annotationSignal: AbortSignal | undefined;
            const annotation: NonNullable<OptimizationImpact['annotation']> = {
              status: 'failure', annotatedAt: new Date(now()).toISOString(),
              requestedPmids: impactResult!.articles.map((article) => article.pmid), items: [], error: null,
            };
            apiSource = 'AI';
            try {
              const annotationProvider = deps.llmFactory.forPurpose('annotate_lost_sample', deps.onProgress ? (state) => {
                if (terminal) return;
                if (state === 'idle') { apiWaiting = null; notify(); return; }
                apiEvent(state);
              } : undefined, {
                beforeAttempt: async () => {
                  boundary();
                  apiCalls += 1;
                  await persistProgress();
                  boundary(false);
                },
                createSignal: () => {
                  annotationSignal = requestSignal(deps.llmRequestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS);
                  return annotationSignal;
                },
                sleep,
              });
              annotation.items = await abortable(annotateLostSample({ criteria: fixed.criteria,
                articles: impactResult!.articles }, annotationProvider));
              boundary(false);
              annotation.status = 'success';
            } catch (err) {
              // run の停止を最優先し、実測済み trial を保存した後で投げ直す。
              let failure = err;
              try { boundary(false); } catch (stopped) { failure = stopped; }
              if (failure instanceof QueryOptimizationStopError) {
                detailStop = failure;
                annotation.error = failure.message;
              } else if (annotationSignal?.aborted && annotationSignal.reason instanceof DOMException
                && annotationSignal.reason.name === 'TimeoutError') {
                annotation.error = 'AI の参考注釈の通信が期限切れになりました';
                apiEvent('failure');
              } else {
                annotation.error = failure instanceof Error ? failure.message : String(failure);
                apiEvent('failure');
              }
            } finally {
              annotation.annotatedAt = new Date(now()).toISOString();
              impact!.annotation = annotation;
              apiSource = 'PubMed';
            }
          }
          if (!detailStop && deps.measureTermDetails && measured.evaluation.status === 'success') {
            try {
              measured.measurement = { ...measured.measurement, terms: await measureTerms(candidate, fixed.approvedBlocks, {
                ...termOptions, blocks: measured.measurement.blocks, finalHits: measured.measurement.totalHits,
              }) };
            } catch (err) {
              if (err instanceof QueryOptimizationStopError) detailStop = err;
              else apiEvent('failure');
            }
          }
          if (accepted) {
            best = measured;
            if (!detailStop) {
              try { best = await addSeedCapture(best, targetRow ? [targetRow] : []); measured.measurement = best.measurement; }
              catch (err) { if (err instanceof QueryOptimizationStopError) detailStop = err; else throw err; }
            }
          }
          trials.push(makeTrial({ ...details, candidateId, formula: candidate, before, after: measured.measurement,
            accepted, ...(impact ? { held, impact } : {}), reason: impactReason ?? rejection,
            rationale: proposal.rationale }));
          if (accepted) {
            intermediateAcceptances = intermediate ? intermediateAcceptances + 1 : 0;
            best = measured;
            await updateDiagnosis(best);
          }
          // 追加詳細の停止でも、実測済み候補と採否を履歴へ残してから終了する。
          if (detailStop) throw detailStop;
          await save();
          if (measurementFailures >= MAX_CONSECUTIVE_MEASUREMENT_FAILURES) return finish('api_error');
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
          reason: achieved ? '最終再検証で目安件数と既知シードの捕捉を満たしました' : '最終再検証で条件未達', rationale: '' }));
        if (achieved) { best = verified; await updateDiagnosis(best); }
        await save();
        if (verified.evaluation.status === 'failure') return finish('api_error', verified.measurement);
        return finish(achieved ? 'conditions_met' : 'revalidation_failed', verified.measurement);
      }
      diagnosedHeldId = diagnosedHeldBlock(trials, blockDiagnosis);
      if (diagnosedHeldId) return finish('diagnosed_block_held');
      if (intermediateAcceptances >= maxIntermediateAcceptances) return finish('seed_capture_stalled');
      if (heldCandidates >= MAX_HELD_CANDIDATES) return finish('held_candidates_collected');
      if (noImprovement >= 2) return finish('no_improvement');
    }
    return finish(reason);
  } catch (err) {
    let failure = err;
    if (!terminal && llmSignal?.aborted && llmSignal.reason instanceof DOMException
      && llmSignal.reason.name === 'TimeoutError') {
      try { boundary(false); } catch { /* run の停止理由を優先する。 */ }
      terminal ??= 'request_timeout';
    }
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
  } finally {
    clearInterval(stopPoll);
    clearTimeout(deadline);
    runController.abort();
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

/** 未捕捉時は対象ブロックの捕捉増加、全件捕捉後は上限超過分の減少だけを改善とする。 */
export function isImprovement(before: OptimizationMeasurement, after: OptimizationMeasurement, maxHits: number,
  beforeBlockCaptured: number | undefined, afterBlockCaptured: number | undefined): boolean {
  if (before.missedPmids!.length > 0) {
    if (beforeBlockCaptured === undefined || afterBlockCaptured === undefined) return after.capturedPmids!.length > before.capturedPmids!.length;
    return afterBlockCaptured > beforeBlockCaptured && after.capturedPmids!.length >= before.capturedPmids!.length;
  }
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
  if (input.maxHits < input.seedPmids.length) return '目安件数がシード数より少なく、条件を両立できません';
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
  cache: Map<string, number>;
  canMeasure: () => boolean;
  eutils: EutilsDeps;
  check: () => void;
  onProgress?: (completed: number, total: number) => void;
  finalHits?: number | null;
  blocks?: OptimizationMeasurement['blocks'];
  onFailure?: () => void;
}

/** 原タグを保持した単独件数と累積 OR の純増。最終式の固有寄与と混同しない。 */
async function measureTerms(formula: PubmedFormula, approvedBlocks: readonly ApprovedOptimizationBlock[],
  { eutils, cache, canMeasure, check, onProgress, finalHits, blocks: measuredBlocks, onFailure }: MeasureTermsOptions): Promise<NonNullable<OptimizationMeasurement['terms']>> {
  const terms: NonNullable<OptimizationMeasurement['terms']> = [];
  const count = async (query: string) => {
    check();
    const cached = cache.get(query);
    if (cached !== undefined) return cached;
    if (!canMeasure()) throw new TermAnalysisBudgetError('語別計測の通信上限');
    try {
      const value = (await esearch(query, eutils, { retmax: 0 })).count;
      cache.set(query, value);
      return value;
    } catch (err) {
      check();
      if (canMeasure()) onFailure?.();
      throw err;
    }
  };
  const approvedIds = new Set(approvedBlocks.map((block) => block.id));
  const blocks = formula.blocks.filter((item) => !item.isCombination && approvedIds.has(item.id));
  const blockHits = new Map(measuredBlocks?.map((block) => [block.id, block.hits]));
  const measurementOrder = [...blocks].sort((a, b) => (blockHits.get(b.id) ?? -1) - (blockHits.get(a.id) ?? -1));
  const contributions = new Map<string, Map<string, number>>();
  const contributionPlans = finalHits == null ? [] : measurementOrder.flatMap((block) => {
    const segments = tokenizeExpression(block.expression);
    if (!segments.every((segment) => segment.kind !== 'plain'
      || /^[\s()]*$/.test(segment.text.replace(/\bOR\b/gi, '')))) return [];
    const queries = [...new Set(segments.filter((segment) => segment.kind === 'freeword' || segment.kind === 'mesh')
      .map((segment) => segment.text.trim()))];
    return [{ block, segments, queries }];
  });
  // 延べ対象語数。固有寄与と個別件数・累積Δを別単位とし、未測定の確定も処理済みに数える。
  const total = contributionPlans.reduce((sum, plan) => sum + plan.queries.length, 0)
    + blocks.reduce((sum, block) => sum + new Set(extractBlockTerms(block.expression).freewordTerms
    .map((term) => term.query.trim()).filter(Boolean)).size
    + tokenizeExpression(block.expression).filter((item) => item.kind === 'mesh').length, 0);
  onProgress?.(0, total);
  let completed = 0;
  const advance = () => { completed += 1; onProgress?.(completed, total); };
  if (finalHits != null) {
    for (const { block, segments, queries } of contributionPlans) {
      const values = new Map<string, number>();
      contributions.set(block.id, values);
      for (const query of queries) {
        const without: PubmedFormula = { ...formula, blocks: formula.blocks.map((item) => item.id !== block.id ? item : {
          ...item, expression: segments.map((segment) => (segment.kind === 'freeword' || segment.kind === 'mesh')
            && segment.text.trim() === query ? `(${segment.text} NOT ${segment.text})` : segment.text).join(''),
        }) };
        try {
          // キャッシュキーには最終式全体と除去後の式を含める。語だけでは再利用しない。
          const value = await count(`(${expandFormula(formula)}) NOT (${expandFormula(without)})`);
          if (value <= finalHits) values.set(query, value);
        } catch { check(); }
        advance();
      }
    }
  }
  for (const block of measurementOrder) {
    check();
    const freewords = extractBlockTerms(block.expression).freewordTerms;
    const delta = await analyzeFreewordDelta(freewords, count);
    // 部分失敗・逆転のクランプは Δ=0 の実測ではない。以降の累積差分も不確かとして捨てる。
    let uncertain = false;
    for (const row of delta.rows) {
      uncertain = uncertain || row.clamped || row.individualError;
      terms.push({ blockId: block.id, query: row.query, hits: row.individualError ? null : row.individual,
        delta: uncertain ? null : row.delta,
        ...(finalHits !== undefined ? { finalContribution: contributions.get(block.id)?.get(row.query.trim()) ?? null } : {}) });
      advance();
    }
    for (const segment of tokenizeExpression(block.expression).filter((item) => item.kind === 'mesh')) {
      let hits: number | null = null;
      try { hits = await count(segment.text); }
      catch (err) {
        check();
        if (!(err instanceof TermAnalysisBudgetError)
          && !(err instanceof DOMException && err.name === 'TimeoutError') && canMeasure()) throw err;
      }
      terms.push({ blockId: block.id, query: segment.text, hits, delta: null,
        ...(finalHits !== undefined ? { finalContribution: contributions.get(block.id)?.get(segment.text.trim()) ?? null } : {}) });
      advance();
    }
  }
  // 測定の優先順とは独立に、表示と AI 文脈では元のブロック順・各ブロック内の行順を保つ。
  return blocks.flatMap((block) => terms.filter((term) => term.blockId === block.id));
}

/** PMID の順に依存しない、種付きの非復元一様抽出。 */
export function samplePmids(pmids: string[], limit: number, seed: number): string[] {
  const pool = [...new Set(pmids)].sort((a, b) => Number(a) - Number(b));
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
  };
  const size = Math.min(Math.max(0, Math.floor(limit)), pool.length);
  for (let i = 0; i < size; i += 1) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, size).sort((a, b) => Number(a) - Number(b));
}

function normalizeOptimizationTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 実式を比較し、申告に依存せず元の表記で変更語を残す。 */
export function diffOptimizationFormula(before: PubmedFormula, after: PubmedFormula): NonNullable<OptimizationTrial['formulaDiff']> {
  const terms = (expression: string) => new Map(tokenizeExpression(expression)
    .filter((segment) => segment.kind === 'mesh' || segment.kind === 'freeword')
    .map((segment) => [normalizeOptimizationTerm(segment.text), segment.text.trim()]));
  const result: NonNullable<OptimizationTrial['formulaDiff']> = [];
  for (const id of new Set([...before.blocks, ...after.blocks].map((block) => block.id))) {
    const oldBlock = before.blocks.find((block) => block.id === id);
    const newBlock = after.blocks.find((block) => block.id === id);
    const oldExpression = oldBlock?.expression ?? '';
    const newExpression = newBlock?.expression ?? '';
    if (oldBlock?.isCombination || newBlock?.isCombination) {
      if (oldExpression !== newExpression || oldBlock?.isCombination !== newBlock?.isCombination) result.push({ blockId: id,
        removed: oldExpression ? [oldExpression] : [], added: newExpression ? [newExpression] : [] });
    } else {
      const oldTerms = terms(oldExpression);
      const newTerms = terms(newExpression);
      const removed = [...oldTerms].filter(([key]) => !newTerms.has(key)).map(([, term]) => term);
      const added = [...newTerms].filter(([key]) => !oldTerms.has(key)).map(([, term]) => term);
      if (removed.length || added.length) result.push({ blockId: id, added, removed });
    }
  }
  if (before.combinationExpression !== after.combinationExpression
    && !result.some((diff) => before.blocks.some((block) => block.id === diff.blockId && block.isCombination)
      || after.blocks.some((block) => block.id === diff.blockId && block.isCombination))) {
    result.push({ blockId: after.blocks.filter((block) => block.isCombination).pop()?.id
      ?? before.blocks.filter((block) => block.isCombination).pop()?.id ?? 'combinationExpression',
    removed: before.combinationExpression ? [before.combinationExpression] : [],
    added: after.combinationExpression ? [after.combinationExpression] : [] });
  }
  return result;
}
