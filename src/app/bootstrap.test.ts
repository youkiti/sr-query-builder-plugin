import {
  DEFAULT_ROUTE,
  ROUTES,
  createLocationOptions,
  parseRoute,
  startApp,
  type AppBootstrapOptions,
} from './bootstrap';

describe('parseRoute', () => {
  test.each(ROUTES.map((r) => [`#/${r}`, r] as const))('%s → %s', (hash, expected) => {
    expect(parseRoute(hash)).toBe(expected);
  });

  test('空ハッシュは DEFAULT_ROUTE に落ちる', () => {
    expect(parseRoute('')).toBe(DEFAULT_ROUTE);
  });

  test('不明なルートは DEFAULT_ROUTE に落ちる', () => {
    expect(parseRoute('#/unknown')).toBe(DEFAULT_ROUTE);
  });

  test('# のみでも落ちない', () => {
    expect(parseRoute('#')).toBe(DEFAULT_ROUTE);
  });
});

describe('startApp', () => {
  function buildDocument(): Document {
    const doc = document.implementation.createHTMLDocument('test');
    doc.body.innerHTML = `
      <span id="app-status"></span>
      <section id="app-content"></section>
    `;
    return doc;
  }

  test('初期レンダで現在ルートを status / content に書き込む', () => {
    const doc = buildDocument();
    const opts: AppBootstrapOptions = {
      getHash: () => '#/protocol',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
    };
    startApp(doc, opts);
    expect(doc.getElementById('app-status')?.textContent).toContain('#/protocol');
    expect(doc.getElementById('app-content')?.textContent).toContain('[protocol]');
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
    };
    startApp(doc, opts);
    expect(doc.getElementById('app-status')?.textContent).toContain('#/home');

    currentHash = '#/seeds';
    listener();
    expect(doc.getElementById('app-status')?.textContent).toContain('#/seeds');
  });

  test('返り値を呼ぶとリスナ解除される（戻り値のみテスト）', () => {
    const doc = buildDocument();
    const unlisten = jest.fn();
    const opts: AppBootstrapOptions = {
      getHash: () => '',
      onHashChange: jest.fn().mockReturnValue(unlisten),
    };
    const dispose = startApp(doc, opts);
    dispose();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  test('必要な DOM 要素が欠けていても例外にはならない', () => {
    const doc = document.implementation.createHTMLDocument('empty');
    const opts: AppBootstrapOptions = {
      getHash: () => '',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
    };
    expect(() => startApp(doc, opts)).not.toThrow();
  });
});

describe('createLocationOptions', () => {
  test('getHash は window.location.hash を返す', () => {
    const win = {
      location: { hash: '#/validate' },
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    } as unknown as Window;
    const opts = createLocationOptions(win);
    expect(opts.getHash()).toBe('#/validate');
  });

  test('onHashChange は hashchange を監視し、解除関数で removeEventListener する', () => {
    const addSpy = jest.fn();
    const removeSpy = jest.fn();
    const win = {
      location: { hash: '' },
      addEventListener: addSpy,
      removeEventListener: removeSpy,
    } as unknown as Window;
    const opts = createLocationOptions(win);
    const listener = jest.fn();
    const dispose = opts.onHashChange(listener);
    expect(addSpy).toHaveBeenCalledWith('hashchange', listener);
    dispose();
    expect(removeSpy).toHaveBeenCalledWith('hashchange', listener);
  });
});
