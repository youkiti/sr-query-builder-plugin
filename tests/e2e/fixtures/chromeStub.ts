/**
 * Playwright で popup.html / app.html を読み込む際に注入する `chrome.*` の最小スタブ。
 *
 * `chrome.identity` / `chrome.storage.local` / `chrome.tabs` / `chrome.runtime` を
 * シナリオに応じて差し替え、OAuth や実 API 呼び出しなしで画面を起動できるようにする。
 *
 * - `addInitScript()` で `goto()` より前に注入する必要がある（popup.js は読込即時実行）
 * - 関数引数はシリアライズされてページ context に渡るため、外側スコープを参照できない
 *
 * docs/ui-review-strategy.md §3 Tier 2 / docs/ui-states.md の状態 ID と対応する。
 */

import type { Page } from '@playwright/test';

export interface PopupScenario {
  /** `chrome.identity.getAuthToken` が成功するか */
  authed: boolean;
  /** `getProfileUserInfo` で返す email */
  email: string;
  /** `chrome.storage.local.recentProjects` の初期値 */
  recent: Array<{
    projectId: string;
    spreadsheetId: string;
    driveFolderId: string;
    title: string;
  }>;
}

export const DEFAULT_SCENARIO: PopupScenario = {
  authed: true,
  email: 'tester@example.com',
  recent: [],
};

export async function injectChromeStub(page: Page, scenario: PopupScenario): Promise<void> {
  await page.addInitScript((s: PopupScenario) => {
    const data: Record<string, unknown> = {
      recentProjects: s.recent,
    };

    function pickKeys(
      keys: string | string[] | Record<string, unknown> | null | undefined
    ): Record<string, unknown> {
      if (keys == null) return { ...data };
      if (typeof keys === 'string') return { [keys]: data[keys] };
      if (Array.isArray(keys)) {
        const out: Record<string, unknown> = {};
        for (const k of keys) out[k] = data[k];
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(keys)) {
        out[k] = data[k] ?? (keys as Record<string, unknown>)[k];
      }
      return out;
    }

    const lastErrorRef: { value: undefined | { message: string } } = { value: undefined };

    const chromeStub = {
      runtime: {
        getURL: (p: string) => `chrome-extension://test/${p}`,
        openOptionsPage: () => undefined,
        get lastError() {
          return lastErrorRef.value;
        },
      },
      tabs: {
        create: (_opts: { url?: string }) => undefined,
      },
      identity: {
        getAuthToken: (
          _opts: { interactive?: boolean },
          cb: (token: string | undefined) => void
        ) => {
          if (s.authed) {
            lastErrorRef.value = undefined;
            cb('test-token');
          } else {
            lastErrorRef.value = { message: 'OAuth2 not granted or revoked.' };
            cb(undefined);
            // bootstrap.ts は callback の中で lastError を読むので、return 直後にクリア
            queueMicrotask(() => {
              lastErrorRef.value = undefined;
            });
          }
        },
        removeCachedAuthToken: (_o: unknown, cb: () => void) => cb(),
        getProfileUserInfo: (
          _o: unknown,
          cb: (info: { email: string; id: string }) => void
        ) => cb({ email: s.email, id: 'user-1' }),
      },
      storage: {
        local: {
          get: async (
            keys?: string | string[] | Record<string, unknown> | null
          ): Promise<Record<string, unknown>> => pickKeys(keys),
          set: async (items: Record<string, unknown>): Promise<void> => {
            Object.assign(data, items);
          },
          remove: async (keys: string | string[]): Promise<void> => {
            const arr = Array.isArray(keys) ? keys : [keys];
            for (const k of arr) delete data[k];
          },
        },
      },
    };

    (window as unknown as { chrome: unknown }).chrome = chromeStub;
    (window as unknown as { __popupStubData: Record<string, unknown> }).__popupStubData = data;
  }, scenario);
}
