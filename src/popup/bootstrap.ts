/**
 * Popup 画面の起動ロジック。popup.ts から呼ばれる。
 *
 * UI は 2 画面構成：
 * - 未ログイン: ログインボタンのみ表示（Google の同意 UI を明示的に起動）
 * - ログイン済: 最近のプロジェクト / 新規作成 / スプレッドシート ID で開く
 *
 * 任意のプロジェクト選択（作成・既存 ID・履歴クリック）は直後にメインビュータブを
 * 開くので、独立した「メインビューを開く」ボタンは持たない。
 *
 * すべての deps を引数注入するので OAuth 無しでテスト可能。
 */

import {
  createChromeRuntimeDeps,
  createNewProject,
  getGeminiApiKey,
  loadExistingProject,
  type ChromeRuntimeDeps,
} from '@/app/services';
import { getCurrentUserEmail } from '@/lib/google';
import {
  getRecentProjects,
  setCurrentProject,
  type CurrentProjectEntry,
} from '@/features/project';

/**
 * API キー未設定時の「後で Options から戻って開く」ための一時フラグ。
 * Options 保存時にフラグが立っていれば、保存直後にメインビューを開いてからフラグを畳む。
 */
export const STORAGE_KEY_PENDING_APP_TAB = 'pendingOpenAppTab';

export interface PopupDeps {
  /** メインビュー（app.html）を新規タブで開く */
  openAppTab: () => void;
  /** 設定画面（options.html）を開く */
  openOptions: () => void;
  /** projectService と chrome.storage 周りの依存をまとめた束 */
  runtime: ChromeRuntimeDeps;
  /** 既にログイン済みかを UI を出さずに確認（interactive=false 相当） */
  isAuthenticated: () => Promise<boolean>;
  /** Google OAuth 同意 UI を明示的に開く。true=成功 / false=失敗 */
  signIn: () => Promise<boolean>;
  /**
   * ログアウト。キャッシュされた OAuth トークンを削除し、
   * `chrome.storage.local` の `currentProject` / `recentProjects` もクリアする。
   * Google 側のトークン失効は行わない（Chrome の identity キャッシュからの除去のみ）。
   */
  signOut: () => Promise<void>;
}

export function createChromePopupDeps(): PopupDeps {
  const getToken = (interactive: boolean): Promise<string> =>
    new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        const err = chrome.runtime.lastError;
        if (err || !token) {
          reject(new Error(err?.message ?? 'getAuthToken returned empty token'));
          return;
        }
        resolve(token);
      });
    });
  const removeCachedToken = (token: string): Promise<void> =>
    new Promise((resolve) => {
      chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    });
  return {
    openAppTab: () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') });
    },
    openOptions: () => {
      chrome.runtime.openOptionsPage();
    },
    runtime: createChromeRuntimeDeps(),
    isAuthenticated: async () => {
      try {
        await getToken(false);
        return true;
      } catch {
        return false;
      }
    },
    signIn: async () => {
      try {
        await getToken(true);
        return true;
      } catch {
        return false;
      }
    },
    signOut: async () => {
      try {
        const token = await getToken(false);
        await removeCachedToken(token);
      } catch {
        // トークンが既に無ければ何もしない
      }
      // プロジェクト選択状態もユーザーに紐付くため一緒にクリア。
      // 別アカウントでログインし直しても他人の recent が残らない。
      await chrome.storage.local.remove(['currentProject', 'recentProjects']);
    },
  };
}

export async function startPopup(doc: Document, deps: PopupDeps): Promise<void> {
  bindLoginButton(doc, deps);
  bindLogoutButton(doc, deps);
  bindOpenOptionsButton(doc, deps);
  bindCreateForm(doc, deps);
  bindOpenForm(doc, deps);
  await refresh(doc, deps);
}

async function refresh(doc: Document, deps: PopupDeps): Promise<void> {
  const authed = await deps.isAuthenticated();
  const authSection = doc.getElementById('popup-auth') as HTMLElement | null;
  const projectsSection = doc.getElementById('popup-projects') as HTMLElement | null;
  const status = doc.getElementById('popup-status');

  if (authSection) authSection.hidden = authed;
  if (projectsSection) projectsSection.hidden = !authed;

  if (!authed) {
    if (status) status.textContent = 'ログインが必要です。';
    return;
  }

  await renderAccount(doc, deps);
  const recent = await getRecentProjects(deps.runtime.store);
  renderRecent(doc, recent, deps);
  if (status) {
    status.textContent =
      recent.length > 0
        ? '最近のプロジェクトから選ぶか、新しく作成してください。'
        : '新しいプロジェクトを作成するか、スプレッドシート ID から開いてください。';
  }
}

async function renderAccount(doc: Document, deps: PopupDeps): Promise<void> {
  const emailSpan = doc.getElementById('popup-email');
  if (!emailSpan) return;
  try {
    const email = await getCurrentUserEmail(deps.runtime.profile);
    emailSpan.textContent = email ?? '(不明)';
  } catch {
    emailSpan.textContent = '(不明)';
  }
}

function renderRecent(
  doc: Document,
  recent: CurrentProjectEntry[],
  deps: PopupDeps
): void {
  const section = doc.getElementById('popup-recent-section') as HTMLElement | null;
  const list = doc.getElementById('popup-recent') as HTMLElement | null;
  if (!section || !list) {
    return;
  }
  list.innerHTML = '';
  if (recent.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  for (const entry of recent) {
    const li = doc.createElement('li');
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = `${entry.title} — ${entry.projectId.slice(0, 8)}`;
    btn.addEventListener('click', () => {
      void openRecent(doc, deps, entry);
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function openRecent(
  doc: Document,
  deps: PopupDeps,
  entry: CurrentProjectEntry
): Promise<void> {
  await setCurrentProject(entry, deps.runtime.store);
  await openAppOrRedirect(doc, deps);
}

/**
 * メインビュー遷移前に Gemini API キーの有無をチェックする。
 * 未設定なら保存後に自動でメインビューへ戻れるよう pending フラグを立て、Options 画面へ誘導する。
 */
async function openAppOrRedirect(doc: Document, deps: PopupDeps): Promise<void> {
  const apiKey = await getGeminiApiKey(deps.runtime.store);
  if (apiKey !== null) {
    deps.openAppTab();
    return;
  }
  await deps.runtime.store.write({ [STORAGE_KEY_PENDING_APP_TAB]: '1' });
  const status = doc.getElementById('popup-status');
  if (status) {
    status.textContent =
      'Gemini APIキーが未設定です。設定画面で入力すると、保存後にトップ画面に戻ります。';
  }
  deps.openOptions();
}

function bindLoginButton(doc: Document, deps: PopupDeps): void {
  const btn = doc.getElementById('login-button') as HTMLButtonElement | null;
  const error = doc.getElementById('login-error');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (error) error.textContent = '';
    btn.disabled = true;
    void deps
      .signIn()
      .then(async (ok) => {
        btn.disabled = false;
        if (!ok) {
          if (error) {
            error.textContent =
              'ログインに失敗しました。ブラウザに Google アカウントが追加されているか確認してください。';
          }
          return;
        }
        await refresh(doc, deps);
      })
      .catch(() => {
        btn.disabled = false;
      });
  });
}

function bindLogoutButton(doc: Document, deps: PopupDeps): void {
  const btn = doc.getElementById('logout-button') as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    void deps
      .signOut()
      .then(() => refresh(doc, deps))
      .catch(() => {
        // ログアウト失敗時は UI を動かさずボタンだけ戻す（監査は LLMApiLog の対象外）
      })
      .finally(() => {
        btn.disabled = false;
      });
  });
}

function bindOpenOptionsButton(doc: Document, deps: PopupDeps): void {
  doc.getElementById('open-options')?.addEventListener('click', () => {
    deps.openOptions();
  });
}

function bindCreateForm(doc: Document, deps: PopupDeps): void {
  const form = doc.getElementById('popup-create-form') as HTMLFormElement | null;
  const titleInput = doc.getElementById('popup-create-title') as HTMLInputElement | null;
  const error = doc.getElementById('popup-create-error');
  if (!form || !titleInput) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (error) error.textContent = '';
    void createNewProject(titleInput.value, deps.runtime)
      .then(async () => {
        titleInput.value = '';
        await openAppOrRedirect(doc, deps);
      })
      .catch((err: unknown) => {
        if (error) error.textContent = formatError(err);
      });
  });
}

function bindOpenForm(doc: Document, deps: PopupDeps): void {
  const form = doc.getElementById('popup-open-form') as HTMLFormElement | null;
  const idInput = doc.getElementById('popup-open-id') as HTMLInputElement | null;
  const error = doc.getElementById('popup-open-error');
  if (!form || !idInput) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (error) error.textContent = '';
    void loadExistingProject(idInput.value, deps.runtime)
      .then(async () => {
        idInput.value = '';
        await openAppOrRedirect(doc, deps);
      })
      .catch((err: unknown) => {
        if (error) error.textContent = formatError(err);
      });
  });
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
