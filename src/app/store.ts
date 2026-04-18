import type { CurrentProjectEntry } from '@/features/project';
import type { RouteName } from './router';

/**
 * メインビューの中央ストア。
 * 自作の最小実装（≒ Redux mini）。後で signals / zustand に差し替えても
 * インターフェースは互換のまま使えるよう保つ。
 */

/**
 * ブロック承認画面（#/blocks）で編集中のドラフト。
 * extract-protocol skill の結果を初期値としてここに入れ、
 * ユーザーの編集を反映してから ProtocolBlocks タブへ保存する。
 */
export interface BlockDraft {
  blockLabel: string;
  description: string;
  /** AI が生成したまま未編集なら true、ユーザーが触ったら false */
  aiGenerated: boolean;
  note: string;
}

export interface BlocksDraft {
  blocks: BlockDraft[];
  combinationExpression: string;
}

export interface AppState {
  /** 現在のハッシュルート */
  route: RouteName;
  /** 現在開いているプロジェクト。未選択なら null */
  project: CurrentProjectEntry | null;
  /** トップバー右側の累積コスト表示用（USD）。未集計なら null */
  cumulativeCostUsd: number | null;
  /** ブロック承認画面の編集中ドラフト。未開始なら null */
  blocksDraft: BlocksDraft | null;
}

export const INITIAL_STATE: AppState = {
  route: 'home',
  project: null,
  cumulativeCostUsd: null,
  blocksDraft: null,
};

export type Updater = (prev: AppState) => AppState;

export interface AppStore {
  getState(): AppState;
  setState(updater: Updater): void;
  subscribe(listener: () => void): () => void;
}

export function createStore(initial: AppState = INITIAL_STATE): AppStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState: (updater) => {
      const next = updater(state);
      if (next === state) {
        return;
      }
      state = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
