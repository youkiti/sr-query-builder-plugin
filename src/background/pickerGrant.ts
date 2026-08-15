/**
 * Google Picker によるアクセス許可フロー（背景 service worker 側）。
 *
 * OAuth スコープが `drive.file` 1 本なので、他人が作った共有スプレッドシートは
 * ユーザーが Picker で明示的に選択するまで読めない。この一連（Picker ページを開く →
 * 選択結果を受け取る → プロジェクトとして開き直す）を担う。
 *
 * **なぜ popup ではなく背景 service worker に置くか**: Chrome の popup はフォーカスを失った
 * 時点で閉じ、実行中の JS ごと破棄される。`launchWebAuthFlow` は別ウィンドウを開くため、
 * popup で待っていると必ずその瞬間に消えて結果を受け取れない。popup は開始を依頼するだけにし、
 * 完了後の処理（プロジェクト登録・メインビュー起動）まで背景側で完結させる。
 */

import { buildPickerUrl, parsePickerRedirect } from '@/lib/google/pickerUrl';

/** popup → background のメッセージ種別 */
export const PICKER_GRANT_MESSAGE = 'sr-query-builder/picker-grant';

export interface PickerGrantRequest {
  type: typeof PICKER_GRANT_MESSAGE;
  spreadsheetId: string;
}

export type PickerGrantResult =
  | { status: 'granted' }
  | { status: 'cancelled' }
  /** 既に別の許可フローが進行中（ウィンドウが二重に開くのを防ぐ） */
  | { status: 'busy' }
  | { status: 'failed'; message: string };

export interface PickerGrantDeps {
  /** 選択結果の戻り先（chrome.identity.getRedirectURL('picker')） */
  getRedirectUri: () => string;
  /** Picker ページを開いてリダイレクト URL を受け取る */
  launchWebAuthFlow: (url: string) => Promise<string | undefined>;
  /** アカウント照合と login_hint に使う、ログイン中のメールアドレス */
  getUserEmail: () => Promise<string | null>;
  /** 許可後にプロジェクトとして開き直す（失敗すれば例外） */
  openProject: (spreadsheetId: string) => Promise<void>;
  /** 開き直しに成功したときにメインビューを開く */
  onOpened: () => void;
}

/**
 * `launchWebAuthFlow` の失敗が「ユーザーがウィンドウを閉じた／キャンセルした」ものかを
 * 例外メッセージ（chrome.runtime.lastError 由来）から best-effort で判定する。
 * 該当すれば静かに終了し、それ以外（ネットワークエラー等）はエラーとして表示する。
 */
export function isUserCancelledAuthError(message: string): boolean {
  return /did not approve|cancel|closed the window|dismissed/i.test(message || '');
}

// 許可ウィンドウを二重に開かないための単一飛行ガード。
// popup は結果を待たずに閉じるため、連打や再オープンで複数走りうる。
let inFlight = false;

/**
 * Picker で対象スプレッドシートへのアクセスを許可してもらい、成功したらプロジェクトを開く。
 *
 * 例外は投げず、結果を `PickerGrantResult` として返す（呼び出し元は sendResponse するだけ）。
 */
export async function requestSpreadsheetAccess(
  spreadsheetId: string,
  deps: PickerGrantDeps
): Promise<PickerGrantResult> {
  if (inFlight) return { status: 'busy' };
  inFlight = true;
  try {
    const redirectUri = deps.getRedirectUri();
    // メールが取れなくても Picker 自体は開ける（アカウント照合が省かれるだけ）
    const email = await deps.getUserEmail().catch(() => null);
    const url = buildPickerUrl({ spreadsheetId, email: email ?? undefined, redirectUri });

    let redirectUrl: string | undefined;
    try {
      redirectUrl = await deps.launchWebAuthFlow(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isUserCancelledAuthError(message)) return { status: 'cancelled' };
      return { status: 'failed', message };
    }
    if (!redirectUrl) return { status: 'cancelled' };

    // Picker ページ側の不備や想定外の遷移を疑い、拡張機能自身が発行したリダイレクト URI で
    // 始まっていることを確かめてから解析する（parsePickerRedirect は発行元を検証しない）。
    if (!redirectUrl.startsWith(redirectUri)) {
      return { status: 'failed', message: '許可ページから想定外の応答を受け取りました。' };
    }

    const parsed = parsePickerRedirect(redirectUrl);
    if (parsed === 'cancelled') return { status: 'cancelled' };
    if (parsed === null) {
      return { status: 'failed', message: '許可ページの応答を解釈できませんでした。' };
    }

    try {
      await deps.openProject(spreadsheetId);
    } catch (err) {
      // 選んだシートが入力 ID と別物だと、許可自体は成立しても対象シートは読めないままになる。
      // 「許可したのに開けない」で終わらせず、原因の候補を示す。
      const mismatched = parsed.picked !== spreadsheetId;
      const detail = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        message: mismatched
          ? `選択されたスプレッドシートが、入力された ID と一致していません。もう一度、対象のシートを選んでください。（${detail}）`
          : detail,
      };
    }

    deps.onOpened();
    return { status: 'granted' };
  } finally {
    inFlight = false;
  }
}
