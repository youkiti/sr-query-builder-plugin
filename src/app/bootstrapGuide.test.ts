import { startApp, type AppBootstrapOptions } from './bootstrap';
import { initGuide } from './guide';

jest.mock('./guide', () => ({ initGuide: jest.fn() }));

function buildDocument(withTourButton = true): Document {
  const doc = document.implementation.createHTMLDocument('test');
  doc.body.innerHTML = `
    ${withTourButton ? '<button type="button" id="app-open-tours" data-tour="tour-list">ツアー</button>' : ''}
    <span id="app-status"></span>
    <span id="app-context"></span>
    <aside id="app-sidebar"><nav data-tour="nav"></nav></aside>
    <section id="app-content"></section>
  `;
  return doc;
}

function options(overrides: Partial<AppBootstrapOptions> = {}): AppBootstrapOptions {
  return {
    getHash: () => '#/home',
    onHashChange: jest.fn().mockReturnValue(() => undefined),
    setHash: jest.fn(),
    runtime: {
      google: { fetch: jest.fn() as unknown as typeof fetch, getAccessToken: jest.fn().mockResolvedValue('t') },
      profile: { getProfileUserInfo: jest.fn().mockResolvedValue({ email: 'me@x', id: 'u' }) },
      store: { read: async () => undefined, write: async () => undefined, remove: async () => undefined },
    } as unknown as NonNullable<AppBootstrapOptions['runtime']>,
    ...overrides,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  jest.mocked(initGuide).mockReset().mockResolvedValue(() => undefined);
});

describe('startApp - ヘルプツアーの起動', () => {
  test('サイドバーの各ボタンに data-tour="nav-<route>" が付く', () => {
    const doc = buildDocument();
    startApp(doc, options());
    const targets = Array.from(doc.querySelectorAll<HTMLElement>('#app-sidebar nav button')).map((button) => button.dataset.tour);
    expect(targets).toContain('nav-protocol');
    expect(targets).toContain('nav-settings');
    expect(targets).not.toContain('nav-home');
    expect(targets.every((target) => target?.startsWith('nav-'))).toBe(true);
  });

  test('入口のボタンがある文書で startApp すると initGuide が呼ばれる', () => {
    const doc = buildDocument();
    const opts = options();
    const handle = startApp(doc, opts);
    expect(initGuide).toHaveBeenCalledTimes(1);
    const args = jest.mocked(initGuide).mock.calls[0]![0];
    expect(args.store).toBe(handle.store);
    expect(args.doc).toBe(doc);
    expect(args.getHash).toBe(opts.getHash);
    expect(args.onHashChange).toBe(opts.onHashChange);
  });

  test('initGuide に渡す navigate は前提条件のガードを通る', () => {
    const doc = buildDocument();
    const opts = options();
    startApp(doc, opts);
    const { navigate } = jest.mocked(initGuide).mock.calls[0]![0];
    navigate('protocol');
    expect(opts.setHash).toHaveBeenCalledWith('#/protocol');
    navigate('blocks');
    expect(opts.setHash).not.toHaveBeenCalledWith('#/blocks');
    expect(doc.getElementById('app-status')?.textContent).toContain('プロジェクトを選択してください');
  });

  test('runtime が null（テスト用に配線を切る指定）のときはガイドも起動しない', () => {
    startApp(buildDocument(), options({ runtime: null }));
    expect(initGuide).not.toHaveBeenCalled();
  });

  test('initGuide が失敗しても警告だけで、アプリの起動は続く', async () => {
    const error = new Error('ツアーの読込失敗');
    jest.mocked(initGuide).mockRejectedValue(error);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const doc = buildDocument();
    const handle = startApp(doc, options());
    await flush();
    expect(warn).toHaveBeenCalledWith('[guide] 起動に失敗:', error);
    expect(doc.querySelectorAll('#app-sidebar nav button').length).toBeGreaterThan(0);
    expect(() => handle.dispose()).not.toThrow();
    warn.mockRestore();
  });

  test('dispose でガイドの後始末が呼ばれる', async () => {
    const dispose = jest.fn();
    jest.mocked(initGuide).mockResolvedValue(dispose);
    const handle = startApp(buildDocument(), options());
    await flush();
    handle.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    handle.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test('initGuide の完了前に dispose された場合は、完了した時点で後始末する', async () => {
    const dispose = jest.fn();
    let finish!: (dispose: () => void) => void;
    jest.mocked(initGuide).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const handle = startApp(buildDocument(), options());
    handle.dispose();
    expect(dispose).not.toHaveBeenCalled();
    finish(dispose);
    await flush();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
