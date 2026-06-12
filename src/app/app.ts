import { createLocationOptions, startApp } from './bootstrap';
import { INITIAL_STATE, createStore, type AppState, type AppStore } from './store';

declare const __BUILD_DATE__: string;

declare global {
  interface Window {
    /**
     * Playwright などの E2E テストが store の初期 state を事前投入するための hook。
     * `addInitScript` で `goto()` より前に設定し、本体は INITIAL_STATE とマージして
     * 単発スモークで `#/blocks` 以降の画面へ直接遷移できるようにする。
     * 未定義なら副作用ゼロ（本番では常に undefined）。
     *
     * docs/ui-deep-test-plan.md §1.1 方式 X。
     */
    __E2E_PRELOADED_STATE__?: Partial<AppState>;
  }
}

function buildStore(): AppStore | undefined {
  const preloaded =
    typeof window !== 'undefined' ? window.__E2E_PRELOADED_STATE__ : undefined;
  if (!preloaded) {
    return undefined;
  }
  return createStore({ ...INITIAL_STATE, ...preloaded });
}

startApp(document, { ...createLocationOptions(window), store: buildStore() });
