import {
  createLocationOptions,
  startApp,
  type AppBootstrapOptions,
} from './bootstrap';
import { createStore } from './store';

function buildDocument(): Document {
  const doc = document.implementation.createHTMLDocument('test');
  doc.body.innerHTML = `
    <span id="app-status"></span>
    <aside id="app-sidebar"><nav></nav></aside>
    <section id="app-content"></section>
  `;
  return doc;
}

function noopHashOptions(initial = ''): AppBootstrapOptions {
  return {
    getHash: () => initial,
    onHashChange: jest.fn().mockReturnValue(() => undefined),
    setHash: jest.fn(),
  };
}

describe('startApp', () => {
  test('初期レンダで status / sidebar / content を更新する', () => {
    const doc = buildDocument();
    startApp(doc, noopHashOptions('#/protocol'));
    expect(doc.getElementById('app-status')?.textContent).toContain('プロトコル入力');
    expect(doc.querySelectorAll('#app-sidebar nav button').length).toBeGreaterThan(0);
    expect(doc.getElementById('app-content')?.querySelector('h2')?.textContent).toBe(
      'プロトコル入力'
    );
  });

  test('プロジェクト未選択時は status に「(未選択)」と出る', () => {
    const doc = buildDocument();
    startApp(doc, noopHashOptions('#/home'));
    expect(doc.getElementById('app-status')?.textContent).toContain('(未選択)');
  });

  test('プロジェクトがあれば status にタイトルが出る', () => {
    const doc = buildDocument();
    const store = createStore({
      route: 'home',
      project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'My SR' },
      cumulativeCostUsd: null,
      blocksDraft: null,
    });
    startApp(doc, { ...noopHashOptions('#/home'), store });
    expect(doc.getElementById('app-status')?.textContent).toContain('My SR');
  });

  test('hashchange 発火で再レンダする', () => {
    const doc = buildDocument();
    let listener: () => void = () => undefined;
    let currentHash = '#/home';
    const opts: AppBootstrapOptions = {
      getHash: () => currentHash,
      onHashChange: (cb) => {
        listener = cb;
        return () => undefined;
      },
      setHash: jest.fn(),
    };
    startApp(doc, opts);
    expect(doc.getElementById('app-status')?.textContent).toContain('ホーム');
    currentHash = '#/seeds';
    listener();
    expect(doc.getElementById('app-status')?.textContent).toContain('シード論文');
  });

  test('サイドバーの「プロトコル入力」ボタンで setHash が呼ばれる', () => {
    const doc = buildDocument();
    const setHash = jest.fn();
    startApp(doc, { ...noopHashOptions('#/home'), setHash });
    const protocolBtn = Array.from(
      doc.querySelectorAll<HTMLButtonElement>('#app-sidebar nav button')
    ).find((b) => b.textContent === 'プロトコル入力');
    expect(protocolBtn).toBeTruthy();
    protocolBtn!.click();
    expect(setHash).toHaveBeenCalledWith('#/protocol');
  });

  test('現在のルートのサイドバーボタンに is-active が付く', () => {
    const doc = buildDocument();
    startApp(doc, noopHashOptions('#/blocks'));
    const active = doc.querySelector('#app-sidebar nav .is-active');
    expect(active?.textContent).toBe('ブロック承認');
  });

  test('store を更新すると再レンダされる', () => {
    const doc = buildDocument();
    const store = createStore();
    const handle = startApp(doc, { ...noopHashOptions('#/home'), store });
    handle.store.setState((s) => ({
      ...s,
      project: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'New' },
    }));
    expect(doc.getElementById('app-status')?.textContent).toContain('New');
  });

  test('dispose でリスナ解除 + サブスクライブ解除', () => {
    const doc = buildDocument();
    const unlistenHash = jest.fn();
    const onHashChange = jest.fn().mockReturnValue(unlistenHash);
    const handle = startApp(doc, {
      getHash: () => '',
      onHashChange,
      setHash: jest.fn(),
    });
    handle.dispose();
    expect(unlistenHash).toHaveBeenCalledTimes(1);
  });

  test('必要な DOM 要素が欠けていても例外にならない', () => {
    const doc = document.implementation.createHTMLDocument('empty');
    expect(() => startApp(doc, noopHashOptions(''))).not.toThrow();
  });
});

describe('createLocationOptions', () => {
  test('getHash / onHashChange / setHash を返す', () => {
    const addSpy = jest.fn();
    const removeSpy = jest.fn();
    const fakeWin = {
      location: { hash: '#/validate' },
      addEventListener: addSpy,
      removeEventListener: removeSpy,
    } as unknown as Window;
    const opts = createLocationOptions(fakeWin);
    expect(opts.getHash()).toBe('#/validate');
    const listener = jest.fn();
    const off = opts.onHashChange(listener);
    expect(addSpy).toHaveBeenCalledWith('hashchange', listener);
    off();
    expect(removeSpy).toHaveBeenCalledWith('hashchange', listener);
    opts.setHash('#/seeds');
    expect((fakeWin.location as Location).hash).toBe('#/seeds');
  });
});
