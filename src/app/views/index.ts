import type { RouteName } from '../router';
import { renderHomeView } from './homeView';
import { renderProtocolView } from './protocolView';
import { buildNotImplementedView } from './notImplementedView';
import type { RenderView } from './types';

/**
 * ルートごとの render 関数マップ。未実装画面は notImplementedView にフォールバック。
 */
export const VIEWS: Record<RouteName, RenderView> = {
  home: renderHomeView,
  protocol: renderProtocolView,
  blocks: buildNotImplementedView('blocks'),
  seeds: buildNotImplementedView('seeds'),
  draft: buildNotImplementedView('draft'),
  validate: buildNotImplementedView('validate'),
  expand: buildNotImplementedView('expand'),
  edit: buildNotImplementedView('edit'),
  export: buildNotImplementedView('export'),
  done: buildNotImplementedView('done'),
  history: buildNotImplementedView('history'),
};

export type { RenderView, ViewContext } from './types';
export { renderHomeView, renderProtocolView, buildNotImplementedView };
