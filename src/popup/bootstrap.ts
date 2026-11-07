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
import { t, getUiLanguage, localizeDom, onUiLanguageChange, setUiLanguage } from '@/lib/i18n';
import { loadUiLanguage, subscribeUiLanguage } from '@/lib/i18n/uiLanguageStore';

import {
  createChromeRuntimeDeps,
  createNewProject,
  resolveSelectedModelKey,
  loadExistingProject,
  type ChromeRuntimeDeps,
} from '@/app/services';
import { GoogleApiError, getCurrentUserEmail, isAccessDeniedStatus } from '@/lib/google';
import { PICKER_GRANT_MESSAGE, type PickerGrantResult } from '@/background/pickerGrant';
import {
  getRecentProjects,
  setCurrentProject,
  type CurrentProjectEntry,
} from '@/features/project';

// webpack DefinePlugin が注入するビルド日付（YYYY-MM-DD）
declare const __BUILD_DATE__: string;

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
  /**
   * Google Picker による共有スプレッドシートのアクセス許可を背景 service worker に依頼する。
   * popup.html は通常タブとして開かれる（フォーカスを失っても閉じない）ため、この Promise は
   * 通常どおり解決する。処理の本体（プロジェクト登録・メインビュー起動）は背景側で完結するので、
   * この Promise はあくまで popup タブ側の表示更新用。
   */
  requestPickerGrant: (spreadsheetId: string) => Promise<PickerGrantResult>;
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
      chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') + '#/settings' });
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
    requestPickerGrant: (spreadsheetId) =>
      chrome.runtime.sendMessage({
        type: PICKER_GRANT_MESSAGE,
        spreadsheetId,
      }) as Promise<PickerGrantResult>,
  };
}

export async function startPopup(doc: Document, deps: PopupDeps): Promise<void> {
  setUiLanguage(await loadUiLanguage());
  const refreshLanguage = (): void => {
    localizeDom(doc);
    refreshText(doc);
    doc.documentElement.lang = getUiLanguage();
  };
  refreshLanguage();
  const unsubscribeLanguage = onUiLanguageChange(refreshLanguage);
  const unsubscribeStorage = subscribeUiLanguage();
  doc.defaultView?.addEventListener('pagehide', () => {
    unsubscribeLanguage();
    unsubscribeStorage();
  }, { once: true });
  const buildDateEl = doc.getElementById('popup-build-date');
  if (buildDateEl) {
    buildDateEl.textContent = `build: ${__BUILD_DATE__}`;
  }
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
    if (status) setText(status, () => t('popup.loginRequired'));
    return;
  }

  await renderAccount(doc, deps);
  const recent = await getRecentProjects(deps.runtime.store);
  renderRecent(doc, recent, deps);
  if (status) {
    setText(status, () => recent.length > 0
        ? t('popup.chooseRecent')
        : t('popup.chooseNew'));
  }
}

async function renderAccount(doc: Document, deps: PopupDeps): Promise<void> {
  const emailSpan = doc.getElementById('popup-email');
  if (!emailSpan) return;
  try {
    const email = await getCurrentUserEmail(deps.runtime.profile);
    setText(emailSpan, () => email ?? t('popup.unknown'));
  } catch {
    setText(emailSpan, () => t('popup.unknown'));
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
    setText(btn, () => `${entry.title} — ${entry.projectId.slice(0, 8)}`);
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
 * メインビュー遷移前に選択モデルのプロバイダの API キーの有無をチェックする。
 * 未設定なら保存後に自動でメインビューへ戻れるよう pending フラグを立て、Options 画面へ誘導する。
 */
async function openAppOrRedirect(doc: Document, deps: PopupDeps): Promise<void> {
  const { apiKey, providerName } = await resolveSelectedModelKey(deps.runtime.store);
  if (apiKey !== null) {
    deps.openAppTab();
    return;
  }
  await deps.runtime.store.write({ [STORAGE_KEY_PENDING_APP_TAB]: '1' });
  const status = doc.getElementById('popup-status');
  if (status) {
    setText(status, () => t('popup.missingKey', { providerName }));
  }
  deps.openOptions();
}

function bindLoginButton(doc: Document, deps: PopupDeps): void {
  const btn = doc.getElementById('login-button') as HTMLButtonElement | null;
  const error = doc.getElementById('login-error');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (error) setText(error, () => '');
    btn.disabled = true;
    void deps
      .signIn()
      .then(async (ok) => {
        btn.disabled = false;
        if (!ok) {
          if (error) {
            setText(error, () => t('popup.loginFailed'));
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
  const submitBtn = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (error) setText(error, () => '');
    let dotTimer: ReturnType<typeof setInterval> | null = null;
    if (submitBtn) {
      submitBtn.disabled = true;
      let dots = 0;
      const dotLabels = ['.', '..', '...'];
      setText(submitBtn, () => t('popup.creating', { dots: dotLabels[0]! }));
      dotTimer = setInterval(() => {
        dots = (dots + 1) % dotLabels.length;
        if (submitBtn) setText(submitBtn, () => t('popup.creating', { dots: dotLabels[dots]! }));
      }, 400);
    }
    void createNewProject(titleInput.value, deps.runtime)
      .then(async () => {
        titleInput.value = '';
        await openAppOrRedirect(doc, deps);
      })
      .catch((err: unknown) => {
        if (dotTimer !== null) clearInterval(dotTimer);
        if (error) setText(error, () => formatError(err));
        if (submitBtn) {
          submitBtn.disabled = false;
          setText(submitBtn, () => t('popup.create'));
        }
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
    if (error) setText(error, () => '');
    void openById(doc, deps, idInput.value.trim(), idInput);
  });
}

/**
 * ID 指定でプロジェクトを開く。403/404（＝ Picker で未選択の共有シートの可能性）のときだけ、
 * エラー文言ではなく許可導線を出す。
 */
async function openById(
  doc: Document,
  deps: PopupDeps,
  spreadsheetId: string,
  idInput: HTMLInputElement
): Promise<void> {
  const error = doc.getElementById('popup-open-error');
  // 前回の試行で出した許可導線を畳んでから開き直す（再試行もここを通る）
  clearPickerGuidance(doc);
  try {
    await loadExistingProject(spreadsheetId, deps.runtime);
    idInput.value = '';
    await openAppOrRedirect(doc, deps);
  } catch (err) {
    if (err instanceof GoogleApiError && isAccessDeniedStatus(err.status)) {
      showPickerGuidance(doc, deps, spreadsheetId, idInput, err);
      return;
    }
    if (error) setText(error, () => formatError(err));
  }
}

function clearPickerGuidance(doc: Document): void {
  const container = doc.getElementById('popup-open-guidance');
  if (!container) return;
  container.innerHTML = '';
  container.hidden = true;
}

/**
 * 共有スプレッドシートのアクセス許可導線を出す。
 *
 * 文言で 403/404 を「Picker 未選択」と断定しないこと。同じステータスは「シートが削除された」
 * 「ID が誤っている」「そもそも自分のアカウントに共有されていない」でも返るため、許可しても
 * 開けなかったときにユーザーが次に何を疑えばよいか分からなくなる。
 * 代わりに、実際に返ってきた API エラー（`err`）を機械的な補足情報として別行に出す。
 * ID の打ち間違い（多くは 404）はこの行で気づける。
 */
function showPickerGuidance(
  doc: Document,
  deps: PopupDeps,
  spreadsheetId: string,
  idInput: HTMLInputElement,
  err: unknown
): void {
  const container = doc.getElementById('popup-open-guidance');
  const error = doc.getElementById('popup-open-error');
  if (!container) {
    // 導線を置く場所が無い DOM では、せめて理由を文字で伝える
    if (error) {
      setText(error, () => t('popup.noPermission'));
    }
    return;
  }
  container.innerHTML = '';
  container.hidden = false;

  const message = doc.createElement('p');
  setText(message, () => t('popup.grantHint'));
  container.appendChild(message);

  const hint = doc.createElement('p');
  hint.className = 'popup__guidance-hint';
  setText(hint, () => t('popup.grantTrouble'));
  container.appendChild(hint);

  const detail = doc.createElement('p');
  detail.className = 'popup__guidance-detail';
  setText(detail, () => t('popup.errorDetail', { error: formatError(err) }));
  container.appendChild(detail);

  const status = doc.createElement('p');
  status.className = 'popup__guidance-hint';
  status.setAttribute('role', 'status');
  container.appendChild(status);

  const actions = doc.createElement('div');
  actions.className = 'popup__guidance-actions';

  const grantBtn = doc.createElement('button');
  grantBtn.type = 'button';
  grantBtn.className = 'popup__button popup__button--primary';
  setText(grantBtn, () => t('popup.grant'));
  grantBtn.addEventListener('click', () => {
    grantBtn.disabled = true;
    setText(status, () => t('popup.grantOpening'));
    void deps
      .requestPickerGrant(spreadsheetId)
      .then((result) => {
        writeGrantOutcome(doc, status, grantBtn, () => describeGrantResult(result));
      })
      .catch((err: unknown) => {
        writeGrantOutcome(doc, status, grantBtn, () => t('popup.grantFailed', { error: formatError(err) }));
      });
  });
  actions.appendChild(grantBtn);

  const retryBtn = doc.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'popup__button';
  setText(retryBtn, () => t('popup.retry'));
  retryBtn.addEventListener('click', () => {
    retryBtn.disabled = true;
    setText(status, () => '');
    void openById(doc, deps, spreadsheetId, idInput).finally(() => {
      retryBtn.disabled = false;
    });
  });
  actions.appendChild(retryBtn);

  container.appendChild(actions);
}

/**
 * 許可依頼（`requestPickerGrant`）の結果をユーザーへ届ける。
 *
 * 「再試行」ボタン経由で `openById` → `clearPickerGuidance`（`container.innerHTML = ''`）が
 * 走ると、ここで受け取った `status` / `grantBtn` は既に文書から外れている可能性がある
 * （このハンドラは popup タブが開いたままなら通常どおり解決するが、その間にユーザーが
 * 「再試行」を押して導線を畳み直しているケース）。その場合は現在表示中の導線コンテナを
 * 取得し直し、そこにまだ status 要素が残っていればそちらへ、無ければ `#popup-open-error` へ
 * フォールバックして結果を伝える。何も起きないまま結果が消えることは避ける。
 */
function writeGrantOutcome(
  doc: Document,
  status: HTMLElement,
  grantBtn: HTMLButtonElement,
  message: () => string
): void {
  if (status.isConnected) {
    grantBtn.disabled = false;
    setText(status, message);
    return;
  }
  const container = doc.getElementById('popup-open-guidance');
  const currentStatus = container?.querySelector<HTMLElement>('[role="status"]') ?? null;
  if (currentStatus) {
    setText(currentStatus, message);
    return;
  }
  const error = doc.getElementById('popup-open-error');
  if (error) setText(error, message);
}

function describeGrantResult(result: PickerGrantResult): string {
  switch (result.status) {
    case 'granted':
      return t('popup.granted');
    case 'cancelled':
      return t('popup.cancelled');
    case 'busy':
      return t('popup.busy');
    default:
      return t('popup.grantFailed', { error: result.message });
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const localizedText = new WeakMap<Document, Map<HTMLElement, () => string>>();

function setText(element: HTMLElement, render: () => string): void {
  let entries = localizedText.get(element.ownerDocument);
  if (!entries) {
    entries = new Map();
    localizedText.set(element.ownerDocument, entries);
  }
  entries.set(element, render);
  element.textContent = render();
}

function refreshText(doc: Document): void {
  for (const [element, render] of localizedText.get(doc) ?? []) {
    if (doc.contains(element)) {
      element.textContent = render();
    } else {
      localizedText.get(doc)?.delete(element);
    }
  }
}
