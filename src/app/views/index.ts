import type { AppStore } from '../store';
import type { RouteName } from '../router';
import { renderHomeView } from './homeView';
import { renderProtocolView } from './protocolView';
import { createBlocksView, type BlocksViewCallbacks } from './blocksView';
import { buildNotImplementedView } from './notImplementedView';
import type { RenderView } from './types';

export interface BuildViewsOptions {
  blocks?: BlocksViewCallbacks;
}

/**
 * ルートごとの render 関数マップを store と共に組み立てる。
 * ストアに依存する view（blocksView）はここで closure を結びつける。
 */
export function buildViews(
  store: AppStore,
  options: BuildViewsOptions = {}
): Record<RouteName, RenderView> {
  return {
    home: renderHomeView,
    protocol: renderProtocolView,
    blocks: createBlocksView(store, options.blocks),
    seeds: buildNotImplementedView('seeds'),
    draft: buildNotImplementedView('draft'),
    validate: buildNotImplementedView('validate'),
    expand: buildNotImplementedView('expand'),
    edit: buildNotImplementedView('edit'),
    export: buildNotImplementedView('export'),
    done: buildNotImplementedView('done'),
    history: buildNotImplementedView('history'),
  };
}

export type { RenderView, ViewContext } from './types';
export { renderHomeView, renderProtocolView, buildNotImplementedView, createBlocksView };
