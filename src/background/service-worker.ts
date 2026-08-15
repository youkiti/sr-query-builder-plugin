/**
 * MV3 Service Worker（起動フックと、popup から依頼される Picker 許可フロー）。
 * 実処理は別モジュールで実装し、ここは配線に徹する。
 */

import { createChromeRuntimeDeps, loadExistingProject } from '@/app/services';
import { getCurrentUserEmail } from '@/lib/google';
import {
  PICKER_GRANT_MESSAGE,
  requestSpreadsheetAccess,
  type PickerGrantDeps,
  type PickerGrantRequest,
} from './pickerGrant';

chrome.runtime.onInstalled.addListener((details) => {
  console.warn(`[sr-query-builder] installed: ${details.reason}`);
});

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
});

function createChromePickerGrantDeps(): PickerGrantDeps {
  const runtime = createChromeRuntimeDeps();
  return {
    getRedirectUri: () => chrome.identity.getRedirectURL('picker'),
    launchWebAuthFlow: (url) => chrome.identity.launchWebAuthFlow({ url, interactive: true }),
    getUserEmail: () => getCurrentUserEmail(runtime.profile),
    openProject: async (spreadsheetId) => {
      await loadExistingProject(spreadsheetId, runtime);
    },
    onOpened: () => {
      void chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') });
    },
  };
}

function isPickerGrantRequest(message: unknown): message is PickerGrantRequest {
  if (typeof message !== 'object' || message === null) return false;
  const candidate = message as { type?: unknown; spreadsheetId?: unknown };
  return (
    candidate.type === PICKER_GRANT_MESSAGE &&
    typeof candidate.spreadsheetId === 'string' &&
    candidate.spreadsheetId.length > 0
  );
}

/**
 * popup からの Picker 許可依頼を受ける。
 *
 * popup は許可ウィンドウが開いた時点で閉じる（フォーカスを失うため）ので、応答を受け取れる
 * とは限らない。プロジェクトの登録とメインビューの起動まで背景側で完結させ、sendResponse は
 * 「popup がまだ生きていれば表示を更新するための情報」として扱う。
 *
 * externally_connectable は設定していないため、ここに届くのは自拡張内からのメッセージだけ。
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isPickerGrantRequest(message)) return false;
  void requestSpreadsheetAccess(message.spreadsheetId, createChromePickerGrantDeps()).then(
    (result) => {
      // popup が既に閉じていると sendResponse は receiving end 不在で失敗するが、
      // 背景側の処理は完了しているので握りつぶしてよい
      try {
        sendResponse(result);
      } catch {
        // no-op
      }
    }
  );
  // 非同期に応答するため true を返してメッセージチャネルを開いたままにする
  return true;
});
