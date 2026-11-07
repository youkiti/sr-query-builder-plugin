import { t } from '@/lib/i18n';

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


/**
 * 現在のストア状態から各ルートの enabled / reason を算出する。
 *
 * - `home` / `protocol`: 常に利用可
 * - `seeds` / `history`: プロジェクト選択済みなら利用可
 * - `blocks`: プロトコルドラフト（extract-protocol 済み）がある
 * - `draft`: ブロック承認済み（`currentProtocolVersion` が採番済み & blocksDraft にブロックあり）
 * - `expand` / `edit` / `export` / `done`: 検索式（`currentFormulaVersionId`）がある
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
    hasProject ? allow() : deny(t('shell.guard.project'));
  const needsProtocol = (): RouteGuard =>
    hasProject ? (hasProtocol ? allow() : deny(t('shell.guard.protocol'))) : deny(t('shell.guard.project'));
  const needsBlocks = (): RouteGuard =>
    hasProject
      ? hasApprovedBlocks
        ? allow()
        : deny(t('shell.guard.blocks'))
      : deny(t('shell.guard.project'));
  const needsFormula = (): RouteGuard =>
    hasProject ? (hasFormula ? allow() : deny(t('shell.guard.formula'))) : deny(t('shell.guard.project'));

  return {
    home: allow(),
    protocol: allow(),
    blocks: needsProtocol(),
    seeds: needsProject(),
    draft: needsBlocks(),
    expand: needsFormula(),
    // 自動調整の「編集して確認」で、保存版がまだない最終候補も手編集できるようにする。
    // 新しく許可するのは currentFormulaVersionId が null で、同じく null 向けの下書きが
    // 存在する場合だけ。下書きなし・別版向けなら従来の needsFormula() で判定する。
    edit: hasProject && state.formulaEditDraft?.formulaVersionId === state.currentFormulaVersionId
      ? allow() : needsFormula(),
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
