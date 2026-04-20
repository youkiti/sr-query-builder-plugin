import type { EutilsDeps } from '@/lib/ncbi';
import type { ProjectStoreDeps } from '@/features/project';
import type { GoogleApiDeps } from '@/lib/google';
import { SECRET_KEYS, readSecret } from '@/lib/storage';

/**
 * NCBI E-utilities 用の設定サービス。
 *
 * - chrome.storage に保存された BYOK の API キーを読み取って EutilsDeps に流し込む
 * - キーが未設定でも `EutilsDeps` は成立する（3 req/s 枠で動作）
 *
 * Options 画面 (`options/bootstrap.ts`) が書き込むキーを、メインビュー側から
 * 読み取るときの唯一の入口。どの service も直接 chrome.storage を触らず、
 * ここ経由で取得する。
 */

/** @deprecated `SECRET_KEYS.ncbi` を使うこと。後方互換で残す */
export const STORAGE_KEY_NCBI = SECRET_KEYS.ncbi;

export async function getNcbiApiKey(store: ProjectStoreDeps): Promise<string | null> {
  return readSecret(store, 'ncbi');
}

export interface BuildEutilsDepsOptions {
  google: GoogleApiDeps;
  store: ProjectStoreDeps;
}

/**
 * 保存された NCBI API キーを読み取り、`EutilsDeps` を組み立てる。
 * キーが無い場合は `apiKey` 未設定のまま返す（3 req/s 枠）。
 */
export async function buildEutilsDeps(opts: BuildEutilsDepsOptions): Promise<EutilsDeps> {
  const apiKey = await getNcbiApiKey(opts.store);
  const deps: EutilsDeps = { fetch: opts.google.fetch };
  if (apiKey !== null) {
    deps.apiKey = apiKey;
  }
  return deps;
}
