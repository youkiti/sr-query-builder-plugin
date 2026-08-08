/**
 * `chrome.identity` のモック。
 *
 * OAuth 同意画面を一切出さず、常にログイン済み（`demo@example.com`）として振る舞う。
 * `src/lib/google/auth.ts` の `createChromeAuthDeps()` と
 * `src/lib/google/identity.ts` の `createChromeProfileDeps()`、および
 * `src/popup/bootstrap.ts` が直接呼ぶ `chrome.identity.getAuthToken` /
 * `removeCachedAuthToken` は、いずれもコールバック形式でこの 3 関数だけを呼ぶ
 * ため、この 3 つを差し替えれば全経路をカバーできる。
 *
 * 実在のメールアドレスを一切画面に出さないという制約（video/REQUIREMENTS.md）を
 * 満たすため、メールは固定で `demo@example.com` を返す。
 */

const DEMO_TOKEN = 'demo-oauth-token';
/** 実在のメールアドレスを画面に出さないための固定アドレス（seeds.ts からも参照する）。 */
export const DEMO_EMAIL = 'demo@example.com';
const DEMO_ACCOUNT_ID = 'demo-account-id';

export function installDemoIdentity(): void {
  chrome.identity.getAuthToken = ((
    _details: unknown,
    callback?: (token?: string) => void
  ) => {
    callback?.(DEMO_TOKEN);
  }) as unknown as typeof chrome.identity.getAuthToken;

  chrome.identity.removeCachedAuthToken = ((
    _details: unknown,
    callback?: () => void
  ) => {
    callback?.();
  }) as unknown as typeof chrome.identity.removeCachedAuthToken;

  chrome.identity.getProfileUserInfo = ((
    _details: unknown,
    callback?: (info: { email: string; id: string }) => void
  ) => {
    callback?.({ email: DEMO_EMAIL, id: DEMO_ACCOUNT_ID });
  }) as unknown as typeof chrome.identity.getProfileUserInfo;
}
