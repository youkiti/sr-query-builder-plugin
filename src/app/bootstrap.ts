/**
 * メインビュー（app.html）の起動ロジック。
 * router / store / views を組み合わせ、ハッシュ変更とストア更新の両方で再レンダする。
 *
 * wiring 層も兼ねており、起動時に chrome.storage から currentProject を読んで
 * store に反映し、protocol / blocks view の callback に services を結び付ける。
 */

import {
  approveBlocks,
  buildLlmProviderFactory,
  createChromeRuntimeDeps,
  submitProtocol,
  type ChromeRuntimeDeps,
  type LlmFactoryDeps,
  type ProtocolSubmissionInput,
} from './services';
import { getCurrentProject } from '@/features/project';
import { ROUTE_LABELS, ROUTES, buildHash, parseRoute, type RouteName } from './router';
import { createStore, type AppStore } from './store';
import { buildViews, type BuildViewsOptions, type ViewContext } from './views';

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
  const viewOptions = opts.viewOptions ?? buildDefaultViewOptions(store, runtime);
  const views = buildViews(store, viewOptions);
  const status = doc.getElementById('app-status');
  const content = doc.getElementById('app-content');
  const sidebar = doc.querySelector('#app-sidebar nav');

  const navigate = (route: RouteName): void => {
    opts.setHash(buildHash(route));
  };

  const render = (): void => {
    const route = parseRoute(opts.getHash());
    if (route !== store.getState().route) {
      store.setState((s) => ({ ...s, route }));
    }
    if (status) {
      const projectName = store.getState().project?.title ?? '(未選択)';
      status.textContent = `${ROUTE_LABELS[route]} / ${projectName}`;
    }
    if (sidebar) {
      renderSidebar(sidebar as HTMLElement, route, navigate);
    }
    if (content) {
      const ctx: ViewContext = { state: store.getState(), navigate };
      views[route](content as HTMLElement, ctx);
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
 * - blocks.onApprove → approveBlocks（Sheets 書き込み）→ /draft ナビ（暫定）
 * - blocks.onSaveDraft → 何もしない（store にのみ残す）
 */
function buildDefaultViewOptions(
  store: AppStore,
  runtime: ChromeRuntimeDeps | null
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
    protocol: {
      onSubmit: (input: ProtocolSubmissionInput) => {
        void runProtocolSubmit(store, runtime, llmFactoryDepsBase(), llmFactoryPromise, input);
      },
    },
    blocks: {
      onApprove: () => {
        void runApprove(store, runtime);
      },
    },
  };
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

function renderSidebar(
  nav: HTMLElement,
  current: RouteName,
  navigate: (route: RouteName) => void
): void {
  nav.innerHTML = '';
  const ul = nav.ownerDocument.createElement('ul');
  ul.className = 'app__nav-list';
  for (const route of ROUTES) {
    const li = nav.ownerDocument.createElement('li');
    const btn = nav.ownerDocument.createElement('button');
    btn.type = 'button';
    btn.textContent = ROUTE_LABELS[route];
    btn.className = route === current ? 'is-active' : '';
    btn.addEventListener('click', () => navigate(route));
    li.appendChild(btn);
    ul.appendChild(li);
  }
  nav.appendChild(ul);
}
