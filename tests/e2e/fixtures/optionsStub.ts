/**
 * Options 画面専用の chrome.storage.local スタブ。
 * options/bootstrap.ts は identity / tabs を使わないため、storage.local だけ差し替える。
 *
 * docs/ui-deep-test-plan.md §Phase G。
 */

import type { Page } from '@playwright/test';

export interface OptionsScenario {
  /** 事前に chrome.storage.local に入れておく値 */
  storage?: Record<string, unknown>;
}

export async function injectOptionsStub(
  page: Page,
  scenario: OptionsScenario = {}
): Promise<void> {
  await page.addInitScript((args: { storage: Record<string, unknown> }) => {
    const data: Record<string, unknown> = { ...args.storage };

    function pickKeys(
      keys: string | string[] | Record<string, unknown> | null | undefined
    ): Record<string, unknown> {
      if (keys == null) return { ...data };
      if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
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

    const chromeStub = {
      runtime: {
        getURL: (p: string) => `chrome-extension://test/${p}`,
        get lastError() {
          return undefined;
        },
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
            for (const k of Array.isArray(keys) ? keys : [keys]) {
              delete data[k];
            }
          },
        },
      },
    };

    (window as unknown as { chrome: unknown }).chrome = chromeStub;
    (window as unknown as { __optionsStubData: Record<string, unknown> }).__optionsStubData =
      data;
  }, { storage: scenario.storage ?? {} });
}
