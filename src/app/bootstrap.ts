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
  clearBlocksDraftBackup,
  createChromeRuntimeDeps,
  getBlocksDraftBackup,
  saveBlocksDraftBackup,
  exportToAllDatabases,
  fetchBoundaryCandidates,
  fillPmidForRisRow,
  generateDraft,
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
  type RecordDecisionInput,
  type RecordDecisionResult,
  type RequestBlockImprovementInput,
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
} from '@/lib/ncbi';
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
import { createStore, type AppState, type AppStore } from './store';
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
      // 「生成して検証する」= 生成 → 検証 を 1 アクションで連結する。
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
        return Array.from(treeByDescriptor, ([descriptor, treeNumbers]) => ({
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
        /* istanbul ignore if -- guards.ts の edit: needsFormula() により #/edit 到達時点で必ず非 null */
        if (formulaVersionId === null) {
          return;
        }
        // md を触った時点で直前の保存ステータス（保存しました / エラー）は現在の内容を
        // 説明しなくなるので消す。未保存の編集があることが見た目でも分かる。
        store.setState((s) => ({
          ...s,
          formulaEditDraft: { formulaVersionId, markdown },
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
        /* istanbul ignore if -- guards.ts の edit: needsFormula() により #/edit 到達時点で必ず非 null */
        if (formulaVersionId === null) {
          return;
        }
        store.setStateSilently((s) => ({ ...s, formulaEditNote: { formulaVersionId, note } }));
      },
      // 「AI への指示」欄（初回・追加とも）を store（blockImprovementInstruction）へ反映する。
      // onNoteChange と同じ理由・同じ使い方（setStateSilently で再描画を起こさない）。
      onInstructionChange: (blockId: string, instruction: string) => {
        const formulaVersionId = store.getState().currentFormulaVersionId;
        /* istanbul ignore if -- guards.ts の edit: needsFormula() により #/edit 到達時点で必ず非 null */
        if (formulaVersionId === null) {
          return;
        }
        store.setStateSilently((s) => ({
          ...s,
          blockImprovementInstruction: { formulaVersionId, blockId, instruction },
        }));
      },
      // 「提案を編集してから採用する」欄（issue #90）の未送信テキストを store
      // （blockImprovementManualEditDraft）へ反映する（issue #92 B-3）。onNoteChange /
      // onInstructionChange と同じ理由・同じ使い方（setStateSilently で再描画を起こさない）。
      onManualEditChange: (blockId: string, expression: string) => {
        const formulaVersionId = store.getState().currentFormulaVersionId;
        /* istanbul ignore if -- guards.ts の edit: needsFormula() により #/edit 到達時点で必ず非 null */
        if (formulaVersionId === null) {
          return;
        }
        store.setStateSilently((s) => ({
          ...s,
          blockImprovementManualEditDraft: { formulaVersionId, blockId, expression },
        }));
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
  /* istanbul ignore if -- guards.ts の edit: needsFormula() により #/edit 到達時点で必ず非 null */
  if (formulaVersionId === null) {
    return;
  }
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
  /* istanbul ignore if -- guards.ts の edit: needsFormula() により #/edit 到達時点で必ず非 null */
  if (formulaVersionId === null) {
    return;
  }
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
  const summary = await runValidationPhase(store, runtime, precomputed);
  if (summary !== null) {
    await maybeProposeExcessFilters(store, baseDeps, summary);
  }
}

/**
 * 検証フェーズ（runValidation + 進捗反映 + 完了時の validationResult 保存）。
 * 「生成して検証する」の後半と「検証のみ再実行」（fix-plan 2-2）で共用する。
 * 呼び出し時点で draftRun は status='running' / phase='validating' になっている前提。
 * 成功時は summary を返して draftRun を終了（null）し、失敗時は draftRun をエラー化して
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
      draftRun: null,
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
 * precomputed として再利用し、概念ブロックの再 esearch も省く。
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
    },
  }));
  const precomputed = new Map<string, number>();
  for (const hit of prevBlockHits) {
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
    throw new Error('検索式が未生成です。先に「生成して検証する」を実行してください');
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
