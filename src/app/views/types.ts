import type { AppState } from '../store';
import type { RouteName } from '../router';

/**
 * 各 view が共通で受け取るレンダ I/F。
 * - state は読み取り専用の現在ステート
 * - navigate は他ルートへ遷移するための callback（実装は location.hash を更新）
 */
export interface ViewContext {
  state: AppState;
  navigate: (route: RouteName) => void;
}

export type RenderView = (container: HTMLElement, ctx: ViewContext) => void;
