import { SECRET_KEYS, createChromeStorageDeps } from '@/lib/storage';

/**
 * Options 画面の起動ロジック。
 *
 * - Gemini API キー（LLM プロバイダ）
 * - NCBI API キー（E-utilities の 3→10 req/s 引き上げ用、任意）
 *
 * をそれぞれ chrome.storage.local に保存する。両者は 1 つの「保存」ボタンで
 * まとめて書き込み、UI 上はステータス文字列にまとめて結果を出す。
 *
 * 実際の chrome.storage アクセスは `lib/storage/chromeStorage.ts` に集約してあり、
 * ここでは「string 値の read/write に限定した細い API」を上に被せているだけ。
 * 既存テストがこの OptionsDeps インタフェースでモックしているため、互換性のために
 * シグネチャを維持している。
 */

export interface OptionsDeps {
  /** chrome.storage.local から既存値を読み取る */
  readKey: (key: string) => Promise<string | undefined>;
  /** chrome.storage.local へ書き込む */
  writeKey: (key: string, value: string) => Promise<void>;
}

export const STORAGE_KEY_GEMINI = SECRET_KEYS.gemini;
export const STORAGE_KEY_NCBI = SECRET_KEYS.ncbi;

export function createChromeOptionsDeps(): OptionsDeps {
  const storage = createChromeStorageDeps();
  return {
    readKey: async (key) => {
      const value = await storage.read<string>(key);
      return typeof value === 'string' ? value : undefined;
    },
    writeKey: async (key, value) => {
      await storage.write({ [key]: value });
    },
  };
}

export async function startOptions(doc: Document, deps: OptionsDeps): Promise<void> {
  const status = doc.getElementById('options-status');
  const geminiInput = doc.getElementById('gemini-api-key') as HTMLInputElement | null;
  const ncbiInput = doc.getElementById('ncbi-api-key') as HTMLInputElement | null;
  const saveBtn = doc.getElementById('save-keys');

  const existingGemini = await deps.readKey(STORAGE_KEY_GEMINI);
  const existingNcbi = await deps.readKey(STORAGE_KEY_NCBI);
  if (geminiInput && existingGemini !== undefined) {
    geminiInput.value = existingGemini;
  }
  if (ncbiInput && existingNcbi !== undefined) {
    ncbiInput.value = existingNcbi;
  }
  if (status) {
    status.textContent = buildInitialStatus(existingGemini, existingNcbi);
  }

  saveBtn?.addEventListener('click', () => {
    const gemini = geminiInput?.value ?? '';
    const ncbi = ncbiInput?.value ?? '';
    void Promise.all([
      deps.writeKey(STORAGE_KEY_GEMINI, gemini),
      deps.writeKey(STORAGE_KEY_NCBI, ncbi),
    ]).then(() => {
      if (status) {
        status.textContent = '保存しました。';
      }
    });
  });
}

function buildInitialStatus(gemini: string | undefined, ncbi: string | undefined): string {
  const parts: string[] = [];
  parts.push(gemini ? 'Gemini: 保存済み' : 'Gemini: 未設定');
  parts.push(ncbi ? 'NCBI: 保存済み' : 'NCBI: 未設定（3 req/s 枠）');
  return parts.join(' / ');
}
