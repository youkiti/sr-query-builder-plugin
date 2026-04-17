/**
 * メインビュー（app.html）の起動ロジック。
 * 現段階ではルーティングだけ組んでおき、各 view は後続 PR で実装する。
 */

export interface AppBootstrapOptions {
  /** 現在の URL ハッシュ（`#/home` 等）を取得する関数。テスト時に差し替え可能 */
  getHash: () => string;
  /** ハッシュ変更イベントを監視する関数。戻り値は解除用 */
  onHashChange: (listener: () => void) => () => void;
}

export const ROUTES = [
  'home',
  'protocol',
  'blocks',
  'seeds',
  'draft',
  'validate',
  'expand',
  'edit',
  'export',
  'done',
  'history',
] as const;

export type RouteName = (typeof ROUTES)[number];

export const DEFAULT_ROUTE: RouteName = 'home';

export function parseRoute(hash: string): RouteName {
  const normalized = hash.replace(/^#\/?/, '');
  return (ROUTES as readonly string[]).includes(normalized)
    ? (normalized as RouteName)
    : DEFAULT_ROUTE;
}

export function createLocationOptions(win: Window): AppBootstrapOptions {
  return {
    getHash: () => win.location.hash,
    onHashChange: (listener) => {
      win.addEventListener('hashchange', listener);
      return () => win.removeEventListener('hashchange', listener);
    },
  };
}

export function startApp(doc: Document, opts: AppBootstrapOptions): () => void {
  const status = doc.getElementById('app-status');
  const content = doc.getElementById('app-content');

  const render = (): void => {
    const route = parseRoute(opts.getHash());
    if (status) {
      status.textContent = `ルート: #/${route}`;
    }
    if (content) {
      content.textContent = `[${route}] 画面は実装中です。`;
    }
  };

  render();
  return opts.onHashChange(render);
}
