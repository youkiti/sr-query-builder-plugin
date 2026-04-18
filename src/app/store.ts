import type { CurrentProjectEntry } from '@/features/project';
import type { RouteName } from './router';

/**
 * メインビューの中央ストア。
 * 自作の最小実装（≒ Redux mini）。後で signals / zustand に差し替えても
 * インターフェースは互換のまま使えるよう保つ。
 */

export interface AppState {
  /** 現在のハッシュルート */
  route: RouteName;
  /** 現在開いているプロジェクト。未選択なら null */
  project: CurrentProjectEntry | null;
  /** トップバー右側の累積コスト表示用（USD）。未集計なら null */
  cumulativeCostUsd: number | null;
}

export const INITIAL_STATE: AppState = {
  route: 'home',
  project: null,
  cumulativeCostUsd: null,
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
