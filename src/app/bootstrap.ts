/**
 * メインビュー（app.html）の起動ロジック。
 * router / store / views を組み合わせ、ハッシュ変更とストア更新の両方で再レンダする。
 */

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
  /** view ごとのコールバック注入（blocks の保存ボタン等） */
  viewOptions?: BuildViewsOptions;
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
  const views = buildViews(store, opts.viewOptions);
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
