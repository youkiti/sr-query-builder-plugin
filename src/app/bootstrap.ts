declare const __BUILD_DATE__: string;

/**
 * メインビュー（app.html）の起動ロジック。
 * router / store / views を組み合わせ、ハッシュ変更とストア更新の両方で再レンダする。
 *
 * wiring 層も兼ねており、起動時に chrome.storage から currentProject を読んで
 * store に反映し、protocol / blocks view の callback に services を結び付ける。
 */

import { resolveMeshDescriptors } from '@/lib/ncbi/mesh';
import { adoptHeldOptimizationCandidate, adoptQueryOptimization, editQueryOptimization } from './services/queryOptimizationAdoptionService';
import { createOptimizationProgressPublisher } from './services/queryOptimizationProgressPublisher';
import { searchOutsideCandidates } from './services/expandService';
import { buildOptimizationReviewSections } from './services/queryOptimizationReviewSections';

import {
  approveBlocks,
  buildEutilsDeps,
  withExpandApiWait,
  buildLlmProviderFactory,
  clearBlocksDraftBackup,
  createChromeRuntimeDeps,
  getBlocksDraftBackup,
  saveBlocksDraftBackup,
  exportToAllDatabases,
  fetchBoundaryCandidates,
  fillPmidForRisRow,
  generateDraft,
  generateDraftFormula,
  runQueryOptimization,
  getQueryOptimizationSettings,
  saveQueryOptimizationSettings,
  validateQueryOptimizationSettings,
  resolveTargetHits,
  DEFAULT_QUERY_OPTIMIZATION_SETTINGS,
  QueryOptimizationStopError,
  type QueryOptimizationSettings,
  ingestSeeds,
  invalidateSeed,
  setSeedEnabled,
  listSeeds,
  recordDecision,
  retrySeed,
  requestBlockImprovement,
  getBlockImprovementContext,
  runValidation,
  analyzeMissedSeeds,
  saveEditedFormula,
  submitProtocol,
  type AnalyzeMissedSeedsResult,
  type BlockImprovementContext,
  type ChromeRuntimeDeps,
  type DraftBlockHit,
  type DraftProgress,
  type DraftResult,
  type ExportResult,
  type IngestInput,
  type IngestSummary,
  type LlmFactoryDeps,
  type LlmProviderFactory,
  type ProtocolSubmissionInput,
  type InsideStrategy,
  type RecordDecisionInput,
  type RecordDecisionResult,
  type RequestBlockImprovementInput,
  type SaveEditedFormulaInput,
  type SaveEditedFormulaResult,
  type SeedPaperWithRow,
  type ValidationProgress,
  type ValidationSummary,
} from './services';
import { isSeedEligibleForValidation, type SeedPaper } from '@/domain/seedPaper';
import { listSeedPapers } from '@/features/seeds';
import { parsePubmedFormulaMd, type PubmedFormula } from '@/lib/search-formula-md';
import { newUuid } from '@/utils/uuid';
import { fetchMeshContext } from './services/meshContextService';
import { createQueryOptimizationInputIdentity, getQueryOptimizationCheckpoint,
  getQueryOptimizationResumeAvailability, updateQueryOptimizationHeldRejections,
  getHumanRejectedTrials, updateQueryOptimizationReviewSections } from './services/queryOptimizationCheckpointService';
import { nowIso } from '@/utils/iso8601';
import {
  efetchArticles,
  esearch,
  fetchMeshChildren,
  fetchMeshLabels,
  fetchMeshTreeNumbers,
  type EfetchArticle,
} from '@/lib/ncbi';
import { classifyApiError } from '@/lib/api-error';
import {
  appendExcessFilterBlocks,
  getLatestFormulaVersion,
  listFormulaVersions,
} from '@/features/formula';
import {
  HIT_THRESHOLD,
  proposeExcessFilters,
  type ExcessFilterCandidate,
} from '@/features/formula/skills';
import type { FormulaVersion } from '@/domain/formulaVersion';
import { getCurrentProject } from '@/features/project';
import {
  fflateDocxExtractor,
  getLatestProtocol,
  getProtocolBlocksByVersion,
  listProtocols,
} from '@/features/protocol';
import type { Protocol, ProtocolBlock } from '@/domain/protocol';
import type { BlocksDraft, ProtocolDraft, OptimizationOutsideCheckState } from './store';
import { buildSpreadsheetUrl, getCurrentUserEmail } from '@/lib/google';
import { PICKER_GRANT_MESSAGE, type PickerGrantResult } from '@/background/pickerGrant';
import { evaluateGuards } from './guards';
import {
  ROUTE_LABELS,
  SIDEBAR_ROUTES,
  buildHash,
  parseRoute,
  type RouteName,
} from './router';
import { createStore, type AppState, type AppStore, type ExpandApiWait } from './store';
import { buildViews, type BuildViewsOptions, type ViewContext } from './views';
import { formatDraftProgress, formatValidationProgress } from './views/draftView';
import { resolveInstructionDraft } from './views/editView';
import { formatFormulaVersionShort } from './views/formatHelpers';

export interface AppBootstrapOptions {
  getHash: () => string;
  onHashChange: (listener: () => void) => () => void;
  /** location.hash を更新するための関数。テスト時に差し替え可能 */
  setHash: (hash: string) => void;
  /** テスト時に差し替え可能なストア（既定は createStore()） */
  store?: AppStore;
  /** view ごとのコールバック注入（テスト時に直接渡したいとき用） */
  viewOptions?: BuildViewsOptions;
  /** wiring 用の Chrome runtime（既定: createChromeRuntimeDeps）。null で wiring を無効化（テスト用） */
  runtime?: ChromeRuntimeDeps | null;
}

export interface AppHandle {
  /** イベントリスナー解除 + ストアサブスクライブ解除を行う */
  dispose: () => void;
  store: AppStore;
}

export function createLocationOptions(
  win: Window
): Pick<AppBootstrapOptions, 'getHash' | 'onHashChange' | 'setHash'> {
  return {
    getHash: () => win.location.hash,
    onHashChange: (listener) => {
      win.addEventListener('hashchange', listener);
      return () => win.removeEventListener('hashchange', listener);
    },
    setHash: (hash) => {
      win.location.hash = hash;
    },
  };
}

export function startApp(doc: Document, opts: AppBootstrapOptions): AppHandle {
  const store = opts.store ?? createStore();
  const runtime = opts.runtime === undefined ? createChromeRuntimeDeps() : opts.runtime;
  const status = doc.getElementById('app-status');
  const contextEl = doc.getElementById('app-context');
  const content = doc.getElementById('app-content');
  const sidebar = doc.querySelector('#app-sidebar nav');
  const homeLinkBtn = doc.getElementById('app-home-link') as HTMLButtonElement | null;
  const buildDateEl = doc.getElementById('app-build-date');
  if (buildDateEl) {
    buildDateEl.textContent = `build: ${__BUILD_DATE__}`;
  }
  /**
   * ガード判定付きナビゲーション。サイドバー / ホーム画面 / サービス層からの遷移すべてが
   * これを経由するので、前提条件を満たさないルートへは setHash を発行せず、
   * 代わりに理由を `#app-status` に表示する。
   */
  const navigate = (route: RouteName): void => {
    const guard = evaluateGuards(store.getState())[route];
    if (!guard.enabled) {
      if (status) {
        status.textContent = `${ROUTE_LABELS[route]}: ${guard.reason}`;
      }
      return;
    }
    opts.setHash(buildHash(route));
  };
  const viewOptions = opts.viewOptions ?? buildDefaultViewOptions(store, runtime, navigate);
  const views = buildViews(store, viewOptions);

  // ヘッダーのアプリタイトル: クリックで #/home へ戻す（docs/ui-flow.md §4）
  if (homeLinkBtn) {
    homeLinkBtn.addEventListener('click', () => navigate('home'));
  }
  const settingsLinkBtn = doc.getElementById('app-settings-link') as HTMLButtonElement | null;
  if (settingsLinkBtn) {
    settingsLinkBtn.addEventListener('click', () => navigate('settings'));
  }

  const render = (): void => {
    const route = parseRoute(opts.getHash());
    if (route !== store.getState().route) {
      store.setState((s) => ({ ...s, route,
        ...(route === 'draft' ? { queryOptimizationSetup: null } : {}),
      }));
    }
    const snapshot = store.getState();
    const guard = evaluateGuards(snapshot)[route];
    if (status) {
      const projectName = snapshot.project?.title ?? '(未選択)';
      status.textContent = `${ROUTE_LABELS[route]} / ${projectName}`;
    }
    if (contextEl) {
      contextEl.textContent = buildContextLabel(snapshot);
    }
    if (sidebar) {
      renderSidebar(sidebar as HTMLElement, route, navigate, snapshot);
    }
    if (content) {
      if (!guard.enabled) {
        // ハッシュ直変更や外部導線から未達ルートに入った場合の防御。
        // views[route] を描画せずに、理由を明示したプレースホルダを出す。
        renderGuardedPlaceholder(content as HTMLElement, route, guard.reason);
      } else {
        const ctx: ViewContext = { state: snapshot, navigate };
        views[route](content as HTMLElement, ctx);
      }
    }
  };

  // 起動時に chrome.storage から currentProject を取り込む（runtime が無い場合はスキップ）。
  // 再描画は hydrate 内の setState → store.subscribe(render) 経由で起きるため、
  // ここで .then(render) はしない（state が変わらないのに無条件再描画すると、
  // ユーザーのフォーム入力中の操作（file 選択等）を破棄してしまう）。
  if (runtime) {
    void hydrateCurrentProject(store, runtime);
  }

  render();
  const unlistenHash = opts.onHashChange(render);
  const unsubscribe = store.subscribe(render);

  return {
    store,
    dispose: () => {
      unlistenHash();
      unsubscribe();
    },
  };
}

/**
 * chrome.storage の currentProject をストアに反映し、
 * 既存プロジェクトがあれば Sheets から Protocol / ProtocolBlocks / FormulaVersions の
 * 最新行を読んで in-memory state を復元する。
 * Sheets API エラーはアプリ起動を妨げないが、握りつぶさず hydrateError に残して
 * home / protocol にエラーバナー（再試行付き）を出す（fix-plan 1-3）。
 * Sheets の後に、「下書きとして保存」のバックアップ（chrome.storage）があれば
 * 承認済みブロックより優先して blocksDraft へ復元する（fix-plan 1-2）。
 */
async function hydrateCurrentProject(store: AppStore, runtime: ChromeRuntimeDeps): Promise<void> {
  const current = await getCurrentProject(runtime.store);
  if (!current) {
    return;
  }
  store.setState((s) => (s.project?.projectId === current.projectId ? s : {
    ...s, project: current, queryOptimizationRun: null, queryOptimizationSetup: null,
  }));

  try {
    const [protocol, latestFormula] = await Promise.all([
      getLatestProtocol(current.spreadsheetId, runtime.google),
      getLatestFormulaVersion(current.spreadsheetId, runtime.google),
    ]);

    if (protocol) {
      const blocks = await getProtocolBlocksByVersion(
        current.spreadsheetId,
        protocol.version,
        runtime.google
      );
      store.setState((s) => ({
        ...s,
        currentProtocolVersion: protocol.version,
        protocolDraft: toProtocolDraft(protocol),
        // Sheets から読んだ確定済みプロトコルなので、protocolView は読み取り専用表示になる
        protocolDraftPersisted: true,
        blocksDraft: blocks.length > 0 ? toBlocksDraft(blocks, protocol.combinationExpression) : s.blocksDraft,
      }));
    }

    if (latestFormula) {
      store.setState((s) => ({
        ...s,
        currentFormulaVersionId: latestFormula.versionId,
        currentFormulaMarkdown: latestFormula.formulaMd,
        currentFormulaModel: latestFormula.model,
        currentFormulaCreatedBy: latestFormula.createdBy,
      }));
    }
    // 再試行で成功したときにバナーを消す
    store.setState((s) => (s.hydrateError === null ? s : { ...s, hydrateError: null }));
  } catch (err) {
    store.setState((s) => ({
      ...s,
      hydrateError: err instanceof Error ? err.message : String(err),
    }));
  }

  // 下書きバックアップの復元は Sheets 障害と独立に行う（chrome.storage のみ参照）。
  // 承認済みブロック（Sheets 由来）の後に上書きすることで、未承認の編集を優先させる。
  try {
    const backup = await getBlocksDraftBackup(current.projectId, runtime.store);
    if (backup) {
      store.setState((s) => ({
        ...s,
        blocksDraft: backup.draft,
        blocksDraftSavedAt: backup.savedAt,
      }));
    }
  } catch {
    // バックアップ読み込み失敗は起動を妨げない（下書きが無い扱いにする）
  }
}

function toProtocolDraft(protocol: Protocol): ProtocolDraft {
  return {
    frameworkType: protocol.frameworkType ?? 'custom',
    researchQuestion: protocol.researchQuestion,
    inclusionCriteria: protocol.inclusionCriteria ?? '',
    exclusionCriteria: protocol.exclusionCriteria ?? '',
    studyDesign: protocol.studyDesign ?? '',
    sourceType: protocol.sourceType,
    sourceFilename: protocol.sourceFilename,
    rawTextRef: protocol.rawTextRef,
    rawTextPreview: protocol.rawTextPreview ?? '',
    rawTextInline: protocol.rawTextInline,
  };
}

function toBlocksDraft(blocks: ProtocolBlock[], combinationExpression: string): BlocksDraft {
  return {
    blocks: blocks.map((b) => ({
      blockLabel: b.blockLabel,
      description: b.description,
      aiGenerated: b.aiGenerated,
      note: b.note ?? '',
    })),
    combinationExpression,
  };
}

/**
 * runtime が利用可能なときの既定 view options。
 * - protocol.onSubmit → submitProtocol（LLM 呼び出し）→ blocksDraft 更新 → /blocks ナビ
 * - blocks.onApprove → approveBlocks（Sheets 書き込み）→ /seeds ナビ（シード論文収集を先行させる）
 * - blocks.onSaveDraft → 下書きバックアップを chrome.storage へ保存（リロード後 hydrate で復元）
 */
function buildDefaultViewOptions(
  store: AppStore,
  runtime: ChromeRuntimeDeps | null,
  navigate: (route: RouteName) => void
): BuildViewsOptions {
  if (!runtime) {
    return {};
  }
  const llmFactoryPromise: Promise<Awaited<ReturnType<typeof buildLlmProviderFactory>>> | null = null;
  const llmFactoryDepsBase = (): Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'> => ({
    google: runtime.google,
    store: runtime.store,
    onCostAccumulate: (costUsd) => {
      store.setState((s) => ({
        ...s,
        cumulativeCostUsd: (s.cumulativeCostUsd ?? 0) + costUsd,
      }));
    },
  });
  return {
    home: {
      onOpenPopup: () => {
        // 別プロジェクトへ切り替えたいユーザーを Popup に誘導する。
        // 拡張コンテキストでは chrome.tabs/chrome.runtime が存在する前提。
        chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
      },
      onRetryHydrate: () => {
        void hydrateCurrentProject(store, runtime);
      },
    },
    protocol: {
      onSubmit: async (input: ProtocolSubmissionInput) => {
        await runProtocolSubmit(store, runtime, llmFactoryDepsBase(), llmFactoryPromise, input);
        // 再解析でブロックが作り直されたので、旧ブロックの下書きバックアップは破棄する
        await clearBlocksDraftBackup(runtime.store);
        store.setState((s) =>
          s.blocksDraftSavedAt === null ? s : { ...s, blocksDraftSavedAt: null }
        );
        navigate('blocks');
      },
      onRetryHydrate: () => {
        void hydrateCurrentProject(store, runtime);
      },
      // 改訂保存（既存ブロック維持）: extract-protocol で RQ 等を再抽出しつつ、
      // ブロックは改訂前の承認済み定義へ戻してから即時 approve する。
      // approveBlocks が新 Protocol.version の追記とブロックのコピー追記を行う（§4.2）。
      onReviseKeepBlocks: async (input: ProtocolSubmissionInput) => {
        const prevBlocks = store.getState().blocksDraft;
        await runProtocolSubmit(store, runtime, llmFactoryDepsBase(), llmFactoryPromise, input);
        if (prevBlocks) {
          store.setState((s) => ({ ...s, blocksDraft: prevBlocks }));
        }
        await runApprove(store, runtime);
      },
      onListVersions: async () => {
        const project = store.getState().project;
        /* istanbul ignore if -- protocol view は project 選択済みでしか onListVersions を呼ばない */
        if (!project) {
          return [];
        }
        return listProtocols(project.spreadsheetId, runtime.google);
      },
    },
    blocks: {
      // 承認前の編集を chrome.storage へ退避する（リロードで消える blocksDraft の保険。fix-plan 1-2）
      onSaveDraft: async (draft) => {
        const project = store.getState().project;
        if (!project) {
          throw new Error('プロジェクトが選択されていません');
        }
        const backup = await saveBlocksDraftBackup(project.projectId, draft, runtime.store);
        store.setState((s) => ({ ...s, blocksDraftSavedAt: backup.savedAt }));
      },
      onApprove: async () => {
        await runApprove(store, runtime);
        navigate('seeds');
      },
    },
    draft: {
      onPrepareOptimization: (retry) => prepareQueryOptimization(store, runtime, retry),
      onOptimizationSettingsInput: (values) => {
        store.setStateSilently((s) => !s.queryOptimizationSetup ? s : {
          ...s, queryOptimizationSetup: { ...s.queryOptimizationSetup, ...values },
        });
      },
      onOptimize: (settings, resumeRunId) => runOptimizeQuery(store, runtime, llmFactoryDepsBase(), settings, resumeRunId),
      onAdoptOptimization: () => adoptQueryOptimization({ store, google: runtime.google }),
      onEditOptimization: () => { if (editQueryOptimization(store)) navigate('edit'); },
      onBlocksFromOptimization: () => navigate('blocks'),
      onDecideOutsideCandidate: (pmid, decision) => runDecideOutsideCandidate(store, runtime, pmid, decision),
      onReadjustOptimization: () => runReadjustOptimization(store, runtime, llmFactoryDepsBase()),
      // 保留候補（issue #172）の 3 つの出口。ゲート・除外済みの判定はサービス側で行う。
      onAdoptHeldOptimizationCandidate: (candidateId) => adoptHeldOptimizationCandidate({ store, google: runtime.google }, candidateId),
      onReadjustHeldOptimizationCandidate: (candidateId) =>
        runReadjustFromHeldOptimizationCandidate(store, runtime, llmFactoryDepsBase(), candidateId),
      onRejectHeldOptimizationCandidate: (candidateId) => rejectHeldOptimizationCandidate(store, runtime, candidateId),
      onUndoRejectHeldOptimizationCandidate: (candidateId) => undoHeldOptimizationCandidateRejection(store, runtime, candidateId),
      onStopOptimization: () => {
        store.setState((s) => s.queryOptimizationRun?.status !== 'running' ? s : {
          ...s, queryOptimizationRun: { ...s.queryOptimizationRun, stopRequested: true },
        });
      },
      // 「最初から作り直す」（旧「生成して検証する」）= 生成 → 検証 を 1 アクションで連結する。
      // 進捗・エラー・ブロックごとのヒット数は store.draftRun で管理する（LLM コスト集計の
      // setState による全ビュー再描画でローカル DOM の進捗表示が消えるため）。view は描画専任。
      onGenerate: async () => runGenerateAndValidate(store, runtime, llmFactoryDepsBase()),
      // 「検証のみ再実行」（fix-plan 2-2）: 生成済みの式を LLM を呼ばずに再検証する。
      onRevalidate: async () => runRevalidateOnly(store, runtime, llmFactoryDepsBase()),
      // 過大ヒット時の絞り込みフィルタ承認（fix-plan 2-1）。承認された候補だけ式へ追記する。
      onApplyExcessFilters: async (approved: ExcessFilterCandidate[]) =>
        runApplyExcessFilters(store, runtime, llmFactoryDepsBase(), approved),
      onDismissExcessFilters: () => {
        store.setState((s) => ({ ...s, excessFilterProposal: null }));
      },
      // 結果は store に保存する。再描画後も draft view が state から復元できるようにするため。
      onAnalyzeMissed: async (
        missedPmids: string[]
      ): Promise<AnalyzeMissedSeedsResult> => {
        const result = await runAnalyzeMissedSeeds(
          store,
          runtime,
          llmFactoryDepsBase(),
          missedPmids
        );
        store.setState((s) => ({
          ...s,
          missedAnalysis:
            s.currentFormulaVersionId === null
              ? null
              : { formulaVersionId: s.currentFormulaVersionId, result },
        }));
        return result;
      },
    },
    export: {
      onExport: async (): Promise<ExportResult> => runExport(store, runtime),
    },
    seeds: {
      onIngest: async (input: IngestInput): Promise<IngestSummary> =>
        runIngestSeeds(store, runtime, input),
      onListSeeds: async (): Promise<SeedPaperWithRow[]> => runListSeeds(store, runtime),
      onSetEnabled: async (
        rowIndex: number,
        seed: SeedPaper,
        enabled: boolean
      ): Promise<SeedPaper> => runSetSeedEnabled(store, runtime, rowIndex, seed, enabled),
      onDelete: async (rowIndex: number, seed: SeedPaper): Promise<SeedPaper> =>
        runInvalidateSeed(store, runtime, rowIndex, seed),
      onRetry: async (pmid: string): Promise<IngestSummary> =>
        runRetrySeed(store, runtime, pmid),
      onFillPmid: async (_rowIndex: number, pmid: string): Promise<IngestSummary> =>
        runFillPmidForRisRow(store, runtime, pmid),
      onFetchArticle: async (pmid: string): Promise<EfetchArticle | null> =>
        runFetchArticle(store, runtime, pmid),
    },
    history: {
      onList: async (): Promise<FormulaVersion[]> => runListHistory(store, runtime),
      onLoad: (version) => {
        store.setState((s) => ({
          ...s,
          currentProtocolVersion: version.protocolVersion,
          currentFormulaVersionId: version.versionId,
          currentFormulaMarkdown: version.formulaMd,
          currentFormulaModel: version.model,
          currentFormulaCreatedBy: version.createdBy,
        }));
      },
    },
    edit: {
      // 進捗・確認メッセージ・エラーは store.formulaSave 経由で反映される（issue #42 対応）
      onSave: async (input: SaveEditedFormulaInput): Promise<void> =>
        runSaveEditedFormula(store, runtime, input),
      // 結果は store.blockImprovement 経由で反映される（進捗・提案・エラーとも）。
      // view はこの Promise の解決値を使わない（expand の onFetch と同じ思想。issue #39 対応）。
      onImproveBlock: async (input: RequestBlockImprovementInput): Promise<void> =>
        runImproveBlock(store, runtime, llmFactoryDepsBase(), input),
      onGetImproveContext: (blockId, siblings): Promise<BlockImprovementContext | null> =>
        getBlockImprovementContext(blockId, siblings, { store, google: runtime.google }),
      // ブロック・インスペクタ（src/app/views/blockInspector.ts。requirements: 検索式編集の
      // MeSH/フリーワード可視化）の計測 callback。既存の NCBI 呼び出し経路をそのまま再利用する
      // （新しい fetch 経路は増やさない。issue #58 chunk 3a）。
      // - onCountHits は esearch（src/lib/ncbi/eutils.ts）経由なので、発行前トークンバケット
      //   （issue #59・EutilsDeps.rateLimiter 未指定時は sharedEutilsRateLimiters に解決される）
      //   を通る。
      // - onFetchMeshTrees（db=mesh の esearch+esummary。src/lib/ncbi/mesh.ts）と
      //   onFetchMeshChildren / onFetchMeshLabels（MeSH RDF SPARQL。src/lib/ncbi/meshRdf.ts）は
      //   retryWithBackoff のみでレート制御が無い（issue #59 の対象は eutils.ts の
      //   esearch/efetchArticles のみで、この 2 ファイルは元から対象外）。本チャンクは配線のみで
      //   この 2 ファイルには手を入れていないため、この既存ギャップはそのまま残る。
      onCountHits: async (expression: string): Promise<number> => {
        const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
        return (await esearch(expression, eutils, { retmax: 0 })).count;
      },
      onFetchMeshTrees: async (descriptors: string[]) => {
        const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
        const treeByDescriptor = await fetchMeshTreeNumbers(descriptors, eutils);
        return Array.from(treeByDescriptor.trees, ([descriptor, treeNumbers]) => ({
          descriptor,
          treeNumbers,
        }));
      },
      onFetchMeshChildren: async (treeNumber: string) => {
        const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
        return fetchMeshChildren(treeNumber, eutils);
      },
      onFetchMeshLabels: async (treeNumbers: string[]) => {
        const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
        return fetchMeshLabels(treeNumbers, eutils);
      },
      // 編集中 md を store（formulaEditDraft）へ反映する。鉛筆の手編集 / AI 提案 accept の
      // 両方から呼ばれる（editView.ts の FormulaEditor.setMd）。
      onDraftChange: (markdown: string) => {
        const formulaVersionId = store.getState().currentFormulaVersionId;
        if (formulaVersionId === null && !store.getState().formulaEditDraft) return;
        // md を触った時点で直前の保存ステータス（保存しました / エラー）は現在の内容を
        // 説明しなくなるので消す。未保存の編集があることが見た目でも分かる。
        store.setState((s) => ({
          ...s,
          formulaEditDraft: {
            ...(s.formulaEditDraft?.formulaVersionId === formulaVersionId ? s.formulaEditDraft : {}),
            formulaVersionId, markdown,
          },
          formulaSave: null,
        }));
      },
      onClearImprovement: () => {
        // 提案（blockImprovement）を引っ込めるタイミング（accept / reject / manualEditApply /
        // AI パネルの再クリック close）は、そのブロックの「今回の提案ラウンド」が終わる瞬間
        // でもある。手編集ドラフト（blockImprovementManualEditDraft。issue #92 B-3）を
        // ここで一緒に消しておかないと、同じブロックで次に AI 改善を開いたとき、新しい提案の
        // 初期値（result.proposedExpression）ではなく前ラウンドの手編集テキストが復元されてしまう
        // （blockImprovementInstruction を送信成功時にクリアする runImproveBlock と同じ理由）。
        store.setState((s) => ({
          ...s,
          blockImprovement: null,
          blockImprovementManualEditDraft: null,
        }));
      },
      // 編集メモを store（formulaEditNote）へ反映する。打鍵のたび（input）に呼ばれるが、
      // setStateSilently（購読者に通知しない＝再描画を起こさない）で書き込むため、
      // 毎回の全ビュー再描画は起きない（store.ts の FormulaEditNote / setStateSilently
      // doc コメント参照。PR #43 の回帰対応）。
      onNoteChange: (note: string) => {
        const formulaVersionId = store.getState().currentFormulaVersionId;
        // 保存版がなくても、対応する編集下書きがあれば入力を保持する。
        if (formulaVersionId === null && !store.getState().formulaEditDraft) return;
        store.setStateSilently((s) => ({ ...s, formulaEditNote: { formulaVersionId, note } }));
      },
      // 「AI への指示」欄（初回・追加とも）を store（blockImprovementInstruction）へ反映する。
      // onNoteChange と同じ理由・同じ使い方（setStateSilently で再描画を起こさない）。
      onInstructionChange: (blockId: string, instruction: string) => {
        const formulaVersionId = store.getState().currentFormulaVersionId;
        // 保存版がなくても、対応する編集下書きがあれば入力を保持する。
        if (formulaVersionId === null && !store.getState().formulaEditDraft) return;
        store.setStateSilently((s) => ({
          ...s,
          blockImprovementInstruction: { formulaVersionId, blockId, instruction },
        }));
      },
      // 「AI への指示」欄を開く時点で store の最新値を読み直す（issue #92 C-3）。
      // resolveInstructionDraft（editView.ts）と同じ解決ロジックをそのまま再利用し、
      // 描画時スナップショットとの解決経路のズレが生まれないようにする。
      onGetInstructionDraft: (blockId: string) => resolveInstructionDraft(store.getState(), blockId),
      // 「提案を編集してから採用する」欄（issue #90）の未送信テキストを store
      // （blockImprovementManualEditDraft）へ反映する（issue #92 B-3）。onNoteChange /
      // onInstructionChange と同じ理由・同じ使い方（setStateSilently で再描画を起こさない）。
      onManualEditChange: (blockId: string, expression: string) => {
        const formulaVersionId = store.getState().currentFormulaVersionId;
        // 保存版がなくても、対応する編集下書きがあれば入力を保持する。
        if (formulaVersionId === null && !store.getState().formulaEditDraft) return;
        store.setStateSilently((s) => ({
          ...s,
          blockImprovementManualEditDraft: { formulaVersionId, blockId, expression },
        }));
      },
    },
    expand: {
      // 進捗・取得結果は store.expandRun 経由で反映される（draft の onGenerate と同じ思想）
      onFetch: async (options): Promise<void> =>
        runFetchBoundary(store, runtime, llmFactoryDepsBase(), options.insideStrategy),
      // チェックボックスの状態。再描画を起こさない silent 更新（打鍵で画面を作り直さない）
      onInsideStrategyChange: (strategy) =>
        store.setStateSilently((s) =>
          s.expandInsideStrategy === strategy ? s : { ...s, expandInsideStrategy: strategy }
        ),
      onDecide: async (input: RecordDecisionInput): Promise<RecordDecisionResult> =>
        runRecordDecision(store, runtime, input),
      onRoundComplete: async (): Promise<ValidationSummary> => runValidate(store, runtime),
      onRequestSpreadsheetAccess: async (spreadsheetId): Promise<PickerGrantResult> => {
        const result = await chrome.runtime.sendMessage({
          type: PICKER_GRANT_MESSAGE,
          spreadsheetId,
          openAppOnSuccess: false,
        }) as PickerGrantResult | undefined;
        return result ?? { status: 'failed', message: '許可フローを開始できませんでした。' };
      },
      onOpenSpreadsheet: async (spreadsheetId) => {
        const email = await getCurrentUserEmail(runtime.profile).catch(() => null);
        try {
          await chrome.tabs.create({ url: buildSpreadsheetUrl(spreadsheetId, email) });
        } catch {
          console.warn('[sr-query-builder] スプレッドシートのタブを開けませんでした');
        }
      },
    },
    settings: {
      readKey: (key) => runtime.store.read<string>(key),
      writeKey: (key, value) => runtime.store.write({ [key]: value }),
      removeKey: (key) => chrome.storage.local.remove(key),
    },
  };
}

async function runListHistory(
  store: AppStore,
  runtime: ChromeRuntimeDeps
): Promise<FormulaVersion[]> {
  const project = store.getState().project;
  /* istanbul ignore if -- history view は project 選択済みでしか onList を呼ばない */
  if (!project) {
    return [];
  }
  return listFormulaVersions(project.spreadsheetId, runtime.google);
}

/**
 * 「新バージョンとして保存」（#/edit）の実行状態を store.formulaSave で管理する。
 *
 * saveEditedFormula は完了時に currentFormulaVersionId / currentFormulaMarkdown の setState を
 * 起こし、それが全ビュー再描画を誘発する。確認メッセージ・エラーをローカル DOM（旧コードは
 * `.then()` で `p.edit__status` に書き込んでいた）に置くと、この再描画で要素ごと作り直されて
 * 消えてしまい、保存が成功しているのに「押しても何も起きていない」ように見える（issue #42）。
 * runImproveBlock / runFetchBoundary と同じく store 経由で状態遷移させる。
 * view は解決値を使わないため、ここでは例外を投げず常に resolve する。
 */
async function runSaveEditedFormula(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  input: SaveEditedFormulaInput
): Promise<void> {
  if (store.getState().formulaSave?.status === 'saving') {
    // 再描画タイミング次第でボタンが二度押せた場合の保険
    return;
  }
  const formulaVersionId = store.getState().currentFormulaVersionId;
  if (formulaVersionId === null && !store.getState().formulaEditDraft) return;
  store.setState((s) => ({
    ...s,
    formulaSave: { formulaVersionId, status: 'saving', error: null },
  }));
  try {
    const result: SaveEditedFormulaResult = await saveEditedFormula(input, {
      google: runtime.google,
      store,
    });
    // 保存成功で currentFormulaVersionId は採番された新しい版へ移っているため、
    // formulaSave もその版で持つ（stale 判定が一致し、確認メッセージが残る）。
    store.setState((s) => ({
      ...s,
      formulaSave: { formulaVersionId: result.versionId, status: 'saved', error: null },
    }));
  } catch (err) {
    // 失敗時は current が保存前の版のままなので、押下時の版で保持すれば表示される。
    store.setState((s) => ({
      ...s,
      formulaSave: {
        formulaVersionId,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      },
    }));
  }
}

/**
 * ブロック単位 AI 改善（#/edit）の実行状態を store.blockImprovement で管理する。
 * requestBlockImprovement（LLM 呼び出し）の完了時に走る LLM コスト集計（cumulativeCostUsd）の
 * setState による全ビュー再描画でも進捗・提案・エラーが消えないよう、
 * runFetchBoundary / runGenerateAndValidate と同じく store 経由で状態遷移する（issue #39 対応）。
 * view は解決値を使わないため、ここでは例外を投げず常に resolve する
 * （呼び出し側の editView.ts は `.catch()` を持たない fire-and-forget 呼び出しのため）。
 */
async function runImproveBlock(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  baseDeps: Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'>,
  input: RequestBlockImprovementInput
): Promise<void> {
  const project = store.getState().project;
  /* istanbul ignore if -- edit view は project 選択済みでしか onImproveBlock を呼ばない */
  if (!project) {
    return;
  }
  const formulaVersionId = store.getState().currentFormulaVersionId;
  // 自動調整から渡した未保存の下書きも AI 改善の対象にする。
  if (formulaVersionId === null && !store.getState().formulaEditDraft) return;
  // このリクエストで使った history（＝これより前の turn。issue #90）。running/error でも
  // 保持しておく（redo のやり直し UI が失敗直後にも同じ history を再利用できるように）。
  const historyBeforeThisTurn = input.history ?? [];
  store.setState((s) => ({
    ...s,
    blockImprovement: {
      formulaVersionId,
      blockId: input.blockId,
      status: 'running',
      result: null,
      error: null,
      history: historyBeforeThisTurn,
    },
  }));
  try {
    const factory: LlmProviderFactory = await buildLlmProviderFactory({
      ...baseDeps,
      llmLogFolderId: project.driveFolderId,
      spreadsheetId: project.spreadsheetId,
    });
    const result = await requestBlockImprovement(input, {
      store,
      google: runtime.google,
      llmFactory: factory,
    });
    store.setState((s) => ({
      ...s,
      blockImprovement: {
        formulaVersionId,
        blockId: input.blockId,
        status: 'ready',
        result,
        error: null,
        // 今回の turn（指示 → 提案）を積む（issue #90）。次の「指示を追加してやり直す」は
        // この history をそのまま onImproveBlock へ渡し、会話を継続する。
        history: [
          ...historyBeforeThisTurn,
          {
            instruction: input.instruction ?? '',
            proposedExpression: result.proposedExpression,
            rationale: result.rationale,
          },
        ],
      },
      // 送信成功時に「AI への指示」欄の未送信テキストをクリアする（issue #92 B-4）。
      // クリアしないと、次に renderProposal が「指示を追加してやり直す」欄の初期値として
      // 今しがた実行済みの指示を復元してしまい、そのまま送信すると同じ指示が新しい turn
      // として二重に history へ積まれる（テスターが実際に踏んだ回帰）。送信は非同期
      // （fire-and-forget）なので、この間に別ブロックの指示欄を触っている場合に備えて
      // formulaVersionId・blockId が今回の送信と一致するときだけクリアする（一致しなければ
      // それは別ブロックの未送信ドラフトなので触らない）。
      // 失敗時（catch 節）はあえてクリアしない: 送信が失敗しただけなら、ユーザーが打った
      // 指示は再送信のために残しておくほうが親切なため。
      blockImprovementInstruction:
        s.blockImprovementInstruction !== null &&
        s.blockImprovementInstruction.formulaVersionId === formulaVersionId &&
        s.blockImprovementInstruction.blockId === input.blockId
          ? null
          : s.blockImprovementInstruction,
      // 「提案を編集してから採用する」欄（issue #92 B-3）も同じ理由でクリアする。クリアしないと
      // 「指示を追加してやり直す」で新しい提案が届いたとき、renderProposal が新しい
      // result.proposedExpression ではなく前 turn の手編集テキストを初期値にしてしまう。
      blockImprovementManualEditDraft:
        s.blockImprovementManualEditDraft !== null &&
        s.blockImprovementManualEditDraft.formulaVersionId === formulaVersionId &&
        s.blockImprovementManualEditDraft.blockId === input.blockId
          ? null
          : s.blockImprovementManualEditDraft,
    }));
  } catch (err) {
    store.setState((s) => ({
      ...s,
      blockImprovement: {
        formulaVersionId,
        blockId: input.blockId,
        status: 'error',
        result: null,
        error: err instanceof Error ? err.message : String(err),
        history: historyBeforeThisTurn,
      },
    }));
  }
}

/**
 * 「境界事例を取得」パイプライン。fetchBoundaryCandidates の進捗（プロトコル取得 →
 * PubMed 検索 → 重複除去 → 候補論文取得 → AI 選定）と取得結果を、すべて store.expandRun
 * 経由で更新する。最後の AI 選定（LLM）完了時に走る LLM コスト集計の setState による
 * 全ビュー再描画でも進捗・候補が消えないよう、ローカル DOM ではなく store に保持する。
 */
async function runFetchBoundary(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  baseDeps: Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'>,
  insideStrategy: InsideStrategy
): Promise<void> {
  if (store.getState().expandRun?.status === 'running') {
    // 再描画タイミング次第でボタンが二度押せた場合の保険
    return;
  }
  store.setState((s) => ({
    ...s,
    expandRun: {
      status: 'running',
      step: 'protocol',
      startedAtMs: Date.now(),
      error: null,
      errorKind: null,
      apiWait: null,
      result: null,
    },
  }));

  const project = store.getState().project;
  /* istanbul ignore if -- expand view は project + formula 有り時しか onFetch を呼ばない */
  if (!project) {
    setExpandRunError(store, new Error('プロジェクトが選択されていません'));
    return;
  }
  const setApiWait = (apiWait: ExpandApiWait | null): void => {
    store.setState((s) =>
      s.expandRun === null || s.expandRun.status !== 'running' || s.expandRun.apiWait === apiWait
        ? s
        : { ...s, expandRun: { ...s.expandRun, apiWait } }
    );
  };

  try {
    const factory: LlmProviderFactory = await buildLlmProviderFactory({
      ...baseDeps,
      llmLogFolderId: project.driveFolderId,
      spreadsheetId: project.spreadsheetId,
      // AI は試行回数を通知しない（withRetry の 'retry' は「何回目か」を持たず、同じ
      // ファクトリを全 skill が共有するので呼び出し境界も観測できない）。待っている事実だけ出す。
      onRequestState: (state) =>
        setApiWait(
          state === 'retry'
            ? { source: 'AI', kind: 'retry', attempt: null, maxAttempts: null, waitMs: null }
            : null
        ),
    });
    const eutils = withExpandApiWait(
      await buildEutilsDeps({ google: runtime.google, store: runtime.store }),
      setApiWait
    );
    const result = await fetchBoundaryCandidates({
      google: runtime.google,
      eutils,
      store,
      llmFactory: factory,
      insideStrategy,
      onProgress: (step) => {
        store.setState((s) =>
          s.expandRun === null ? s : { ...s, expandRun: { ...s.expandRun, step } }
        );
      },
    });
    store.setState((s) => ({
      ...s,
      expandRun: {
        status: 'ready',
        step: 'done',
        startedAtMs: s.expandRun?.startedAtMs ?? Date.now(),
        error: null,
        errorKind: null,
        apiWait: null,
        result,
      },
    }));
  } catch (err) {
    setExpandRunError(store, err);
  }
}

/** expandRun を失敗状態にする（失敗した段階 step は保持して原因を読み取れるようにする） */
function setExpandRunError(store: AppStore, err: unknown): void {
  store.setState((s) => ({
    ...s,
    expandRun: {
      status: 'error',
      step: s.expandRun?.step ?? 'protocol',
      startedAtMs: s.expandRun?.startedAtMs ?? Date.now(),
      error: err instanceof Error ? err.message : String(err),
      errorKind: classifyApiError(err),
      apiWait: null,
      result: null,
    },
  }));
}

async function runRecordDecision(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  input: RecordDecisionInput
): Promise<RecordDecisionResult> {
  const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
  // Protocol.created_by と同じ経路（chrome.identity 由来）で判定者メールを取得する
  const userEmail = await getCurrentUserEmail(runtime.profile);
  return recordDecision(input, {
    google: runtime.google,
    eutils,
    store,
    userEmail,
    // recordDecision は LLM を呼ばないので forPurpose は呼ばれない（guard）
    llmFactory: { forPurpose: neverCalledProvider, model: 'unused' },
  });
}

/* istanbul ignore next -- recordDecision は LLM を呼ばないのでこの関数は呼ばれない */
function neverCalledProvider(): never {
  throw new Error('llmFactory.forPurpose should not be called in recordDecision');
}

async function runIngestSeeds(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  input: IngestInput
): Promise<IngestSummary> {
  const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
  return ingestSeeds(input, {
    google: runtime.google,
    eutils,
    store,
  });
}

async function runListSeeds(
  store: AppStore,
  runtime: ChromeRuntimeDeps
): Promise<SeedPaperWithRow[]> {
  const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
  return listSeeds({ google: runtime.google, eutils, store });
}

async function runSetSeedEnabled(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  rowIndex: number,
  seed: SeedPaper,
  enabled: boolean
): Promise<SeedPaper> {
  const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
  return setSeedEnabled(rowIndex, seed, enabled, { google: runtime.google, eutils, store });
}

async function runInvalidateSeed(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  rowIndex: number,
  seed: SeedPaper
): Promise<SeedPaper> {
  const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
  return invalidateSeed(rowIndex, seed, { google: runtime.google, eutils, store });
}

async function runRetrySeed(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  pmid: string
): Promise<IngestSummary> {
  const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
  return retrySeed(pmid, { google: runtime.google, eutils, store });
}

async function runFillPmidForRisRow(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  pmid: string
): Promise<IngestSummary> {
  const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
  return fillPmidForRisRow(pmid, { google: runtime.google, eutils, store });
}

async function runFetchArticle(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  pmid: string
): Promise<EfetchArticle | null> {
  const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
  const articles = await efetchArticles([pmid], eutils);
  return articles[0] ?? null;
}

async function runValidate(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  onProgress?: (progress: ValidationProgress) => void,
  precomputedBlockHits?: ReadonlyMap<string, number>
): Promise<ValidationSummary> {
  const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
  return runValidation({
    google: runtime.google,
    eutils,
    store,
    onProgress,
    precomputedBlockHits,
  });
}

async function runAnalyzeMissedSeeds(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  baseDeps: Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'>,
  missedPmids: string[]
): Promise<AnalyzeMissedSeedsResult> {
  const project = store.getState().project;
  /* istanbul ignore if -- validate view は project + 検証結果有り時しか onAnalyzeMissed を呼ばない */
  if (!project) {
    throw new Error('プロジェクトが選択されていません');
  }
  const factory = await buildLlmProviderFactory({
    ...baseDeps,
    llmLogFolderId: project.driveFolderId,
    spreadsheetId: project.spreadsheetId,
  });
  const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
  return analyzeMissedSeeds({
    eutils,
    store,
    llmFactory: factory,
    missedPmids,
  });
}

async function runProtocolSubmit(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  baseDeps: Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'>,
  _llmFactoryPromise: unknown,
  input: ProtocolSubmissionInput
): Promise<void> {
  const project = store.getState().project;
  /* istanbul ignore if -- project 未選択時はそもそも protocol view が出ない */
  if (!project) {
    return;
  }
  // logs/llm の Drive フォルダ ID は要件 §3.3 で `{drive_folder_id}/logs/llm/` に置く。
  // 取得には Drive 検索が必要だが、MVP では project トップフォルダ直下に保存する暫定運用。
  const factory = await buildLlmProviderFactory({
    ...baseDeps,
    llmLogFolderId: project.driveFolderId,
    spreadsheetId: project.spreadsheetId,
  });
  const provider = factory.forPurpose('extract_protocol');
  // .docx 提出時に extractor 未指定なら既定実装（fflate ベース）を補う。
  // ここは DI 配線層なので既定値の注入はここで行い、テスト等で明示的に
  // 別の extractor を渡したい呼び出し側の余地は残す（上書きしない）。
  const resolvedInput =
    input.sourceType === 'docx' && !input.docxExtractor
      ? { ...input, docxExtractor: fflateDocxExtractor }
      : input;
  await submitProtocol(resolvedInput, { store, provider });
}

async function runApprove(store: AppStore, runtime: ChromeRuntimeDeps): Promise<void> {
  await approveBlocks({ google: runtime.google, profile: runtime.profile, store });
  // 承認済みになったので下書きバックアップ（未承認フラグ）は破棄する
  await clearBlocksDraftBackup(runtime.store);
  store.setState((s) => (s.blocksDraftSavedAt === null ? s : { ...s, blocksDraftSavedAt: null }));
}

/** 設定・シード件数は store に復元し、遅れて戻った準備結果も所有権を確認する。 */
async function prepareQueryOptimization(store: AppStore, runtime: ChromeRuntimeDeps, retry = false): Promise<void> {
  const project = store.getState().project;
  if (!project || (!retry && store.getState().queryOptimizationSetup?.projectId === project.projectId)) return;
  const loading = {
    projectId: project.projectId, status: 'loading' as const,
    maxHits: String(DEFAULT_QUERY_OPTIMIZATION_SETTINGS.maxHits),
    maxIterations: String(DEFAULT_QUERY_OPTIMIZATION_SETTINGS.maxIterations),
    seedCount: null, error: null,
  };
  store.setState((s) => ({ ...s, queryOptimizationSetup: loading }));
  let checkpoint: Awaited<ReturnType<typeof getQueryOptimizationCheckpoint>> = null;
  try {
    const [settingsResult, seedsResult, checkpointResult] = await Promise.allSettled([
      getQueryOptimizationSettings(project.projectId, runtime.store),
      listSeedPapers(project.spreadsheetId, runtime.google),
      getQueryOptimizationCheckpoint(project.projectId, runtime.store),
    ]);
    if (checkpointResult.status === 'fulfilled') checkpoint = checkpointResult.value;
    else throw checkpointResult.reason;
    if (settingsResult.status === 'rejected') throw settingsResult.reason;
    if (seedsResult.status === 'rejected') throw seedsResult.reason;
    const settings = settingsResult.value;
    const seeds = seedsResult.value;
    const seedPmids = [...new Set(seeds.filter(isSeedEligibleForValidation)
      .map((seed) => seed.pmid).filter((pmid): pmid is string => pmid !== null))];
    const seedCount = seedPmids.length;
    store.setState((s) => s.project?.projectId !== project.projectId || s.queryOptimizationSetup !== loading ? s : {
      ...s, queryOptimizationSetup: { ...loading, status: 'ready', seedCount, seedPmids, checkpoint,
        maxHits: String(settings?.maxHits ?? DEFAULT_QUERY_OPTIMIZATION_SETTINGS.maxHits),
        maxIterations: String(settings?.maxIterations ?? DEFAULT_QUERY_OPTIMIZATION_SETTINGS.maxIterations),
      },
    });
  } catch (err) {
    store.setState((s) => s.project?.projectId !== project.projectId || s.queryOptimizationSetup !== loading ? s : {
      ...s, queryOptimizationSetup: { ...loading, checkpoint, status: 'error', error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** 自動調整の候補は実行状態だけに保持する。各非同期境界で run の所有権を確認する。 */
export async function runOptimizeQuery(
  store: AppStore, runtime: ChromeRuntimeDeps,
  baseDeps: Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'>,
  settings: QueryOptimizationSettings,
  resumeRunId?: string,
  startingFormula?: PubmedFormula
): Promise<void> {
  if (heldRejectionWrites.has(store)) await heldRejectionWrites.get(store);
  const state = store.getState();
  if (state.queryOptimizationRun?.status === 'running' || state.queryOptimizationRun?.save?.status === 'saving'
    || state.draftRun?.status === 'running') return;
  const project = state.project;
  if (!project) return;
  const projectId = project.projectId;
  const fixedSettings = { ...settings };
  const setupError = (error: string): void => {
    store.setState((s) => s.project?.projectId !== projectId ? s : { ...s,
      queryOptimizationSetup: { projectId, status: 'ready',
        maxHits: String(fixedSettings.maxHits), maxIterations: String(fixedSettings.maxIterations),
        seedCount: null, ...s.queryOptimizationSetup, error },
    });
  };
  const invalid = validateQueryOptimizationSettings(fixedSettings);
  if (invalid) { setupError(invalid); return; }
  const checkpoint = state.queryOptimizationSetup?.checkpoint;
  const resume = resumeRunId && checkpoint?.runId === resumeRunId && checkpoint.projectId === projectId
    ? getQueryOptimizationResumeAvailability(checkpoint,
      state.protocolDraft && state.protocolDraftPersisted && state.blocksDraft && state.queryOptimizationSetup?.seedPmids
        ? createQueryOptimizationInputIdentity(state.protocolDraft, state.blocksDraft,
          state.queryOptimizationSetup.seedPmids, fixedSettings.maxHits) : null) : null;
  if (resumeRunId && !resume?.available) {
    setupError(resume && !resume.available ? resume.reason : '再開する中断記録が見つかりません。');
    return;
  }
  const runId = newUuid();
  const owns = (s: AppState): boolean => s.project?.projectId === projectId
    && s.queryOptimizationRun?.projectId === projectId && s.queryOptimizationRun.runId === runId
    && s.queryOptimizationRun.status === 'running';
  const update = (patch: Partial<NonNullable<AppState['queryOptimizationRun']>>): void => {
    store.setState((s) => !owns(s) || !s.queryOptimizationRun ? s : {
      ...s, queryOptimizationRun: { ...s.queryOptimizationRun, ...patch },
    });
  };
  const publisher = createOptimizationProgressPublisher(store, owns);
  const shouldStop = (): boolean => !owns(store.getState()) || !!store.getState().queryOptimizationRun?.stopRequested;
  const check = (): void => { if (shouldStop()) throw new QueryOptimizationStopError('user_stop'); };
  store.setState((s) => ({ ...s,
    queryOptimizationSetup: s.queryOptimizationSetup ? { ...s.queryOptimizationSetup, error: null } : null,
    queryOptimizationRun: {
    status: 'running', projectId, runId, ...fixedSettings,
    maxIterations: resume?.available ? resume.remaining.evaluatedTrials : fixedSettings.maxIterations, seedCount: null,
    startedAtMs: Date.now(), finishedAtMs: null, progress: { step: 'initial_formula', iterations: 0,
      bestTotalHits: null, bestCapturedSeedCount: null, trial: null },
    trials: [], meshContext: [], stopRequested: false, result: null, error: null,
  } }));
  try {
    if (!state.protocolDraft || !state.blocksDraft?.blocks.length || !state.protocolDraftPersisted) {
      throw new Error('プロトコルとブロックを承認してください。');
    }
    const rejectionCheckpoint = await getQueryOptimizationCheckpoint(projectId, runtime.store);
    check();
    const allSeeds = await listSeedPapers(project.spreadsheetId, runtime.google);
    check();
    const seeds = allSeeds.filter(isSeedEligibleForValidation);
    const existingPmids = new Set(allSeeds.flatMap((seed) => seed.pmid ? [seed.pmid] : []));
    const seedPmids = [...new Set(seeds.map((seed) => seed.pmid).filter((pmid): pmid is string => pmid !== null))];
    update({ seedCount: seedPmids.length });
    const incompatible = validateQueryOptimizationSettings(fixedSettings, seedPmids.length);
    const inputIdentity = createQueryOptimizationInputIdentity(state.protocolDraft, state.blocksDraft, seedPmids, fixedSettings.maxHits);
    const rechecked = resume?.available && checkpoint ? getQueryOptimizationResumeAvailability(checkpoint, inputIdentity) : null;
    if (incompatible || (rechecked && !rechecked.available)) {
      // シード取得後の入力不整合も実行結果ではない。開始前の履歴を保持して設定欄へ戻す。
      store.setState((s) => !owns(s) ? s : { ...s, queryOptimizationRun: state.queryOptimizationRun });
      setupError(incompatible ?? (rechecked && !rechecked.available ? rechecked.reason : '入力を確認できません。'));
      return;
    }
    await saveQueryOptimizationSettings(projectId, { ...fixedSettings,
      maxIterations: resume?.available ? resume.data.limits.evaluatedTrials : fixedSettings.maxIterations }, runtime.store);
    check();
    const factory = await buildLlmProviderFactory({ ...baseDeps,
      llmLogFolderId: project.driveFolderId, spreadsheetId: project.spreadsheetId,
      onCostAccumulate: (costUsd) => {
        baseDeps.onCostAccumulate?.(costUsd);
        if (!Number.isFinite(costUsd) || costUsd < 0) return;
        const run = store.getState().queryOptimizationRun;
        update({ costUsd: (run?.costUsd ?? 0) + costUsd });
      },
      onRequestState: (status) => {
        const run = store.getState().queryOptimizationRun;
        if (!run || run.progress.step !== 'initial_formula') return;
        const event = status === 'idle' ? null : { source: 'AI' as const, status };
        const events = run.progress.apiEvents ?? [];
        update({ progress: { ...run.progress, apiWaiting: status === 'retry' ? event : null,
          apiEvents: event && !events.some((item) => item.source === event.source && item.status === event.status)
            ? [...events, event] : events } });
      },
    });
    check();
    const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
    check();
    let initialFormula = resume?.available ? resume.data.bestFormula!
      : startingFormula ? startingFormula
      : state.currentFormulaMarkdown ? parsePubmedFormulaMd(state.currentFormulaMarkdown)
      : null;
    if (!initialFormula) {
      const generated = await generateDraftFormula({ protocol: state.protocolDraft, blocks: state.blocksDraft,
        targetHits: fixedSettings.maxHits,
        seedContext: { titles: seeds.flatMap((seed) => seed.title ? [seed.title] : []).slice(0, 30),
          samples: [], meshSummary: { seedCount: 0, concepts: [], checkTags: [] } },
      }, { llmFactory: factory, onProgress: () => check(),
        resolveMeshDescriptors: (descriptors) => resolveMeshDescriptors(descriptors, eutils) });
      initialFormula = generated.formula;
      const { filterNotice, parenthesizedTerms, removedMeshHeadings, replacedMeshHeadings } = generated;
      update({ generationNotices: { filterNotice, parenthesizedTerms, removedMeshHeadings, replacedMeshHeadings } });
    }
    check();
    update({ inputSnapshot: { researchQuestion: state.protocolDraft.researchQuestion,
      inclusionCriteria: state.protocolDraft.inclusionCriteria, exclusionCriteria: state.protocolDraft.exclusionCriteria,
      blocks: { ...state.blocksDraft, blocks: state.blocksDraft.blocks.map((block) => ({ ...block })) }, seedPmids: [...seedPmids], model: factory.model } });
    const result = await runQueryOptimization({ projectId, runId, initialFormula, ...fixedSettings, seedPmids, inputIdentity,
      ...(resume?.available ? {
        maxIterations: resume.remaining.evaluatedTrials,
        resumeBudget: { runId: resumeRunId!, limits: resume.data.limits, consumed: resume.data.consumed },
      } : {}),
      // 人の除外は再開可否と切り離して引き継ぐ。
      previousRejectedTrials: [
        ...(resume?.available ? [...resume.data.previousRejectedTrials, ...checkpoint!.trials
          // kind の無い旧形式の保存は、旧 finish・不正応答が存在しなかった従来どおり !accepted だけで引き継ぐ。
          // kind がある試行は、finish・information・不正応答（式は最良式のまま）を却下記録から除く。
          .filter((trial) => trial.kind === undefined ? !trial.accepted
            : trial.kind === 'proposal' && !trial.accepted && !trial.responseError)
          .map(({ formula, reason, fingerprint, candidateId }) => ({ formula, reason, fingerprint,
            rejectedByHuman: checkpoint!.heldRejections?.[candidateId] != null }))] : []),
        ...getHumanRejectedTrials(rejectionCheckpoint),
      ],
      // 承認ブロックの blockIndex と組み立て式の ID は、ともに配列順の 1 始まり。
      // BlockDraft に独立 ID がないため、id と approvedBlockId は常に同じ値になる。
      approvedBlocks: state.blocksDraft.blocks.map((block, index) => ({
        id: String(index + 1), approvedBlockId: String(index + 1), label: block.blockLabel,
      })),
      criteria: { researchQuestion: state.protocolDraft.researchQuestion,
        inclusionCriteria: state.protocolDraft.inclusionCriteria, exclusionCriteria: state.protocolDraft.exclusionCriteria },
      seedPapers: seeds.flatMap((seed) => seed.pmid === null ? [] : [{ pmid: seed.pmid, title: seed.title }]),
    }, { eutils, llmFactory: factory, checkpoint: runtime.store, shouldStop, measureTermDetails: true,
      ...(resume?.available ? { maxApiCalls: resume.remaining.apiCalls, maxElapsedMs: resume.remaining.elapsedMs } : {}),
      onMeshContext: (meshContext) => update({ meshContext }),
      fetchMeshContext: (request, observedEutils) => fetchMeshContext(request, observedEutils ?? eutils, check),
      onProgress: publisher.publish,
    });
    publisher.flush();
    if (!owns(store.getState())) return;
    update({ result, trials: result.trials, blockDiagnosis: result.blockDiagnosis });
    const outsideCheck: OptimizationOutsideCheckState = {
      unjudgedSeedPmids: allSeeds.filter((seed) => seed.pmid && seed.userDecision == null).map((seed) => seed.pmid!),
      status: 'skipped', reason: '自動調整が停止・エラーで終了したため外側の確認は未実行です',
      originalHits: null, marginHits: null, evaluatedCount: 0, candidates: [], decisions: {},
    };
    const savedDecisions = new Map(allSeeds.filter((seed) => seed.pmid && seed.userDecision)
      .map((seed) => [seed.pmid!, seed.userDecision!]));
    const seen = new Set(existingPmids);
    for (const trial of result.trials.filter((trial) => trial.held)) {
      for (const paper of trial.impact?.inspected ?? []) {
        const decision = savedDecisions.get(paper.pmid);
        if (decision) outsideCheck.decisions[paper.pmid] = { decision, status: 'saved', error: null };
        if (seen.has(paper.pmid)) continue;
        seen.add(paper.pmid);
        outsideCheck.candidates.push({ ...paper, abstract: null, source: 'lost', reason: '',
          heldCandidateId: trial.candidateId, lostHits: trial.impact?.lostHits ?? null });
      }
    }
    if (result.best && (result.status === 'achieved' || result.status === 'needs_review')) {
      outsideCheck.status = 'running';
      outsideCheck.reason = null;
      update({ outsideCheck: { ...outsideCheck, candidates: [...outsideCheck.candidates] }, progress: { ...store.getState().queryOptimizationRun!.progress,
        step: 'outside_check', task: null, apiWaiting: null } });
      try {
        check();
        // サービス終了後の外側の確認は、自動調整の通信予算（200 回）とは別枠で行う。
        const outside = await searchOutsideCandidates({ formula: result.best.formula,
          researchQuestion: state.protocolDraft.researchQuestion,
          inclusionCriteria: state.protocolDraft.inclusionCriteria,
          exclusionCriteria: state.protocolDraft.exclusionCriteria,
          existingPmids, eutils, llmFactory: factory, onProgress: () => check() });
        if (!owns(store.getState())) return;
        check();
        outsideCheck.status = 'ready';
        outsideCheck.originalHits = outside.originalHits;
        outsideCheck.marginHits = outside.marginHits;
        outsideCheck.evaluatedCount = outside.evaluatedCount;
        const outsideSeen = new Set(existingPmids);
        for (const candidate of outside.candidates) {
          if (outsideSeen.has(candidate.pmid)) continue;
          outsideSeen.add(candidate.pmid);
          outsideCheck.candidates.push({ ...candidate, source: 'outside' });
        }
      } catch (err) {
        if (!owns(store.getState())) return;
        outsideCheck.status = shouldStop() ? 'skipped' : 'error';
        outsideCheck.reason = shouldStop() ? 'ユーザーの停止要求で外側の確認を中止しました'
          : err instanceof Error ? err.message : String(err);
      }
    }
    update({ outsideCheck: { ...outsideCheck }, progress: { ...store.getState().queryOptimizationRun!.progress, step: 'review' } });
    await persistOptimizationReview(store, runtime, runId);
    if (!owns(store.getState())) return;
    update({ status: result.status === 'error' ? 'error' : 'ready', finishedAtMs: Date.now(), result, trials: result.trials,
      error: result.status === 'error' ? result.unmetReasons.join(' / ') : null });
  } catch (err) {
    publisher.flush();
    if (!owns(store.getState())) return;
    update({ outsideCheck: { status: 'skipped', reason: '自動調整が停止・エラーで終了したため外側の確認は未実行です',
      originalHits: null, marginHits: null, evaluatedCount: 0, candidates: [], decisions: {} } });
    if (err instanceof QueryOptimizationStopError && err.stopReason === 'user_stop') {
      const run = store.getState().queryOptimizationRun;
      update({ status: 'ready', finishedAtMs: Date.now(), result: { status: 'stopped', stopReason: 'user_stop', best: null,
        trials: [], seedDiagnoses: [], unmetReasons: ['初期式の実測前に停止しました。'], iterations: 0, apiCalls: 0,
        elapsedMs: Date.now() - (run?.startedAtMs ?? Date.now()) } });
    } else {
      update({ status: 'error', finishedAtMs: Date.now(), error: err instanceof Error ? err.message : String(err) });
    }
    await persistOptimizationReview(store, runtime, runId);
  } finally {
    publisher.dispose();
  }
}

async function persistOptimizationReview(store: AppStore, runtime: ChromeRuntimeDeps, runId: string): Promise<void> {
  const run = store.getState().queryOptimizationRun;
  if (!run || run.runId !== runId || store.getState().project?.projectId !== run.projectId) return;
  try {
    await updateQueryOptimizationReviewSections(run.projectId, runId, buildOptimizationReviewSections(run).sections,
      runtime.store, () => store.getState().project?.projectId === run.projectId
        && store.getState().queryOptimizationRun?.runId === runId);
  } catch (err) {
    console.warn('自動調整の確認状況をチェックポイントに保存できませんでした', err);
  }
}

/** 判定中の状態を store に保持し、再描画や二重押しでも追記を重複させない。 */
export async function runDecideOutsideCandidate(
  store: AppStore, runtime: ChromeRuntimeDeps, pmid: string, decision: 'include' | 'exclude' | 'maybe'
): Promise<void> {
  const run = store.getState().queryOptimizationRun;
  const candidate = run?.outsideCheck?.candidates.find((item) => item.pmid === pmid);
  const previous = run?.outsideCheck?.decisions[pmid];
  if (!run || !candidate || run.status === 'running' || run.projectId !== store.getState().project?.projectId
    || previous?.status === 'saving' || previous?.status === 'saved') return;
  const owns = (): boolean => store.getState().project?.projectId === run.projectId
    && store.getState().queryOptimizationRun?.runId === run.runId;
  const setDecision = (status: 'saving' | 'saved' | 'error', error: string | null = null): void => {
    if (!owns()) return;
    store.setState((s) => ({ ...s, queryOptimizationRun: { ...s.queryOptimizationRun!,
      outsideCheck: { ...s.queryOptimizationRun!.outsideCheck!, decisions: {
        ...s.queryOptimizationRun!.outsideCheck!.decisions, [pmid]: { decision, status, error },
      } },
    } }));
  };
  setDecision('saving');
  try {
    const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
    if (!owns()) return;
    const userEmail = await getCurrentUserEmail(runtime.profile);
    if (!owns()) return;
    await recordDecision({ pmid, title: candidate.title, year: candidate.year, decision,
      reason: candidate.source === 'outside' ? candidate.reason
        : `自動調整 run ${run.runId}: 保留候補 ${candidate.heldCandidateId} で失う文献`,
    }, { google: runtime.google, eutils, store, userEmail,
      llmFactory: { forPurpose: neverCalledProvider, model: 'unused' } });
    if (!owns()) return;
    setDecision('saved');
    await persistOptimizationReview(store, runtime, run.runId);
    if (!owns()) return;
  } catch (err) {
    setDecision('error', err instanceof Error ? err.message : String(err));
  }
}

/** 保存済み include を読み直し、最良候補から新しい予算で調整を開始する。 */
export async function runReadjustOptimization(
  store: AppStore, runtime: ChromeRuntimeDeps,
  baseDeps: Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'>
): Promise<void> {
  const run = store.getState().queryOptimizationRun;
  const decisions = Object.values(run?.outsideCheck?.decisions ?? {});
  if (!run?.result?.best || run.projectId !== store.getState().project?.projectId || run.status === 'running'
    || run.save?.status === 'saving' || decisions.some((item) => item.status === 'saving')
    || !decisions.some((item) => item.status === 'saved' && item.decision === 'include')) return;
  await runOptimizeQuery(store, runtime, baseDeps, { maxHits: run.maxHits, maxIterations: run.maxIterations },
    undefined, run.result.best.formula);
}

/**
 * 保留候補（issue #172）の式を初期式にして、新しい予算で調整を開始する。
 * 最良候補の再調整（include 保護）とは別の出口で、include 保存の条件は課さない。
 */
export async function runReadjustFromHeldOptimizationCandidate(
  store: AppStore, runtime: ChromeRuntimeDeps,
  baseDeps: Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'>,
  candidateId: string
): Promise<void> {
  const run = store.getState().queryOptimizationRun;
  const trial = run?.trials.find((item) => item.candidateId === candidateId && item.held);
  if (!run || !trial || run.projectId !== store.getState().project?.projectId || run.status === 'running'
    || run.save?.status === 'saving') return;
  await runOptimizeQuery(store, runtime, baseDeps, { maxHits: run.maxHits, maxIterations: run.maxIterations },
    undefined, trial.formula);
}

const heldRejectionWrites = new WeakMap<AppStore, Promise<void>>();

/**
 * 保留候補を人が「除外」する。式は保存せず、同じプロジェクトの
 * 次の run がこの式を測定前に却下できるよう、判断だけをチェックポイントへ残す。
 */
export function rejectHeldOptimizationCandidate(store: AppStore, runtime: ChromeRuntimeDeps, candidateId: string): void {
  const state = store.getState();
  const run = state.queryOptimizationRun;
  const trial = run?.trials.find((item) => item.candidateId === candidateId && item.held);
  if (!run || !trial || run.projectId !== state.project?.projectId || run.status === 'running'
    || heldRejectionWrites.has(store) || run?.heldRejectionSaving || run.heldRejections?.[candidateId]) return;
  const heldRejections = { ...run.heldRejections, [candidateId]: { rejectedAt: nowIso() } };
  const runId = run.runId;
  store.setState((s) => s.queryOptimizationRun?.runId !== runId ? s
    : { ...s, queryOptimizationRun: { ...s.queryOptimizationRun!, heldRejections, heldRejectionSaving: true } });
  const pending = updateQueryOptimizationHeldRejections(run.projectId, runId, heldRejections, runtime.store,
    () => store.getState().queryOptimizationRun?.runId === runId
  ).catch((err) => {
    store.setState((s) => s.queryOptimizationRun?.runId !== runId ? s
      : { ...s, queryOptimizationRun: { ...s.queryOptimizationRun!, heldRejections: run.heldRejections, heldRejectionSaving: true } });
    console.warn('保留候補の除外をチェックポイントに保存できませんでした', err);
  }).finally(() => {
    heldRejectionWrites.delete(store);
    store.setState((s) => s.queryOptimizationRun?.runId !== runId ? s
      : { ...s, queryOptimizationRun: { ...s.queryOptimizationRun!, heldRejectionSaving: false } });
  });
  heldRejectionWrites.set(store, pending);
}

/** 「除外」を取り消す（issue #172）。押し間違いを戻せるようにし、記録も消す。 */
export function undoHeldOptimizationCandidateRejection(store: AppStore, runtime: ChromeRuntimeDeps, candidateId: string): void {
  const state = store.getState();
  const run = state.queryOptimizationRun;
  if (heldRejectionWrites.has(store) || run?.heldRejectionSaving || !run || !run.heldRejections?.[candidateId] || run.projectId !== state.project?.projectId) return;
  const heldRejections = { ...run.heldRejections };
  delete heldRejections[candidateId];
  const runId = run.runId;
  store.setState((s) => s.queryOptimizationRun?.runId !== runId ? s
    : { ...s, queryOptimizationRun: { ...s.queryOptimizationRun!, heldRejections, heldRejectionSaving: true } });
  const pending = updateQueryOptimizationHeldRejections(run.projectId, runId, heldRejections, runtime.store,
    () => store.getState().queryOptimizationRun?.runId === runId
  ).catch((err) => {
    store.setState((s) => s.queryOptimizationRun?.runId !== runId ? s
      : { ...s, queryOptimizationRun: { ...s.queryOptimizationRun!, heldRejections: run.heldRejections, heldRejectionSaving: true } });
    console.warn('保留候補の除外の取り消しをチェックポイントに保存できませんでした', err);
  }).finally(() => {
    heldRejectionWrites.delete(store);
    store.setState((s) => s.queryOptimizationRun?.runId !== runId ? s
      : { ...s, queryOptimizationRun: { ...s.queryOptimizationRun!, heldRejectionSaving: false } });
  });
  heldRejectionWrites.set(store, pending);
}

/**
 * 「最初から作り直す」（旧「生成して検証する」）パイプライン。生成（generateDraft）→ 検証（runValidation）を
 * 1 アクションで連結し、draftRun の phase / progressLabel / blockHits と validationResult を
 * すべて store 経由で更新する。各フェーズの失敗は draftRun.status='error' に落とす
 * （生成済みの formula と blockHits は残すので、検証だけ失敗しても結果は確認できる）。
 */
async function runGenerateAndValidate(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  baseDeps: Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'>
): Promise<void> {
  if (store.getState().draftRun?.status === 'running') {
    // 再描画タイミング次第でボタンが二度押せた場合の保険
    return;
  }
  store.setState((s) => ({
    ...s,
    draftRun: {
      status: 'running',
      phase: 'generating',
      progressLabel: '開始します…',
      startedAtMs: Date.now(),
      error: null,
      blockHits: [],
      removedMeshHeadings: [], replacedMeshHeadings: [], filterNotice: null, parenthesizedTerms: [],
    },
  }));

  // --- 生成フェーズ（ブロックごとにヒット数を前倒し計測）---
  let draftResult: DraftResult;
  try {
    draftResult = await runGenerateDraft(
      store,
      runtime,
      baseDeps,
      (p) => {
        store.setState((s) =>
          s.draftRun === null
            ? s
            : {
                ...s,
                draftRun: {
                  ...s.draftRun,
                  progressLabel: formatDraftProgress(p),
                  progress: { phase: 'generating', ...p },
                },
              }
        );
      },
      (hit) => {
        store.setState((s) =>
          s.draftRun === null
            ? s
            : { ...s, draftRun: { ...s.draftRun, blockHits: [...s.draftRun.blockHits, hit] } }
        );
      }
    );
  } catch (err) {
    setDraftRunError(store, 'generating', err);
    return;
  }

  // --- 検証フェーズ（生成完了後に自動継続）---
  store.setState((s) =>
    s.draftRun === null
      ? s
      : {
          ...s,
          draftRun: {
            ...s.draftRun,
            phase: 'validating',
            filterNotice: draftResult.filterNotice ?? null,
            parenthesizedTerms: draftResult.parenthesizedTerms ?? [],
            removedMeshHeadings: draftResult.removedMeshHeadings,
            replacedMeshHeadings: draftResult.replacedMeshHeadings,
            progressLabel: '検証を開始します…',
            progress: { phase: 'validating', step: 'line_hits' },
          },
        }
  );
  // 生成時に計測済みの概念ブロックは再 esearch せず再利用する
  const precomputed = new Map<string, number>();
  for (const hit of draftResult.blockHits) {
    if (hit.error === null && hit.hitCount !== null) {
      precomputed.set(hit.blockId, hit.hitCount);
    }
  }
  const summary = await runValidationPhase(store, runtime, precomputed);
  if (summary !== null) {
    await maybeProposeExcessFilters(store, baseDeps, summary);
  }
}

/**
 * 検証フェーズ（runValidation + 進捗反映 + 完了時の validationResult 保存）。
 * 「最初から作り直す」（旧「生成して検証する」）の後半と「検証のみ再実行」（fix-plan 2-2）で共用する。
 * 呼び出し時点で draftRun は status='running' / phase='validating' になっている前提。
 * 成功時は summary を返し、除外通知があれば完了状態を保持する。失敗時は draftRun をエラー化して
 * null を返す（生成済みの blockHits は保持される）。
 */
async function runValidationPhase(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  precomputedBlockHits?: ReadonlyMap<string, number>
): Promise<ValidationSummary | null> {
  try {
    const summary = await runValidate(
      store,
      runtime,
      (p) => {
        store.setState((s) =>
          s.draftRun === null
            ? s
            : {
                ...s,
                draftRun: {
                  ...s.draftRun,
                  progressLabel: formatValidationProgress(p),
                  progress: { phase: 'validating', ...p },
                },
              }
        );
      },
      precomputedBlockHits
    );
    store.setState((s) => ({
      ...s,
      validationResult:
        s.currentFormulaVersionId === null
          ? null
          : { formulaVersionId: s.currentFormulaVersionId, summary },
      // 再生成・再検証したら過去の原因分析は古くなるため破棄する
      missedAnalysis: null,
      draftRun: s.draftRun && (s.draftRun.removedMeshHeadings.length || s.draftRun.replacedMeshHeadings.length || s.draftRun.filterNotice || s.draftRun.parenthesizedTerms?.length)
        ? { ...s.draftRun, status: 'done', progressLabel: '', progress: null, blockHits: [] } : null,
    }));
    return summary;
  } catch (err) {
    setDraftRunError(store, 'validating', err);
    return null;
  }
}

/**
 * 「検証のみ再実行」（fix-plan 2-2）。生成済みの currentFormulaMarkdown を対象に、
 * LLM を一切呼ばず検証フェーズだけをやり直す。生成成功・検証失敗のときに
 * 「再生成して再検証」しか手がなく LLM コストを二重払いする問題の解消。
 * 直前の実行（検証フェーズまで到達したもの）で計測済みの blockHits は
 * 式が一致するものだけ precomputed として再利用し、概念ブロックの再 esearch も省く。
 */
async function runRevalidateOnly(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  baseDeps: Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'>
): Promise<void> {
  const initial = store.getState();
  if (initial.draftRun?.status === 'running') {
    return;
  }
  /* istanbul ignore if -- 再実行ボタンは formula 保存済みでしか表示されない */
  if (initial.currentFormulaVersionId === null || initial.currentFormulaMarkdown === null) {
    return;
  }
  // 生成フェーズで失敗した run の blockHits は保存済み式と一致しない可能性があるため、
  // 検証フェーズまで到達した run のものだけ引き継ぐ。
  const prevBlockHits =
    initial.draftRun?.phase === 'validating' ? initial.draftRun.blockHits : [];
  store.setState((s) => ({
    ...s,
    draftRun: {
      status: 'running',
      phase: 'validating',
      progressLabel: '検証を開始します…',
      progress: { phase: 'validating', step: 'line_hits' },
      startedAtMs: Date.now(),
      error: null,
      blockHits: prevBlockHits,
      filterNotice: initial.draftRun?.phase === 'validating' ? initial.draftRun.filterNotice ?? null : null,
      parenthesizedTerms: initial.draftRun?.phase === 'validating' ? initial.draftRun.parenthesizedTerms ?? [] : [],
      removedMeshHeadings: initial.draftRun?.phase === 'validating' ? initial.draftRun.removedMeshHeadings : [],
      replacedMeshHeadings: initial.draftRun?.phase === 'validating' ? initial.draftRun.replacedMeshHeadings : [],
    },
  }));
  const precomputed = new Map<string, number>();
  try {
    const formula = parsePubmedFormulaMd(initial.currentFormulaMarkdown);
    for (const hit of prevBlockHits) {
      const block = formula.blocks.find((b) => b.id === hit.blockId);
      if (hit.error === null && hit.hitCount !== null &&
          block?.expression.trim() === hit.expression.trim()) {
        precomputed.set(hit.blockId, hit.hitCount);
      }
    }
  } catch {
    // 解析に失敗した式には計測値を再利用せず、通常の検証に委ねる。
  }
  const summary = await runValidationPhase(store, runtime, precomputed);
  if (summary !== null) {
    await maybeProposeExcessFilters(store, baseDeps, summary);
  }
}

/**
 * 検証完了後、総ヒット数が HIT_THRESHOLD（10,000 件）を超えていたら LLM に絞り込み
 * フィルタ候補を尋ね、承認待ちとして store.excessFilterProposal へ保存する（fix-plan 2-1 /
 * requirements.md §4.4）。候補はあくまで承認待ちで、式への追記はユーザー承認
 * （onApplyExcessFilters）でのみ行う。LLM 失敗は検証結果を壊さず proposal.error に留める。
 */
async function maybeProposeExcessFilters(
  store: AppStore,
  baseDeps: Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'>,
  summary: ValidationSummary
): Promise<void> {
  const state = store.getState();
  const project = state.project;
  const versionId = state.currentFormulaVersionId;
  /* istanbul ignore if -- 検証が成功した直後なので project / version は必ずある */
  if (!project || versionId === null) {
    return;
  }
  if (summary.finalQueryError !== null) {
    return;
  }
  const totalHits = summary.finalQuery.totalHits;
  if (totalHits <= HIT_THRESHOLD) {
    // 閾値以下に収まったら残っている旧提案を片づける
    store.setState((s) =>
      s.excessFilterProposal === null ? s : { ...s, excessFilterProposal: null }
    );
    return;
  }
  if (state.excessFilterProposal?.formulaVersionId === versionId) {
    // 同じバージョンに提案済み。再検証のたびに LLM を呼び直さない
    return;
  }
  try {
    const factory = await buildLlmProviderFactory({
      ...baseDeps,
      llmLogFolderId: project.driveFolderId,
      spreadsheetId: project.spreadsheetId,
    });
    const candidates = await proposeExcessFilters(
      {
        studyDesign: state.protocolDraft?.studyDesign ?? 'any',
        hitCount: totalHits,
      },
      factory.forPurpose('design_filter')
    );
    store.setState((s) =>
      s.currentFormulaVersionId !== versionId
        ? s
        : {
            ...s,
            excessFilterProposal: { formulaVersionId: versionId, totalHits, candidates, error: null },
          }
    );
  } catch (err) {
    // 候補取得の失敗は検証結果に影響させない（過大ヒットの事実だけは表示する）
    store.setState((s) =>
      s.currentFormulaVersionId !== versionId
        ? s
        : {
            ...s,
            excessFilterProposal: {
              formulaVersionId: versionId,
              totalHits,
              candidates: [],
              error: err instanceof Error ? err.message : String(err),
            },
          }
    );
  }
}

/**
 * ユーザーが承認した絞り込みフィルタを式へ追記し、新しい FormulaVersion として保存して
 * 検証のみ再実行する（fix-plan 2-1）。承認なしでは絶対に呼ばれない（UI 側の承認ゲート）。
 */
async function runApplyExcessFilters(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  baseDeps: Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'>,
  approved: ExcessFilterCandidate[]
): Promise<void> {
  if (approved.length === 0) {
    return;
  }
  const state = store.getState();
  if (state.draftRun?.status === 'running') {
    return;
  }
  if (state.currentFormulaMarkdown === null) {
    throw new Error('検索式が未生成です。先に「検索式を作成・自動調整する」を実行してください');
  }
  const newMd = appendExcessFilterBlocks(state.currentFormulaMarkdown, approved);
  await saveEditedFormula(
    {
      formulaMd: newMd,
      note: `過大ヒット絞り込みフィルタを承認して追加: ${approved.map((c) => c.label).join(', ')}`,
    },
    { google: runtime.google, store }
  );
  // 新バージョンへ移ったので旧提案は破棄し、更新後の式を検証し直す
  store.setState((s) => ({ ...s, excessFilterProposal: null }));
  await runRevalidateOnly(store, runtime, baseDeps);
}

/** draftRun を指定フェーズのエラー状態にする（生成済み blockHits は保持する） */
function setDraftRunError(
  store: AppStore,
  phase: 'generating' | 'validating',
  err: unknown
): void {
  store.setState((s) => ({
    ...s,
    draftRun: {
      status: 'error',
      phase,
      progressLabel: '',
      startedAtMs: s.draftRun?.startedAtMs ?? Date.now(),
      error: err instanceof Error ? err.message : String(err),
      blockHits: s.draftRun?.blockHits ?? [],
      filterNotice: s.draftRun?.filterNotice ?? null,
      parenthesizedTerms: s.draftRun?.parenthesizedTerms ?? [],
      removedMeshHeadings: s.draftRun?.removedMeshHeadings ?? [],
      replacedMeshHeadings: s.draftRun?.replacedMeshHeadings ?? [],
    },
  }));
}

async function runGenerateDraft(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  baseDeps: Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'>,
  onProgress: (p: DraftProgress) => void,
  onBlockCounted: (hit: DraftBlockHit) => void
): Promise<DraftResult> {
  const project = store.getState().project;
  /* istanbul ignore if -- draft view は project 選択済みでしかボタンを出さない */
  if (!project) {
    throw new Error('プロジェクトが選択されていません');
  }
  const factory = await buildLlmProviderFactory({
    ...baseDeps,
    llmLogFolderId: project.driveFolderId,
    spreadsheetId: project.spreadsheetId,
  });
  const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
  // 入力欄を増やさず両経路の挙動を揃えるため、設定欄の値を生成の目安にも使う。
  // ただしこのボタンは設定の読み込み完了を待たずに押せる（自動調整のボタンと違い
  // status を見ていない）。読み込み中・失敗中の設定欄はプレースホルダの既定値なので、
  // そのときは保存済みの設定を読み直す。
  const setup = store.getState().queryOptimizationSetup;
  const rawMaxHits = setup?.projectId === project.projectId && setup.status === 'ready'
    ? setup.maxHits
    : (await getQueryOptimizationSettings(project.projectId, runtime.store))?.maxHits;
  const targetHits = resolveTargetHits(rawMaxHits === undefined ? undefined : String(rawMaxHits));
  return generateDraft({
    google: runtime.google,
    store,
    eutils,
    llmFactory: factory,
    onProgress,
    onBlockCounted,
    resolveMeshDescriptors: (descriptors) => resolveMeshDescriptors(descriptors, eutils),
    // 概念ブロックは葉式なのでそのまま esearch count に投げられる
    countBlockHits: async (expression) =>
      (await esearch(expression, eutils, { retmax: 0 })).count,
  }, { targetHits });
}

async function runExport(store: AppStore, runtime: ChromeRuntimeDeps): Promise<ExportResult> {
  return exportToAllDatabases({ google: runtime.google, store });
}

function renderSidebar(
  nav: HTMLElement,
  current: RouteName,
  navigate: (route: RouteName) => void,
  state: ReturnType<AppStore['getState']>
): void {
  nav.innerHTML = '';
  const guards = evaluateGuards(state);
  const ul = nav.ownerDocument.createElement('ul');
  ul.className = 'app__nav-list';
  for (const route of SIDEBAR_ROUTES) {
    const li = nav.ownerDocument.createElement('li');
    const btn = nav.ownerDocument.createElement('button');
    btn.type = 'button';
    btn.textContent = ROUTE_LABELS[route];
    const guard = guards[route];
    const classes: string[] = [];
    if (route === current) classes.push('is-active');
    if (!guard.enabled) classes.push('is-disabled');
    btn.className = classes.join(' ');
    if (route === current) {
      btn.setAttribute('aria-current', 'page');
    }
    if (!guard.enabled) {
      btn.title = guard.reason;
      btn.setAttribute('aria-disabled', 'true');
    }
    // クリック時は一律 navigate に渡す。ガード判定は navigate 側で一元化しているため、
    // 無効ルートは setHash されず理由だけが status に表示される。
    btn.addEventListener('click', () => navigate(route));
    li.appendChild(btn);
    ul.appendChild(li);
  }
  nav.appendChild(ul);
}

/**
 * ヘッダー右上の context ラベル文字列を組み立てる。
 * docs/ui-flow.md §4 のトップバー要件を最小実装で満たすもので、
 * プロトコル／検索式の現在地を 1 行で俯瞰できるようにする。
 */
export function buildContextLabel(state: AppState): string {
  const parts: string[] = [];
  if (state.currentProtocolVersion !== null) {
    parts.push(`Protocol v${state.currentProtocolVersion}`);
  }
  const formulaShort = formatFormulaVersionShort(state.currentFormulaVersionId);
  if (formulaShort !== null) {
    parts.push(`Formula ${formulaShort}`);
  }
  if (state.cumulativeCostUsd !== null) {
    parts.push(`累積 $${state.cumulativeCostUsd.toFixed(4)}`);
  }
  return parts.join(' / ');
}

function renderGuardedPlaceholder(
  container: HTMLElement,
  route: RouteName,
  reason: string
): void {
  container.innerHTML = '';
  const doc = container.ownerDocument;
  const heading = doc.createElement('h2');
  heading.textContent = ROUTE_LABELS[route];
  container.appendChild(heading);
  const msg = doc.createElement('p');
  msg.className = 'view__placeholder';
  msg.textContent = reason;
  container.appendChild(msg);
}
