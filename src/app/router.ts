import { t } from '@/lib/i18n';

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
  get home() { return t('shell.route.home'); },
  get protocol() { return t('shell.route.protocol'); },
  get blocks() { return t('shell.route.blocks'); },
  get seeds() { return t('shell.route.seeds'); },
  get draft() { return t('shell.route.draft'); },
  get expand() { return t('shell.route.expand'); },
  get edit() { return t('shell.route.edit'); },
  get export() { return t('shell.route.export'); },
  get done() { return t('shell.route.done'); },
  get history() { return t('shell.route.history'); },
  get settings() { return t('shell.route.settings'); },
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
