import { createChromeDeps, startPopup, type PopupDeps } from './bootstrap';

describe('startPopup', () => {
  function buildDocument(): Document {
    const doc = document.implementation.createHTMLDocument('test');
    doc.body.innerHTML = `
      <p id="popup-status"></p>
      <button id="open-app"></button>
      <button id="open-options"></button>
    `;
    return doc;
  }

  test('ステータス文言を書き込む', () => {
    const doc = buildDocument();
    const deps: PopupDeps = { openAppTab: jest.fn(), openOptions: jest.fn() };
    startPopup(doc, deps);
    expect(doc.getElementById('popup-status')?.textContent).toContain('プロジェクトを選択');
  });

  test('「メインビューを開く」ボタンで openAppTab が呼ばれる', () => {
    const doc = buildDocument();
    const openAppTab = jest.fn();
    startPopup(doc, { openAppTab, openOptions: jest.fn() });
    (doc.getElementById('open-app') as HTMLButtonElement).click();
    expect(openAppTab).toHaveBeenCalledTimes(1);
  });

  test('「設定」ボタンで openOptions が呼ばれる', () => {
    const doc = buildDocument();
    const openOptions = jest.fn();
    startPopup(doc, { openAppTab: jest.fn(), openOptions });
    (doc.getElementById('open-options') as HTMLButtonElement).click();
    expect(openOptions).toHaveBeenCalledTimes(1);
  });

  test('必要な要素が欠けていても例外にはならない', () => {
    const doc = document.implementation.createHTMLDocument('empty');
    expect(() => startPopup(doc, { openAppTab: jest.fn(), openOptions: jest.fn() })).not.toThrow();
  });
});

describe('createChromeDeps', () => {
  test('openAppTab は chrome.tabs.create を app.html で呼ぶ', () => {
    const tabsCreate = jest.fn();
    const getURL = jest.fn((p: string) => `chrome-extension://abc/${p}`);
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      tabs: { create: tabsCreate },
      runtime: { getURL, openOptionsPage: jest.fn() },
    } as unknown as typeof chrome;

    const deps = createChromeDeps();
    deps.openAppTab();

    expect(getURL).toHaveBeenCalledWith('app/app.html');
    expect(tabsCreate).toHaveBeenCalledWith({ url: 'chrome-extension://abc/app/app.html' });
  });

  test('openOptions は chrome.runtime.openOptionsPage を呼ぶ', () => {
    const openOptionsPage = jest.fn();
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      tabs: { create: jest.fn() },
      runtime: { getURL: jest.fn(), openOptionsPage },
    } as unknown as typeof chrome;

    const deps = createChromeDeps();
    deps.openOptions();

    expect(openOptionsPage).toHaveBeenCalledTimes(1);
  });
});
