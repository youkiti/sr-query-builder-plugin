/**
 * jest の setupFiles から読み込まれる chrome API 最小モック。
 * 個別テスト側で必要なメソッドを上書きして使う。
 */
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';

// jsdom はブラウザ API の一部だけを提供し、TextEncoder と crypto.subtle は未実装。
// 共通 setup で Node の実装を補い、既に API があるテスト環境では上書きしない。
if (typeof globalThis.TextEncoder === 'undefined') {
  Object.defineProperty(globalThis, 'TextEncoder', { value: TextEncoder, configurable: true });
}
if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
} else if (typeof globalThis.crypto.subtle === 'undefined') {
  Object.defineProperty(globalThis.crypto, 'subtle', { value: webcrypto.subtle, configurable: true });
}

// jsdom にない MV3 対象ブラウザの API を、fake timer で制御できる形で補う。
if (typeof AbortSignal.timeout === 'undefined') {
  AbortSignal.timeout = (ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('通信の期限切れ', 'TimeoutError')), ms);
    return controller.signal;
  };
}
if (typeof AbortSignal.any === 'undefined') {
  AbortSignal.any = (signals) => {
    const controller = new AbortController();
    const listeners = new Map<AbortSignal, () => void>();
    const abort = (signal: AbortSignal) => {
      controller.abort(signal.reason);
      for (const [source, listener] of listeners) source.removeEventListener('abort', listener);
      listeners.clear();
    };
    for (const signal of signals) {
      if (signal.aborted) { abort(signal); break; }
      const listener = () => abort(signal);
      listeners.set(signal, listener);
      signal.addEventListener('abort', listener, { once: true });
    }
    return controller.signal;
  };
}

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
