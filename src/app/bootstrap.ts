declare const __BUILD_DATE__: string;

/**
 * メインビュー（app.html）の起動ロジック。
 * router / store / views を組み合わせ、ハッシュ変更とストア更新の両方で再レンダする。
 *
 * wiring 層も兼ねており、起動時に chrome.storage から currentProject を読んで
 * store に反映し、protocol / blocks view の callback に services を結び付ける。
 */

import {
  approveBlocks,
  buildEutilsDeps,
  buildLlmProviderFactory,
  checkEditedCombination,
  createChromeRuntimeDeps,
  exportToAllDatabases,
  fetchBoundaryCandidates,
  fillPmidForRisRow,
  generateDraft,
  ingestSeeds,
  overwriteCurrentFormula,
  restoreFormulaVersion,
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
  type BlockImprovementResult,
  type ChromeRuntimeDeps,
  type CombinationCheckResult,
  type DraftBlockHit,
  type DraftProgress,
  type DraftResult,
  type ExportResult,
  type IngestInput,
  type IngestSummary,
  type LlmFactoryDeps,
  type LlmProviderFactory,
  type ProtocolSubmissionInput,
  type RecordDecisionInput,
  type RecordDecisionResult,
  type RequestBlockImprovementInput,
  type RestoreFormulaResult,
  type SaveEditedFormulaInput,
  type SaveEditedFormulaResult,
  type SeedPaperWithRow,
  type ValidationProgress,
  type ValidationSummary,
} from './services';
import type { SeedPaper } from '@/domain/seedPaper';
import {
  efetchArticles,
  esearch,
  fetchMeshChildren,
  fetchMeshLabels,
  fetchMeshTreeNumbers,
  type EfetchArticle,
  type MeshTreeNode,
} from '@/lib/ncbi';
import type { MeshTreeEntry } from '@/features/validation';
import { getLatestFormulaVersion, listFormulaVersions } from '@/features/formula';
import type { FormulaVersion } from '@/domain/formulaVersion';
import { getCurrentProject } from '@/features/project';
import { getLatestProtocol, getProtocolBlocksByVersion, listProtocols } from '@/features/protocol';
import type { Protocol, ProtocolBlock } from '@/domain/protocol';
import type { BlocksDraft, ProtocolDraft } from './store';
import { getCurrentUserEmail } from '@/lib/google';
import { evaluateGuards } from './guards';
import {
  ROUTE_LABELS,
  SIDEBAR_ROUTES,
  buildHash,
  parseRoute,
  type RouteName,
} from './router';
import { createStore, type AppState, type AppStore, type EditAutoSaveState } from './store';
import { buildViews, type BuildViewsOptions, type ViewContext } from './views';
import { formatDraftProgress, formatValidationProgress } from './views/draftView';
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
      store.setState((s) => ({ ...s, route }));
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
 * Sheets API エラーはアプリ起動を妨げない（エラー時は null のまま起動する）。
 */
async function hydrateCurrentProject(store: AppStore, runtime: ChromeRuntimeDeps): Promise<void> {
  const current = await getCurrentProject(runtime.store);
  if (!current) {
    return;
  }
  store.setState((s) => (s.project?.projectId === current.projectId ? s : { ...s, project: current }));

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
      }));
    }
  } catch {
    // Sheets API エラーは無視してアプリを起動させる
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
 * - blocks.onSaveDraft → 何もしない（store にのみ残す）
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
  // #/edit の動的保存（上書き）。fire-and-forget で呼ばれるので、ここで多重実行を直列化し、
  // 保存中に来た最新の md だけを次に保存する（連続編集で esearch/PUT が積み上がらないように）。
  // 状態は store.editAutoSave に反映し、view は再描画でも表示を失わない。
  const triggerEditAutoSave = makeEditAutoSaveRunner(store, runtime);
  // #/edit のブロック別ヒット数（esearch count）。ヒット数バッジ・「AI に渡す内容を見る」開示・
  // 改善プロンプトの「現在のヒット数」が同じ実数を共有し、同一式の重複 esearch を避けるための
  // 式→件数キャッシュ。
  const blockHitCountCache = new Map<string, Promise<number>>();
  const countBlockHits = (expression: string): Promise<number> => {
    const cached = blockHitCountCache.get(expression);
    if (cached) {
      return cached;
    }
    const pending = (async (): Promise<number> => {
      const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
      return (await esearch(expression, eutils, { retmax: 0 })).count;
    })();
    blockHitCountCache.set(expression, pending);
    // 失敗は握りつぶさず、次回再試行できるようキャッシュから外す。
    pending.catch(() => blockHitCountCache.delete(expression));
    return pending;
  };
  return {
    home: {
      onOpenPopup: () => {
        // 別プロジェクトへ切り替えたいユーザーを Popup に誘導する。
        // 拡張コンテキストでは chrome.tabs/chrome.runtime が存在する前提。
        chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
      },
    },
    protocol: {
      onSubmit: async (input: ProtocolSubmissionInput) => {
        await runProtocolSubmit(store, runtime, llmFactoryDepsBase(), llmFactoryPromise, input);
        navigate('blocks');
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
      onApprove: async () => {
        await runApprove(store, runtime);
        navigate('seeds');
      },
    },
    draft: {
      // 「生成して検証する」= 生成 → 検証 を 1 アクションで連結する。
      // 進捗・エラー・ブロックごとのヒット数は store.draftRun で管理する（LLM コスト集計の
      // setState による全ビュー再描画でローカル DOM の進捗表示が消えるため）。view は描画専任。
      onGenerate: async () => runGenerateAndValidate(store, runtime, llmFactoryDepsBase()),
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
      // 復元は元の履歴行を残したまま新しい作業バージョンへフォークする（動的上書き保存と両立）。
      onLoad: (version): Promise<RestoreFormulaResult> =>
        restoreFormulaVersion(version, { google: runtime.google, store }),
    },
    edit: {
      onSave: async (input: SaveEditedFormulaInput): Promise<SaveEditedFormulaResult> =>
        runSaveEditedFormula(store, runtime, input),
      onAutoSave: (formulaMd: string): void => triggerEditAutoSave(formulaMd),
      onImproveBlock: async (
        input: RequestBlockImprovementInput
      ): Promise<BlockImprovementResult> =>
        runImproveBlock(store, runtime, llmFactoryDepsBase(), countBlockHits, input),
      onGetImproveContext: (blockId: string): Promise<BlockImprovementContext | null> =>
        getBlockImprovementContext(blockId, {
          store,
          google: runtime.google,
          countHits: countBlockHits,
        }),
      onCountHits: (expression: string): Promise<number> => countBlockHits(expression),
      onFetchMeshTrees: async (descriptors: string[]): Promise<MeshTreeEntry[]> => {
        const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
        const treeMap = await fetchMeshTreeNumbers(descriptors, eutils);
        return Array.from(treeMap.entries()).map(([descriptor, treeNumbers]) => ({
          descriptor,
          treeNumbers,
        }));
      },
      onFetchMeshChildren: async (treeNumber: string): Promise<MeshTreeNode[]> => {
        const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
        return fetchMeshChildren(treeNumber, eutils);
      },
      onFetchMeshLabels: async (treeNumbers: string[]): Promise<Map<string, MeshTreeNode>> => {
        const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
        return fetchMeshLabels(treeNumbers, eutils);
      },
      onCheckCombination: async (formulaMd: string): Promise<CombinationCheckResult> => {
        const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
        return checkEditedCombination(formulaMd, { store, google: runtime.google, eutils });
      },
    },
    expand: {
      // 進捗・取得結果は store.expandRun 経由で反映される（draft の onGenerate と同じ思想）
      onFetch: async (): Promise<void> =>
        runFetchBoundary(store, runtime, llmFactoryDepsBase()),
      onDecide: async (input: RecordDecisionInput): Promise<RecordDecisionResult> =>
        runRecordDecision(store, runtime, input),
      onRoundComplete: async (): Promise<ValidationSummary> => runValidate(store, runtime),
    },
    settings: {
      readKey: (key) => runtime.store.read<string>(key),
      writeKey: (key, value) => runtime.store.write({ [key]: value }),
      removeKey: (key) => chrome.storage.local.remove(key),
    },
  };
}

/**
 * #/edit の動的保存（上書き）を直列化して実行するランナーを作る。
 *
 * - view からは編集確定のたびに fire-and-forget で呼ばれる
 * - 保存中に新たな呼び出しが来たら「最新の md」だけを保持し、現在の保存完了後にもう一度走らせる
 *   （連続編集で PUT が積み上がらないようにしつつ、最後の内容を取りこぼさない）
 * - 各段階で store.editAutoSave を更新する（保存完了の setState による再描画でも表示が残る）
 */
function makeEditAutoSaveRunner(
  store: AppStore,
  runtime: ChromeRuntimeDeps
): (formulaMd: string) => void {
  let inFlight = false;
  let pendingMd: string | null = null;
  const setStatus = (state: EditAutoSaveState): void => {
    store.setState((s) => ({ ...s, editAutoSave: state }));
  };
  const drain = async (): Promise<void> => {
    inFlight = true;
    try {
      while (pendingMd !== null) {
        const next = pendingMd;
        pendingMd = null;
        setStatus({ status: 'saving', message: '自動保存中…' });
        try {
          await overwriteCurrentFormula({ formulaMd: next }, { google: runtime.google, store });
          setStatus({ status: 'saved', message: '✓ 上書き保存しました' });
        } catch (err) {
          setStatus({
            status: 'error',
            message: `自動保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    } finally {
      inFlight = false;
    }
  };
  return (formulaMd: string): void => {
    pendingMd = formulaMd;
    if (inFlight) {
      return;
    }
    void drain();
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

async function runSaveEditedFormula(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  input: SaveEditedFormulaInput
): Promise<SaveEditedFormulaResult> {
  return saveEditedFormula(input, { google: runtime.google, store });
}

async function runImproveBlock(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  baseDeps: Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'>,
  countHits: (expression: string) => Promise<number>,
  input: RequestBlockImprovementInput
): Promise<BlockImprovementResult> {
  const project = store.getState().project;
  /* istanbul ignore if -- edit view は project 選択済みでしか onImproveBlock を呼ばない */
  if (!project) {
    throw new Error('プロジェクトが選択されていません');
  }
  const factory: LlmProviderFactory = await buildLlmProviderFactory({
    ...baseDeps,
    llmLogFolderId: project.driveFolderId,
    spreadsheetId: project.spreadsheetId,
  });
  return requestBlockImprovement(input, {
    store,
    google: runtime.google,
    llmFactory: factory,
    countHits,
  });
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
  baseDeps: Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'>
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
      result: null,
    },
  }));

  const project = store.getState().project;
  /* istanbul ignore if -- expand view は project + formula 有り時しか onFetch を呼ばない */
  if (!project) {
    setExpandRunError(store, new Error('プロジェクトが選択されていません'));
    return;
  }
  try {
    const factory: LlmProviderFactory = await buildLlmProviderFactory({
      ...baseDeps,
      llmLogFolderId: project.driveFolderId,
      spreadsheetId: project.spreadsheetId,
    });
    const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
    const result = await fetchBoundaryCandidates({
      google: runtime.google,
      eutils,
      store,
      llmFactory: factory,
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
    llmFactory: { forPurpose: neverCalledProvider },
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
  await submitProtocol(input, { store, provider });
}

async function runApprove(store: AppStore, runtime: ChromeRuntimeDeps): Promise<void> {
  await approveBlocks({ google: runtime.google, profile: runtime.profile, store });
}

/**
 * 「生成して検証する」パイプライン。生成（generateDraft）→ 検証（runValidation）を
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
      precomputed
    );
    store.setState((s) => ({
      ...s,
      validationResult:
        s.currentFormulaVersionId === null
          ? null
          : { formulaVersionId: s.currentFormulaVersionId, summary },
      // 再生成・再検証したら過去の原因分析は古くなるため破棄する
      missedAnalysis: null,
      draftRun: null,
    }));
  } catch (err) {
    setDraftRunError(store, 'validating', err);
  }
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
  return generateDraft({
    google: runtime.google,
    store,
    eutils,
    llmFactory: factory,
    onProgress,
    onBlockCounted,
    // 概念ブロックは葉式なのでそのまま esearch count に投げられる
    countBlockHits: async (expression) =>
      (await esearch(expression, eutils, { retmax: 0 })).count,
  });
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
