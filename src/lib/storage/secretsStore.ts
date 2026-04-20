import type { ChromeStorageDeps } from './chromeStorage';

/**
 * BYOK な API キー類を `chrome.storage.local` に保存するための
 * ストレージキー定義 + アクセサ。
 *
 * 要件 §3.2 の `apiKeys.*` 仕様を 1 か所に集約する。キー名を
 * 各所（Options / services / projectStore）に散らすと typo で拾い損ねる恐れが
 * あるので、必ずここ経由で参照する。
 *
 * 値の読み出しは「空文字列 → `null`」にそろえ、呼び出し側で「未設定」判定を
 * 統一できるようにする（要件 §4.9「LLM プロバイダ抽象化」と整合）。
 */

export const SECRET_KEYS = {
  gemini: 'apiKeys.gemini',
  openai: 'apiKeys.openai',
  anthropic: 'apiKeys.anthropic',
  openrouter: 'apiKeys.openrouter',
  ncbi: 'apiKeys.ncbi',
} as const;

export type SecretKeyName = keyof typeof SECRET_KEYS;

/**
 * シークレット文字列を読み取る。未定義 / 空文字は `null` に正規化する。
 */
export async function readSecret(
  deps: ChromeStorageDeps,
  name: SecretKeyName
): Promise<string | null> {
  const value = await deps.read<string>(SECRET_KEYS[name]);
  if (value === undefined || value === '') {
    return null;
  }
  return value;
}

/**
 * シークレット文字列を書き込む（空文字許容 = 明示的に未設定状態にする用途）。
 */
export async function writeSecret(
  deps: ChromeStorageDeps,
  name: SecretKeyName,
  value: string
): Promise<void> {
  await deps.write({ [SECRET_KEYS[name]]: value });
}
