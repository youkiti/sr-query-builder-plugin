import type { AppStore } from '../store';
import type { RouteName } from '../router';
import { createHomeView, renderHomeView, type HomeViewCallbacks } from './homeView';
import {
  createProtocolView,
  renderProtocolView,
  type ProtocolViewCallbacks,
} from './protocolView';
import { createBlocksView, type BlocksViewCallbacks } from './blocksView';
import { createDraftView, type DraftViewCallbacks } from './draftView';
import { createExportView, type ExportViewCallbacks } from './exportView';
import { createSeedsView, type SeedsViewCallbacks } from './seedsView';
import { createValidateView, type ValidateViewCallbacks } from './validateView';
import { renderDoneView } from './doneView';
import { createEditView, type EditViewCallbacks } from './editView';
import { createExpandView, type ExpandViewCallbacks } from './expandView';
import { createHistoryView, type HistoryViewCallbacks } from './historyView';
import { buildNotImplementedView } from './notImplementedView';
import type { RenderView } from './types';

export interface BuildViewsOptions {
  home?: HomeViewCallbacks;
  blocks?: BlocksViewCallbacks;
  protocol?: ProtocolViewCallbacks;
  draft?: DraftViewCallbacks;
  export?: ExportViewCallbacks;
  seeds?: SeedsViewCallbacks;
  validate?: ValidateViewCallbacks;
  history?: HistoryViewCallbacks;
  edit?: EditViewCallbacks;
  expand?: ExpandViewCallbacks;
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
    home: createHomeView(options.home),
    protocol: createProtocolView(options.protocol),
    blocks: createBlocksView(store, options.blocks),
    seeds: createSeedsView(options.seeds),
    draft: createDraftView(options.draft),
    validate: createValidateView(options.validate),
    expand: createExpandView(options.expand),
    edit: createEditView(options.edit),
    export: createExportView(options.export),
    done: renderDoneView,
    history: createHistoryView(options.history),
  };
}

export type { RenderView, ViewContext } from './types';
export {
  createHomeView,
  renderHomeView,
  renderProtocolView,
  createProtocolView,
  buildNotImplementedView,
  createBlocksView,
  createDraftView,
  createExportView,
  createSeedsView,
  createValidateView,
  renderDoneView,
  createHistoryView,
  createEditView,
  createExpandView,
};
export type { HomeViewCallbacks };
