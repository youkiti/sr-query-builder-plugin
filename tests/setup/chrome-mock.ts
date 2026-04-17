/**
 * jest の setupFiles から読み込まれる chrome API 最小モック。
 * 個別テスト側で必要なメソッドを上書きして使う。
 */
const chromeMock: unknown = {
  runtime: {
    getURL: (path: string) => `chrome-extension://test/${path}`,
    openOptionsPage: () => undefined,
    onInstalled: {
      addListener: () => undefined,
    },
  },
  tabs: {
    create: () => undefined,
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
    },
  },
  identity: {
    getAuthToken: () => undefined,
    getProfileUserInfo: () => undefined,
    removeCachedAuthToken: () => undefined,
  },
};

(globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
