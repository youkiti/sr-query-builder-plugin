/**
 * Options 画面の起動ロジック。
 * 現段階では API キーの保存フォームだけを動かす。
 */

export interface OptionsDeps {
  /** chrome.storage.local から既存値を読み取る */
  readKey: (key: string) => Promise<string | undefined>;
  /** chrome.storage.local へ書き込む */
  writeKey: (key: string, value: string) => Promise<void>;
}

const STORAGE_KEY_GEMINI = 'apiKeys.gemini';

export function createChromeOptionsDeps(): OptionsDeps {
  return {
    readKey: async (key) => {
      const result = await chrome.storage.local.get(key);
      const value = result[key];
      return typeof value === 'string' ? value : undefined;
    },
    writeKey: async (key, value) => {
      await chrome.storage.local.set({ [key]: value });
    },
  };
}

export async function startOptions(doc: Document, deps: OptionsDeps): Promise<void> {
  const status = doc.getElementById('options-status');
  const input = doc.getElementById('gemini-api-key') as HTMLInputElement | null;
  const saveBtn = doc.getElementById('save-keys');

  const existing = await deps.readKey(STORAGE_KEY_GEMINI);
  if (input && existing !== undefined) {
    input.value = existing;
  }
  if (status) {
    status.textContent = existing ? 'API キーは保存済みです。' : 'API キーが未設定です。';
  }

  saveBtn?.addEventListener('click', () => {
    const value = input?.value ?? '';
    void deps.writeKey(STORAGE_KEY_GEMINI, value).then(() => {
      if (status) {
        status.textContent = '保存しました。';
      }
    });
  });
}
