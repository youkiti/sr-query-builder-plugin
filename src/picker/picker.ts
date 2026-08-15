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

/**
 * granular consent でユーザーが要求スコープの一部だけを許可した場合を判定する。
 *
 * `google.accounts.oauth2.hasGrantedAllScopes` を直接呼ばず関数として受け取るのは、
 * webpack DefinePlugin が注入する `__PICKER_WEB_CLIENT_ID__` 等に依存する `requestToken` /
 * `openPicker` を経由せずにこの判定だけを単体テストできるようにするための最小限の seam。
 */
export function shouldRevokeForMissingScopes(
  resp: google.accounts.oauth2.TokenResponse,
  hasGrantedAllScopes: (
    tokenResponse: google.accounts.oauth2.TokenResponse,
    ...scopes: string[]
  ) => boolean
): boolean {
  return !hasGrantedAllScopes(resp, DRIVE_FILE_SCOPE, USERINFO_SCOPE);
}

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
  scopeDenied: string;
  error: (detail: string) => string;
  cancelReturn: string;
  filteredCancelled: string;
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
    scopeDenied:
      'ファイルを選択する権限（ドライブのファイル選択）が許可されませんでした。もう一度お試しのうえ、表示されるチェックをすべて有効にしてください。',
    error: (detail) => `エラーが発生しました: ${detail}`,
    cancelReturn: 'キャンセルして戻る',
    filteredCancelled:
      '選択をキャンセルしました。目的のスプレッドシートが見つからない場合は、ボタンから選び直せます。',
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
    scopeDenied:
      'Permission to pick a file (Drive file selection) was not granted. Please try again and make sure to leave all the checkboxes enabled on the consent screen.',
    error: (detail) => `Something went wrong: ${detail}`,
    cancelReturn: 'Cancel and go back',
    filteredCancelled:
      "Selection cancelled. If you can't find the spreadsheet you're looking for, choose again using the button.",
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

const CANCEL_RETURN_LINK_ID = 'cancelReturnLink';

/**
 * 絞り込み中（fileId 指定あり）の Picker が CANCEL されたときに出す、次の一手の選択肢。
 *
 * 絞り込みが効いていると、共有はされているが対象外の権限設定などで目的のシートが
 * Picker に 1 件も出てこないことがある。以前はここで即 `redirectToExtension` していたため、
 * ページに留まる間もなく拡張機能へ戻されてしまい、hint 文が案内する
 * 「すべてのスプレッドシートから選ぶ」を試す機会が無かった。
 *
 * 「すべてのスプレッドシートから選ぶ」は既存の `#allSheetsLink`（fileId 指定時は最初から
 * 表示されており、クリックで `start(true)` を呼ぶ）をそのまま使い回す。ここでは
 * 「キャンセルして戻る」側だけを動的に用意する（.picker-actions 末尾へ追加。二重生成は
 * しない）。
 */
function showFilteredCancelChoice(redirectUri: string): void {
  const messages = t();
  setStatus(messages.filteredCancelled);

  const allSheetsLink = document.getElementById('allSheetsLink') as HTMLAnchorElement | null;
  if (allSheetsLink) allSheetsLink.hidden = false;

  const actions = document.querySelector('.picker-actions');
  if (!actions) return;
  let cancelLink = document.getElementById(CANCEL_RETURN_LINK_ID) as HTMLAnchorElement | null;
  if (!cancelLink) {
    cancelLink = document.createElement('a');
    cancelLink.id = CANCEL_RETURN_LINK_ID;
    cancelLink.href = '#';
    cancelLink.className = 'picker-link';
    cancelLink.addEventListener('click', (event) => {
      event.preventDefault();
      redirectToExtension(redirectUri, 'cancelled=1');
    });
    actions.appendChild(cancelLink);
  }
  cancelLink.textContent = messages.cancelReturn;
  cancelLink.hidden = false;
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
        if (fileId) {
          // 絞り込み中の CANCEL はもう広げる先がある。即リダイレクトせず選択肢を出す。
          // モーダルを閉じるのは選択肢を押せるようにするためなので、Picker の既定の
          // 自動クローズ挙動には依存せずここで明示的に閉じる
          picker.setVisible(false);
          showFilteredCancelChoice(redirectUri);
        } else {
          // 絞り込み無し（既に全件表示済み）はこれ以上広げる先が無いので従来どおり即リダイレクト
          setStatus(messages.cancelled);
          redirectToExtension(redirectUri, 'cancelled=1');
        }
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
    // 参照だけを剥がして渡すと、GIS 実装が内部で this に依存していた場合に TypeError になりうる。
    // レシーバ（google.accounts.oauth2）を保ったまま呼び出すためアロー関数でラップする
    if (
      shouldRevokeForMissingScopes(resp, (tokenResponse, ...scopes) =>
        google.accounts.oauth2.hasGrantedAllScopes(tokenResponse, ...scopes)
      )
    ) {
      // granular consent でユーザーが drive.file を拒否した状態。使えないトークンのまま
      // Picker を開いても 403 で行き止まりになるだけなので、ここで止めてやり直させる
      google.accounts.oauth2.revoke(token, () => undefined);
      setStatus(t().scopeDenied);
      return;
    }
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
