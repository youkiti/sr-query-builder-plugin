/**
 * `chrome.storage.local` を型付きで扱うための薄いラッパ。
 *
 * これまで features/project/projectStore.ts や options/bootstrap.ts 等で
 * それぞれ独自に `chrome.storage.local.get/set` を呼んでいたのを、
 * ここで 1 つの `ChromeStorageDeps` に統合する。
 *
 * インタフェースは「単一キー読み取り」「複数キー同時書き込み」の 2 操作のみ。
 * 型引数で読み取り時の想定型を渡すが、runtime 検証は呼び出し側責任
 * （要件的にはここには 1 次ストア層しか置かず、zod 等は features 側で適用する）。
 */

export interface ChromeStorageDeps {
  /** 単一キーを読み取る。未定義なら `undefined`。 */
  read: <T>(key: string) => Promise<T | undefined>;
  /** 複数キーを 1 回の `set` で書き込む。 */
  write: (items: Record<string, unknown>) => Promise<void>;
}

/**
 * Chrome 拡張ランタイム用の既定実装。
 * `chrome.storage.local` が無い環境（テスト直叩き等）では呼び出し時に例外になる。
 */
export function createChromeStorageDeps(): ChromeStorageDeps {
  return {
    read: async <T>(key: string): Promise<T | undefined> => {
      const result = await chrome.storage.local.get(key);
      return result[key] as T | undefined;
    },
    write: async (items) => {
      await chrome.storage.local.set(items);
    },
  };
}
