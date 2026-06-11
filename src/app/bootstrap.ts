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
  createChromeRuntimeDeps,
  exportToAllDatabases,
  fetchBoundaryCandidates,
  generateDraft,
  ingestSeeds,
  invalidateSeed,
  listSeeds,
  recordDecision,
  retrySeed,
  requestBlockImprovement,
  runValidation,
  analyzeMissedSeeds,
  saveEditedFormula,
  submitProtocol,
  type AnalyzeMissedSeedsResult,
  type BlockImprovementResult,
  type BoundaryCasesResult,
  type ChromeRuntimeDeps,
  type DraftProgress,
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
  type ValidationSummary,
} from './services';
import type { SeedPaper } from '@/domain/seedPaper';
import { listFormulaVersions } from '@/features/formula';
import type { FormulaVersion } from '@/domain/formulaVersion';
import { getCurrentProject } from '@/features/project';
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

  // 起動時に chrome.storage から currentProject を取り込む（runtime が無い場合はスキップ）
  if (runtime) {
    void hydrateCurrentProject(store, runtime).then(render);
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
 * chrome.storage の currentProject をストアに反映する。
 * Popup 側で更新された後、メインビューを開いた直後に同期するための初期化処理。
 */
async function hydrateCurrentProject(store: AppStore, runtime: ChromeRuntimeDeps): Promise<void> {
  const current = await getCurrentProject(runtime.store);
  if (!current) {
    return;
  }
  store.setState((s) => (s.project?.projectId === current.projectId ? s : { ...s, project: current }));
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
  });
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
    },
    blocks: {
      onApprove: async () => {
        await runApprove(store, runtime);
        navigate('seeds');
      },
    },
    draft: {
      onGenerate: async (onProgress) => {
        await runGenerateDraft(store, runtime, llmFactoryDepsBase(), onProgress);
      },
    },
    export: {
      onExport: async (): Promise<ExportResult> => runExport(store, runtime),
    },
    seeds: {
      onIngest: async (input: IngestInput): Promise<IngestSummary> =>
        runIngestSeeds(store, runtime, input),
      onListSeeds: async (): Promise<SeedPaperWithRow[]> => runListSeeds(store, runtime),
      onInvalidate: async (rowIndex: number, seed: SeedPaper): Promise<SeedPaper> =>
        runInvalidateSeed(store, runtime, rowIndex, seed),
      onRetry: async (pmid: string): Promise<IngestSummary> =>
        runRetrySeed(store, runtime, pmid),
    },
    validate: {
      onRun: async (): Promise<ValidationSummary> => runValidate(store, runtime),
      onAnalyzeMissed: async (
        missedPmids: string[]
      ): Promise<AnalyzeMissedSeedsResult> =>
        runAnalyzeMissedSeeds(store, runtime, llmFactoryDepsBase(), missedPmids),
    },
    history: {
      onList: async (): Promise<FormulaVersion[]> => runListHistory(store, runtime),
      onLoad: (version) => {
        store.setState((s) => ({
          ...s,
          currentProtocolVersion: version.protocolVersion,
          currentFormulaVersionId: version.versionId,
          currentFormulaMarkdown: version.formulaMd,
        }));
      },
    },
    edit: {
      onSave: async (input: SaveEditedFormulaInput): Promise<SaveEditedFormulaResult> =>
        runSaveEditedFormula(store, runtime, input),
      onImproveBlock: async (
        input: RequestBlockImprovementInput
      ): Promise<BlockImprovementResult> =>
        runImproveBlock(store, runtime, llmFactoryDepsBase(), input),
    },
    expand: {
      onFetch: async (): Promise<BoundaryCasesResult> =>
        runFetchBoundary(store, runtime, llmFactoryDepsBase()),
      onDecide: async (input: RecordDecisionInput): Promise<RecordDecisionResult> =>
        runRecordDecision(store, runtime, input),
      onRoundComplete: async (): Promise<ValidationSummary> => runValidate(store, runtime),
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
  return requestBlockImprovement(input, { store, llmFactory: factory });
}

async function runFetchBoundary(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  baseDeps: Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'>
): Promise<BoundaryCasesResult> {
  const project = store.getState().project;
  /* istanbul ignore if -- expand view は project + formula 有り時しか onFetch を呼ばない */
  if (!project) {
    throw new Error('プロジェクトが選択されていません');
  }
  const factory: LlmProviderFactory = await buildLlmProviderFactory({
    ...baseDeps,
    llmLogFolderId: project.driveFolderId,
    spreadsheetId: project.spreadsheetId,
  });
  const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
  return fetchBoundaryCandidates({
    google: runtime.google,
    eutils,
    store,
    llmFactory: factory,
  });
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

async function runValidate(
  store: AppStore,
  runtime: ChromeRuntimeDeps
): Promise<ValidationSummary> {
  const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
  return runValidation({
    google: runtime.google,
    eutils,
    store,
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

async function runGenerateDraft(
  store: AppStore,
  runtime: ChromeRuntimeDeps,
  baseDeps: Omit<LlmFactoryDeps, 'llmLogFolderId' | 'spreadsheetId'>,
  onProgress: (p: DraftProgress) => void
): Promise<void> {
  const project = store.getState().project;
  /* istanbul ignore if -- draft view は project 選択済みでしかボタンを出さない */
  if (!project) {
    return;
  }
  const factory = await buildLlmProviderFactory({
    ...baseDeps,
    llmLogFolderId: project.driveFolderId,
    spreadsheetId: project.spreadsheetId,
  });
  const eutils = await buildEutilsDeps({ google: runtime.google, store: runtime.store });
  await generateDraft({
    google: runtime.google,
    store,
    eutils,
    llmFactory: factory,
    onProgress,
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
