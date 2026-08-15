/**
 * Google Picker 許可ページ（GitHub Pages 配信）の URL 組み立てと、その戻り値の解析。
 *
 * OAuth スコープを `drive.file` 1 本に絞っている都合上、他人が作った共有スプレッドシートは
 * 「ユーザーが Picker で明示的に選択する」までアプリから読めない（403/404 になる）。
 * MV3 の CSP（`script-src 'self'`）により拡張ページ内に Picker（apis.google.com のリモート
 * スクリプト）を埋め込めないため、Picker は GitHub Pages 側の picker.html でホストし、
 * 拡張側は `chrome.identity.launchWebAuthFlow` でそのページを開いてリダイレクトを捕捉する。
 *
 * このモジュールは拡張側（背景 SW）と Picker ページ側の両方から import される。
 * chrome.* に依存させないこと（Picker ページは拡張の外で動く）。
 */

// webpack DefinePlugin がビルド時に文字列リテラルへ置換するグローバル定数。
// Picker ページをローカル配信して検証するための上書き用で、dev ビルドでのみ値が入る
// （本番ビルドは webpack 側が空文字を注入するので、localhost が焼き込まれることはない）。
declare const __PICKER_PAGE_URL__: string;

const DEFAULT_PICKER_PAGE_URL = 'https://youkiti.github.io/sr-query-builder-plugin/picker.html';

// jest は DefinePlugin を通さないため `__PICKER_PAGE_URL__` が未宣言のままになる。
// typeof は未宣言の識別子でも例外を投げないので、これを未設定判定に使う（素の参照は ReferenceError）。
export const PICKER_PAGE_URL =
  typeof __PICKER_PAGE_URL__ !== 'undefined' && __PICKER_PAGE_URL__
    ? __PICKER_PAGE_URL__
    : DEFAULT_PICKER_PAGE_URL;

export interface BuildPickerUrlOptions {
  /** 開かせたいスプレッドシート ID。省略すると全スプレッドシート表示になる */
  spreadsheetId?: string;
  /** アカウント照合用のログイン中メールアドレス（login_hint 兼 一致確認） */
  email?: string;
  /** 選択結果の戻り先（chrome.identity.getRedirectURL(...)） */
  redirectUri: string;
  /** 配信 URL の上書き（テスト用） */
  baseUrl?: string;
}

/**
 * Picker ページの URL を組み立てる。
 *
 * パラメータはクエリではなく URL フラグメントで渡す。フラグメントは HTTP リクエストに
 * 送信されないため、メールアドレスやスプレッドシート ID が配信サーバーのログや
 * ブラウザ履歴の共有対象に残らない。
 */
export function buildPickerUrl(options: BuildPickerUrlOptions): string {
  const { spreadsheetId, email, redirectUri, baseUrl = PICKER_PAGE_URL } = options;
  const params = new URLSearchParams();
  params.set('redirect', redirectUri);
  if (spreadsheetId) params.set('fileId', spreadsheetId);
  if (email) params.set('email', email);
  return `${baseUrl}#${params.toString()}`;
}

/**
 * redirect パラメータが拡張機能の chromiumapp.org リダイレクト URI かどうかを検証する純粋関数。
 *
 * Picker ページはこの検証を通った場合だけ `window.location.href` で遷移する。redirect は
 * URL フラグメント経由で外から渡ってくる値なので、拡張機能自身が発行したリダイレクト URI
 * であることを確認してからでないとオープンリダイレクトの踏み台になる。
 * 拡張機能 ID は a〜p の 32 文字（Chrome の仕様）。
 */
export function isExtensionRedirectUri(url: string): boolean {
  return /^https:\/\/[a-p]{32}\.chromiumapp\.org\//.test(url);
}

/** Picker ページから戻ってきた結果。null は解釈不能（呼び出し側でエラー表示する） */
export type PickerRedirectResult = { picked: string } | 'cancelled' | null;

/**
 * `chrome.identity.launchWebAuthFlow` が返すリダイレクト URL を解析する。
 *
 * Picker ページ（拡張の外・別オリジン）が書き込んだ値なので、形状を信用せずに検証する。
 */
export function parsePickerRedirect(redirectUrl: string): PickerRedirectResult {
  let hash: string;
  try {
    hash = new URL(redirectUrl).hash.replace(/^#/, '');
  } catch {
    return null;
  }
  const params = new URLSearchParams(hash);
  if (params.get('cancelled') === '1') return 'cancelled';
  const picked = params.get('picked');
  if (!picked) return null;
  return { picked };
}
