/**
 * Google Picker 許可ページ（GitHub Pages 配信 / 拡張機能の外で動く）。
 *
 * 背景: OAuth スコープを `drive.file` 1 本に絞っているため、他人が作った共有スプレッドシートは
 * ユーザーが Picker で明示的に選択するまでアプリから読めない（403/404）。MV3 の CSP により
 * 拡張ページ内に Picker（apis.google.com のリモートスクリプト）を埋め込めないので、このページを
 * GitHub Pages でホストし、拡張機能は `chrome.identity.launchWebAuthFlow` でここを開いて
 * 結果をリダイレクト（chromiumapp.org）で受け取る。
 *
 * 前提: このページの Web OAuth クライアントは、拡張機能の OAuth クライアントと**同一の
 * GCP プロジェクト**に属していなければならない。`drive.file` の付与はプロジェクト（アプリ）単位
 * なので、別プロジェクトのクライアントで選択させても拡張側のトークンでは読めない。
 *
 * 入力はすべて URL フラグメント（`#redirect=...&fileId=...&email=...`）で受け取る。
 * クエリ文字列を使わないのは、メールアドレスを配信サーバーのログに残さないため。
 */

import { isExtensionRedirectUri } from '@/lib/google/pickerUrl';

// webpack DefinePlugin（webpack.picker.config.js）がビルド時に注入する。
declare const __PICKER_API_KEY__: string;
declare const __PICKER_WEB_CLIENT_ID__: string;
declare const __GCP_PROJECT_NUMBER__: string;

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
// アカウント照合（Picker 表示前に「拡張でログイン中のアカウントと同一か」を確かめる）に必要。
const USERINFO_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';
/** gsi/client と api.js は async 属性で読み込むので、参照前に出現を待つ */
const SCRIPT_WAIT_TIMEOUT_MS = 15000;

type Lang = 'ja' | 'en';

interface Messages {
  ownedViewLabel: string;
  sharedViewLabel: string;
  invalidRedirect: string;
  connecting: string;
  waitingPicker: string;
  success: string;
  cancelled: string;
  wrongAccount: (expected: string) => string;
  error: (detail: string) => string;
}

const MESSAGES: Record<Lang, Messages> = {
  ja: {
    ownedViewLabel: 'マイドライブ',
    sharedViewLabel: '共有アイテム',
    invalidRedirect:
      'このページは拡張機能から開いてください（戻り先が指定されていないか、正しくありません）。',
    connecting: 'Google に接続しています…',
    waitingPicker: 'ファイル選択画面を開いています…',
    success: '許可しました。拡張機能の画面に戻ります…',
    cancelled: '選択をキャンセルしました。もう一度お試しください。',
    wrongAccount: (expected) =>
      `別のアカウントで許可されました。拡張機能でログイン中のアカウント（${expected}）で許可し直してください。`,
    error: (detail) => `エラーが発生しました: ${detail}`,
  },
  en: {
    ownedViewLabel: 'My Drive',
    sharedViewLabel: 'Shared with me',
    invalidRedirect:
      'Please open this page from the extension (the return address is missing or invalid).',
    connecting: 'Connecting to Google...',
    waitingPicker: 'Opening the file picker...',
    success: 'Access granted. Returning to the extension...',
    cancelled: 'Selection cancelled. Please try again.',
    wrongAccount: (expected) =>
      `You granted access with a different account. Please retry with the account signed in to the extension (${expected}).`,
    error: (detail) => `Something went wrong: ${detail}`,
  },
};

/** lang.js が <html data-lang> を確定させているので、そこから表示言語を読む */
function currentLang(): Lang {
  return document.documentElement.getAttribute('data-lang') === 'en' ? 'en' : 'ja';
}

function t(): Messages {
  return MESSAGES[currentLang()];
}

function hashParams(): URLSearchParams {
  return new URLSearchParams(window.location.hash.replace(/^#/, ''));
}

function setStatus(message: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = message;
}

/** async で読み込まれる gsi/client と api.js の両方が使えるようになるまで待つ */
function waitForGoogleApis(): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const timer = window.setInterval(() => {
      if (typeof google !== 'undefined' && google.accounts?.oauth2 && typeof gapi !== 'undefined') {
        window.clearInterval(timer);
        resolve();
        return;
      }
      if (performance.now() - started > SCRIPT_WAIT_TIMEOUT_MS) {
        window.clearInterval(timer);
        reject(new Error('Google API scripts did not load'));
      }
    }, 100);
  });
}

function loadPicker(): Promise<void> {
  return new Promise((resolve) => gapi.load('picker', resolve));
}

function requestToken(email: string | null): Promise<google.accounts.oauth2.TokenResponse> {
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: __PICKER_WEB_CLIENT_ID__,
      scope: `${DRIVE_FILE_SCOPE} ${USERINFO_SCOPE}`,
      login_hint: email ?? undefined,
      // 既定は true。過去に許可した広いスコープを引き継がせないために明示的に false にする
      include_granted_scopes: false,
      callback: (resp) => (resp.error ? reject(new Error(resp.error)) : resolve(resp)),
      error_callback: (err) => reject(new Error(err.type)),
    });
    client.requestAccessToken({ prompt: 'consent' });
  });
}

/** TokenResponse にメールアドレスは含まれないため、userinfo で取得して照合する */
async function fetchUserEmail(token: string): Promise<string> {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`userinfo ${response.status}`);
  const data = (await response.json()) as { email?: string };
  if (!data.email) throw new Error('userinfo email missing');
  return data.email;
}

function redirectToExtension(redirectUri: string, fragment: string): void {
  // start() で検証済みだが、遷移直前にもう一度見る（オープンリダイレクトの最終防衛線）
  if (!isExtensionRedirectUri(redirectUri)) {
    setStatus(t().invalidRedirect);
    return;
  }
  window.location.href = `${redirectUri}#${fragment}`;
}

/**
 * スプレッドシート選択用の Picker を開く。
 *
 * マイドライブ向けビューに加えて共有アイテム向けビュー（`setOwnedByMe(false)`）も足す。
 * 既定の DocsView はマイドライブ配下だけが対象で、「共有されただけでマイドライブに追加して
 * いない」スプレッドシートは一覧にも検索結果にも出てこない（＝この機能が救おうとしている
 * ケースそのものが表示されない）。fileId による絞り込みも両方のビューへ同一に適用する。
 */
function openPicker(token: string, fileId: string | null, redirectUri: string): void {
  const messages = t();
  const buildView = (label: string, ownedByMe: boolean): google.picker.DocsView => {
    const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS);
    if (!ownedByMe) view.setOwnedByMe(false);
    view.setLabel(label);
    if (fileId) view.setFileIds(fileId);
    return view;
  };

  const picker = new google.picker.PickerBuilder()
    .setDeveloperKey(__PICKER_API_KEY__)
    .setAppId(__GCP_PROJECT_NUMBER__)
    .setOAuthToken(token)
    .addView(buildView(messages.ownedViewLabel, true))
    .addView(buildView(messages.sharedViewLabel, false))
    .setLocale(currentLang())
    .setCallback((data) => {
      const action = data[google.picker.Response.ACTION];
      if (action === google.picker.Action.PICKED) {
        const picked = data[google.picker.Response.DOCUMENTS]?.[0];
        const id = picked?.[google.picker.Document.ID] ?? '';
        setStatus(messages.success);
        redirectToExtension(redirectUri, `picked=${encodeURIComponent(id)}`);
      } else if (action === google.picker.Action.CANCEL) {
        setStatus(messages.cancelled);
        redirectToExtension(redirectUri, 'cancelled=1');
      }
    })
    .build();
  picker.setVisible(true);
}

/**
 * 許可フローの本体。`ignoreFileId=true` は「対象シートが Picker に出てこない」ときに
 * 絞り込みを外して全スプレッドシートから選ばせるための再実行。
 *
 * `setFileIds` は「表示対象の限定」であって事前フォーカスではないため、ユーザーがそのファイルへの
 * Drive 共有権限を持たない場合は Picker に 1 件も表示されない。そこからの出口がこの導線。
 * href での開き直しにするとフラグメントの email が落ちてアカウント照合が効かなくなるので、
 * ページ遷移はせず同一ページ内で開き直す。
 */
async function start(ignoreFileId = false): Promise<void> {
  const params = hashParams();
  const redirectUri = params.get('redirect');
  const fileId = ignoreFileId ? null : params.get('fileId');
  const expectedEmail = params.get('email');

  if (!redirectUri || !isExtensionRedirectUri(redirectUri)) {
    setStatus(t().invalidRedirect);
    return;
  }

  try {
    setStatus(t().connecting);
    await waitForGoogleApis();
    const resp = await requestToken(expectedEmail);
    const token = resp.access_token;
    const actualEmail = await fetchUserEmail(token);
    if (expectedEmail && actualEmail.toLowerCase() !== expectedEmail.toLowerCase()) {
      // 別アカウントで許可されても拡張機能側からは読めない。トークンを捨ててやり直させる
      google.accounts.oauth2.revoke(token, () => undefined);
      setStatus(t().wrongAccount(expectedEmail));
      return;
    }
    setStatus(t().waitingPicker);
    await loadPicker();
    openPicker(token, fileId, redirectUri);
  } catch (error) {
    setStatus(t().error(error instanceof Error ? error.message : String(error)));
  }
}

function init(): void {
  const params = hashParams();
  const redirectUri = params.get('redirect');
  const startBtn = document.getElementById('startBtn') as HTMLButtonElement | null;
  const allSheetsLink = document.getElementById('allSheetsLink');

  // 拡張機能を経由せず直接開かれた場合は、ボタンを押させる前に理由を示して止める
  if (!redirectUri || !isExtensionRedirectUri(redirectUri)) {
    if (startBtn) startBtn.disabled = true;
    if (allSheetsLink) allSheetsLink.hidden = true;
    setStatus(t().invalidRedirect);
    return;
  }

  // fileId が無いときは最初から全スプレッドシート表示なので、切替導線は出さない
  if (allSheetsLink) {
    if (params.get('fileId')) {
      allSheetsLink.addEventListener('click', (event) => {
        event.preventDefault();
        void start(true);
      });
    } else {
      allSheetsLink.hidden = true;
    }
  }

  // ページ読み込み直後の自動起動はポップアップブロックに掛かるため、必ずボタン起点にする
  startBtn?.addEventListener('click', () => void start());
}

document.addEventListener('DOMContentLoaded', init);
