/**
 * メインビューのハッシュルーティング。
 * docs/ui-flow.md §2 の `#/home` 〜 `#/history` を扱う。
 */

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
  'settings',
] as const;

export type RouteName = (typeof ROUTES)[number];

export const DEFAULT_ROUTE: RouteName = 'protocol';

export const SIDEBAR_ROUTES: readonly RouteName[] = ROUTES.filter(
  (route): route is RouteName => route !== 'home'
);

export const ROUTE_LABELS: Record<RouteName, string> = {
  home: 'ホーム',
  protocol: 'プロトコル入力',
  blocks: 'ブロック承認',
  seeds: 'シード論文',
  draft: '検索式ドラフト',
  validate: '検証',
  expand: '対話的シード拡張',
  edit: '検索式編集',
  export: 'エクスポート',
  done: '完了',
  history: 'バージョン履歴',
  settings: '設定',
};

export interface RouterDeps {
  /** 現在の URL ハッシュを取得（テスト時に差し替え可能） */
  getHash: () => string;
  /** ハッシュ変更を監視。戻り値は解除関数 */
  onHashChange: (listener: () => void) => () => void;
}

export function createLocationRouterDeps(win: Window): RouterDeps {
  return {
    getHash: () => win.location.hash,
    onHashChange: (listener) => {
      win.addEventListener('hashchange', listener);
      return () => win.removeEventListener('hashchange', listener);
    },
  };
}

export function parseRoute(hash: string): RouteName {
  const normalized = hash.replace(/^#\/?/, '');
  return (ROUTES as readonly string[]).includes(normalized)
    ? (normalized as RouteName)
    : DEFAULT_ROUTE;
}

export function buildHash(route: RouteName): string {
  return `#/${route}`;
}
