/**
 * Playwright で app.html を読み込むときに使う、app 画面向けの拡張スタブ。
 *
 * `chromeStub.ts`（popup 用）に加えて、以下を提供する:
 * - `window.__E2E_PRELOADED_STATE__` による app store の初期 state 投入（方式 X）
 * - `chrome.storage.local.currentProject` のシード（hydrateCurrentProject との整合）
 * - `chrome.runtime.sendMessage` の no-op スタブ
 * - NCBI / Google Sheets / Google Drive への fetch 経路を `page.route()` でモック
 *
 * docs/ui-deep-test-plan.md §1.1 方式 X / §A-2 に対応。
 */

import type { Page, Route } from '@playwright/test';
import type { AppState } from '../../../src/app/store';
import type { CurrentProjectEntry } from '../../../src/features/project';

export interface RouteMock {
  /** `page.route` に渡すパターン（例: `**\/eutils.ncbi.nlm.nih.gov/**`） */
  url: string | RegExp;
  /** 返す JSON。優先度高 */
  json?: unknown;
  /** 返す文字列 body */
  body?: string;
  /** ステータス。既定 200 */
  status?: number;
  /** Content-Type。既定は json なら application/json */
  contentType?: string;
  /** `route.fulfill` 前に手元で呼ばれるフック（リクエスト録音などに使う） */
  onRequest?: (route: Route) => void | Promise<void>;
}

export interface AppScenario {
  /** `chrome.identity.getAuthToken` を成功させるか。既定 true */
  authed?: boolean;
  /** `getProfileUserInfo` が返す email。既定 'tester@example.com' */
  email?: string;
  /**
   * `chrome.storage.local.currentProject` にシードする値。
   * preloadedState.project と同じにしておくと hydrate 後もブレない。
   */
  currentProject?: CurrentProjectEntry | null;
  /** 追加で chrome.storage.local に載せたい値（任意） */
  extraStorage?: Record<string, unknown>;
  /** `window.__E2E_PRELOADED_STATE__` の内容 */
  preloadedState?: Partial<AppState>;
  /** fetch 経路のモック定義 */
  routes?: RouteMock[];
}

const DEFAULT_EMAIL = 'tester@example.com';

export const PROJECT_FIXTURE: CurrentProjectEntry = {
  projectId: 'pid-fixture-1',
  spreadsheetId: 'sheet-fixture-1',
  driveFolderId: 'folder-fixture-1',
  title: 'Test Project',
};

export async function injectAppStub(page: Page, scenario: AppScenario = {}): Promise<void> {
  const authed = scenario.authed ?? true;
  const email = scenario.email ?? DEFAULT_EMAIL;
  const currentProject = scenario.currentProject ?? null;
  const extraStorage = scenario.extraStorage ?? {};
  const preloadedState = scenario.preloadedState ?? null;

  await page.addInitScript(
    (args: {
      authed: boolean;
      email: string;
      currentProject: CurrentProjectEntry | null;
      extraStorage: Record<string, unknown>;
      preloadedState: Partial<AppState> | null;
    }) => {
      if (args.preloadedState) {
        (
          window as unknown as { __E2E_PRELOADED_STATE__: Partial<AppState> }
        ).__E2E_PRELOADED_STATE__ = args.preloadedState;
      }

      const data: Record<string, unknown> = {
        ...args.extraStorage,
      };
      if (args.currentProject !== null) {
        data.currentProject = args.currentProject;
      }

      function pickKeys(
        keys: string | string[] | Record<string, unknown> | null | undefined
      ): Record<string, unknown> {
        if (keys == null) return { ...data };
        if (typeof keys === 'string') {
          return keys in data ? { [keys]: data[keys] } : {};
        }
        if (Array.isArray(keys)) {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in data) out[k] = data[k];
          return out;
        }
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(keys)) {
          out[k] = k in data ? data[k] : (keys as Record<string, unknown>)[k];
        }
        return out;
      }

      const lastErrorRef: { value: undefined | { message: string } } = { value: undefined };

      type MessageRecord = { message: unknown; timestamp: number };
      const sentMessages: MessageRecord[] = [];

      const chromeStub = {
        runtime: {
          getURL: (p: string) => `chrome-extension://test/${p}`,
          openOptionsPage: () => undefined,
          sendMessage: (msg: unknown, cb?: (resp: unknown) => void) => {
            sentMessages.push({ message: msg, timestamp: Date.now() });
            if (typeof cb === 'function') cb(undefined);
            return Promise.resolve(undefined);
          },
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
            if (args.authed) {
              lastErrorRef.value = undefined;
              cb('test-token');
            } else {
              lastErrorRef.value = { message: 'OAuth2 not granted or revoked.' };
              cb(undefined);
              queueMicrotask(() => {
                lastErrorRef.value = undefined;
              });
            }
          },
          removeCachedAuthToken: (_o: unknown, cb: () => void) => cb(),
          getProfileUserInfo: (
            _o: unknown,
            cb: (info: { email: string; id: string }) => void
          ) => cb({ email: args.email, id: 'user-1' }),
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
      (window as unknown as { __appStubData: Record<string, unknown> }).__appStubData = data;
      (window as unknown as { __appStubMessages: MessageRecord[] }).__appStubMessages =
        sentMessages;
    },
    {
      authed,
      email,
      currentProject,
      extraStorage,
      preloadedState,
    }
  );

  // hydrateCurrentProject が currentProject 設定時に Sheets を読む経路のデフォルトモック
  // （空プロジェクト相当の `{ values: [] }` を返す）。実ネットワークへ出さず、
  // hydrateError（fix-plan 1-3）を誤発火させないため。Playwright の route は後勝ちなので、
  // scenario.routes / spec 内の page.route で個別に上書きできる。
  await page.route('**/sheets.googleapis.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ values: [] }),
    });
  });

  // route モックは init script のあとに設定（page 単位で有効）
  for (const r of scenario.routes ?? []) {
    await page.route(r.url, async (route) => {
      if (r.onRequest) {
        await r.onRequest(route);
      }
      const status = r.status ?? 200;
      if (r.json !== undefined) {
        await route.fulfill({
          status,
          contentType: r.contentType ?? 'application/json',
          body: JSON.stringify(r.json),
        });
        return;
      }
      await route.fulfill({
        status,
        contentType: r.contentType ?? 'text/plain',
        body: r.body ?? '',
      });
    });
  }
}

/** 代表的な「プロジェクトは選択済みだが何も進捗なし」のシナリオを組み立てるヘルパ */
export function scenarioWithProject(overrides: Partial<AppScenario> = {}): AppScenario {
  return {
    authed: true,
    currentProject: PROJECT_FIXTURE,
    preloadedState: { project: PROJECT_FIXTURE },
    ...overrides,
  };
}
