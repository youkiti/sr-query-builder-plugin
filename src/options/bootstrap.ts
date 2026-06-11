/**
 * Options 画面の起動ロジック。
 *
 * - Gemini API キー（LLM プロバイダ）
 * - NCBI API キー（E-utilities の 3→10 req/s 引き上げ用、任意）
 *
 * をそれぞれ chrome.storage.local に保存する。両者は 1 つの「保存」ボタンで
 * まとめて書き込み、UI 上はステータス文字列にまとめて結果を出す。
 */

export interface OptionsDeps {
  /** chrome.storage.local から既存値を読み取る */
  readKey: (key: string) => Promise<string | undefined>;
  /** chrome.storage.local へ書き込む */
  writeKey: (key: string, value: string) => Promise<void>;
  /** chrome.storage.local からキーを削除する（pending フラグのクリア用） */
  removeKey: (key: string) => Promise<void>;
  /** メインビュー（app.html）を新規タブで開く。pending フラグが立っているときのみ呼ばれる */
  openAppTab: () => void;
}

export const STORAGE_KEY_GEMINI = 'apiKeys.gemini';
export const STORAGE_KEY_NCBI = 'apiKeys.ncbi';
/** Popup で API キー未設定を検知したときに立てるフラグ。保存成功で畳む。 */
export const STORAGE_KEY_PENDING_APP_TAB = 'pendingOpenAppTab';

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
    removeKey: async (key) => {
      await chrome.storage.local.remove(key);
    },
    openAppTab: () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') });
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
    ])
      .then(async () => {
        const pendingNow = await deps.readKey(STORAGE_KEY_PENDING_APP_TAB);
        if (pendingNow === '1' && gemini.trim() !== '') {
          await deps.removeKey(STORAGE_KEY_PENDING_APP_TAB);
          if (status) {
            status.textContent = '保存しました。トップ画面に戻ります…';
          }
          deps.openAppTab();
          return;
        }
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
