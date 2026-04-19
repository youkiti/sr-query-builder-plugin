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
    getAccessToken: () => getAccessToken(a, false),
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
