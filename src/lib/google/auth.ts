/**
 * Chrome の identity API 周りの薄いラッパ。
 * chrome.identity.getAuthToken は MV3 では Promise 版も提供されているが
 * 型定義を揺らさないようコールバック版を明示的に Promise 化する。
 */

export interface AuthDeps {
  /** OAuth アクセストークンを取得（失効・未同意時は interactive=true で同意フロー起動） */
  getAuthToken: (options?: { interactive?: boolean }) => Promise<string>;
  /** 失効したトークンをキャッシュから除去 */
  removeCachedAuthToken: (token: string) => Promise<void>;
}

export function createChromeAuthDeps(): AuthDeps {
  return {
    getAuthToken: (options = {}) =>
      new Promise<string>((resolve, reject) => {
        chrome.identity.getAuthToken(options, (token) => {
          const err = chrome.runtime.lastError;
          if (err || !token) {
            reject(new Error(err?.message ?? 'getAuthToken returned empty token'));
            return;
          }
          resolve(token);
        });
      }),
    removeCachedAuthToken: (token) =>
      new Promise<void>((resolve) => {
        chrome.identity.removeCachedAuthToken({ token }, () => resolve());
      }),
  };
}

/**
 * トークンを取得する薄いヘルパ。呼び出し側が毎回オプションを書かずに済むようにする。
 */
export async function getAccessToken(deps: AuthDeps, interactive = false): Promise<string> {
  return deps.getAuthToken({ interactive });
}

/**
 * 401 を受けたときにキャッシュを無効化してから再取得するリトライループ用のヘルパ。
 */
export async function refreshAccessToken(
  deps: AuthDeps,
  staleToken: string
): Promise<string> {
  await deps.removeCachedAuthToken(staleToken);
  return deps.getAuthToken({ interactive: true });
}
