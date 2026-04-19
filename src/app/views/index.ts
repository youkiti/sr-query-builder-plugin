import type { AppStore } from '../store';
import type { RouteName } from '../router';
import { renderHomeView } from './homeView';
import {
  createProtocolView,
  renderProtocolView,
  type ProtocolViewCallbacks,
} from './protocolView';
import { createBlocksView, type BlocksViewCallbacks } from './blocksView';
import { createDraftView, type DraftViewCallbacks } from './draftView';
import { buildNotImplementedView } from './notImplementedView';
import type { RenderView } from './types';

export interface BuildViewsOptions {
  blocks?: BlocksViewCallbacks;
  protocol?: ProtocolViewCallbacks;
  draft?: DraftViewCallbacks;
}

/**
 * ルートごとの render 関数マップを store と共に組み立てる。
 * ストアや callback に依存する view（blocks / protocol）はここで closure を結びつける。
 */
export function buildViews(
  store: AppStore,
  options: BuildViewsOptions = {}
): Record<RouteName, RenderView> {
  return {
    home: renderHomeView,
    protocol: createProtocolView(options.protocol),
    blocks: createBlocksView(store, options.blocks),
    seeds: buildNotImplementedView('seeds'),
    draft: createDraftView(options.draft),
    validate: buildNotImplementedView('validate'),
    expand: buildNotImplementedView('expand'),
    edit: buildNotImplementedView('edit'),
    export: buildNotImplementedView('export'),
    done: buildNotImplementedView('done'),
    history: buildNotImplementedView('history'),
  };
}

export type { RenderView, ViewContext } from './types';
export {
  renderHomeView,
  renderProtocolView,
  createProtocolView,
  buildNotImplementedView,
  createBlocksView,
  createDraftView,
};
