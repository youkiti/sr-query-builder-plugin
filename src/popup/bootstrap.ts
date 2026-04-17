/**
 * Popup 画面の起動ロジック。popup.ts から呼ばれる。
 * DOM と chrome API を依存注入するのでテスト可能。
 */

export interface PopupDeps {
  /** メインビュー（app.html）を新規タブで開く */
  openAppTab: () => void;
  /** 設定画面（options.html）を開く */
  openOptions: () => void;
}

export function createChromeDeps(): PopupDeps {
  return {
    openAppTab: () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') });
    },
    openOptions: () => {
      chrome.runtime.openOptionsPage();
    },
  };
}

export function startPopup(doc: Document, deps: PopupDeps): void {
  const status = doc.getElementById('popup-status');
  const openAppBtn = doc.getElementById('open-app');
  const openOptionsBtn = doc.getElementById('open-options');

  if (status) {
    status.textContent = 'プロジェクトを選択してメインビューを開いてください。';
  }

  openAppBtn?.addEventListener('click', () => {
    deps.openAppTab();
  });

  openOptionsBtn?.addEventListener('click', () => {
    deps.openOptions();
  });
}
