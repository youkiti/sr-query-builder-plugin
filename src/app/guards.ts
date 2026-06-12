/**
 * サイドバーのルート遷移ガード。
 *
 * docs/ui-flow.md §3 に従い、前提条件を満たさないステップはサイドバーで
 * ディム表示し、クリック時は理由をトーストで案内する。
 *
 * 本拡張は store 上にしか state を持たないため、「ValidationLog に行がある」
 * 等の Sheets 側条件は MVP では `currentFormulaVersionId` の有無で近似する。
 * 厳密な条件は実装フェーズで随時引き締める。
 */

import type { RouteName } from './router';
import type { AppState } from './store';

export interface RouteGuard {
  /** サイドバーから遷移可能か */
  enabled: boolean;
  /** 無効時にトースト表示する理由。有効時は空文字 */
  reason: string;
}

const REASON_PROJECT = 'プロジェクトを選択してください';
const REASON_PROTOCOL = '先にプロトコルを入力してください';
const REASON_BLOCKS = '先にブロック承認を完了させてください';
const REASON_FORMULA = '先に検索式を生成または読み込んでください';

/**
 * 現在のストア状態から各ルートの enabled / reason を算出する。
 *
 * - `home` / `protocol`: 常に利用可
 * - `seeds` / `history`: プロジェクト選択済みなら利用可
 * - `blocks`: プロトコルドラフト（extract-protocol 済み）がある
 * - `draft`: ブロック承認済み（`currentProtocolVersion` が採番済み & blocksDraft にブロックあり）
 * - `validate` / `expand` / `edit` / `export` / `done`: 検索式（`currentFormulaVersionId`）がある
 */
export function evaluateGuards(state: AppState): Record<RouteName, RouteGuard> {
  const hasProject = state.project !== null;
  const hasProtocol = state.protocolDraft !== null;
  const hasApprovedBlocks =
    state.currentProtocolVersion !== null &&
    state.blocksDraft !== null &&
    state.blocksDraft.blocks.length >= 1;
  const hasFormula = state.currentFormulaVersionId !== null;

  const needsProject = (): RouteGuard =>
    hasProject ? allow() : deny(REASON_PROJECT);
  const needsProtocol = (): RouteGuard =>
    hasProject ? (hasProtocol ? allow() : deny(REASON_PROTOCOL)) : deny(REASON_PROJECT);
  const needsBlocks = (): RouteGuard =>
    hasProject
      ? hasApprovedBlocks
        ? allow()
        : deny(REASON_BLOCKS)
      : deny(REASON_PROJECT);
  const needsFormula = (): RouteGuard =>
    hasProject ? (hasFormula ? allow() : deny(REASON_FORMULA)) : deny(REASON_PROJECT);

  return {
    home: allow(),
    protocol: allow(),
    blocks: needsProtocol(),
    seeds: needsProject(),
    draft: needsBlocks(),
    validate: needsFormula(),
    expand: needsFormula(),
    edit: needsFormula(),
    export: needsFormula(),
    done: needsFormula(),
    history: needsProject(),
    settings: allow(),
  };
}

function allow(): RouteGuard {
  return { enabled: true, reason: '' };
}

function deny(reason: string): RouteGuard {
  return { enabled: false, reason };
}
