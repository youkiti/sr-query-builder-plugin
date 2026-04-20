import {
  createChromeAuthDeps,
  createChromeProfileDeps,
  getAccessToken,
  type AuthDeps,
  type GoogleApiDeps,
  type ProfileDeps,
} from '@/lib/google';
import { createChromeStoreDeps, type ProjectStoreDeps } from '@/features/project';

/**
 * Chrome 拡張ランタイムから各種 deps を組み立てる薄いファクトリ。
 * popup / app / options のエントリから呼び、各 service へ注入する。
 */

export function createChromeGoogleApiDeps(auth?: AuthDeps): GoogleApiDeps {
  const a = auth ?? createChromeAuthDeps();
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    // interactive=true: 未同意時は Chrome の OAuth 同意 UI を開き、
    // 同意済みならキャッシュされたトークンを即返す（UI は出ない）。
    // false だと初回常に "OAuth2 not granted or revoked" になり、
    // popup / app 双方でログイン導線が成立しないため true 固定とする。
    getAccessToken: () => getAccessToken(a, true),
  };
}

export interface ChromeRuntimeDeps {
  google: GoogleApiDeps;
  profile: ProfileDeps;
  store: ProjectStoreDeps;
}

export function createChromeRuntimeDeps(): ChromeRuntimeDeps {
  return {
    google: createChromeGoogleApiDeps(),
    profile: createChromeProfileDeps(),
    store: createChromeStoreDeps(),
  };
}
