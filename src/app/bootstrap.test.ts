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
    // 既存テストは wiring 層を触らないので runtime を無効化する
    runtime: null,
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
      protocolDraft: null,
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

describe('startApp - wiring 層', () => {
  function jsonResponse(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }

  function makeRuntime(initialStore: Record<string, unknown> = {}): {
    runtime: NonNullable<AppBootstrapOptions['runtime']>;
    data: Record<string, unknown>;
    fetchMock: jest.Mock;
  } {
    const data = { ...initialStore };
    const fetchMock = jest.fn();
    return {
      data,
      fetchMock,
      runtime: {
        google: {
          fetch: fetchMock as unknown as typeof fetch,
          getAccessToken: jest.fn().mockResolvedValue('t'),
        },
        profile: {
          getProfileUserInfo: jest.fn().mockResolvedValue({ email: 'me@x', id: 'u' }),
        },
        store: {
          read: async <T>(key: string) => data[key] as T | undefined,
          write: async (items) => {
            Object.assign(data, items);
          },
        },
      },
    };
  }

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test('hydrate: chrome.storage の currentProject を store に取り込む', async () => {
    const doc = buildDocument();
    const { runtime } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'My SR' },
    });
    const handle = startApp(doc, { ...noopHashOptions('#/home'), runtime });
    await flush();
    expect(handle.store.getState().project?.title).toBe('My SR');
  });

  test('hydrate: 同じ projectId なら setState せず参照を変えない', async () => {
    const doc = buildDocument();
    const { runtime } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'd', title: 'X' },
    });
    const initialProject = {
      projectId: 'p',
      spreadsheetId: 's',
      driveFolderId: 'd',
      title: 'Initial',
    };
    const store = createStore({
      ...createStore().getState(),
      project: initialProject,
    });
    startApp(doc, { ...noopHashOptions('#/home'), store, runtime });
    await flush();
    expect(store.getState().project).toBe(initialProject);
  });

  test('hydrate: storage に何も無ければ project は null のまま', async () => {
    const doc = buildDocument();
    const { runtime } = makeRuntime();
    const handle = startApp(doc, { ...noopHashOptions('#/home'), runtime });
    await flush();
    expect(handle.store.getState().project).toBeNull();
  });

  test('protocol view 既定 onSubmit が submitProtocol を呼び blocksDraft を埋める', async () => {
    const doc = buildDocument();
    const { runtime, data, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 's', driveFolderId: 'D', title: 'T' },
      'apiKeys.gemini': 'KEY',
    });
    const setHash = jest.fn();
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com')) {
        return jsonResponse({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      framework_type: 'pico',
                      research_question: 'RQ',
                      blocks: [{ block_label: 'P', description: 'p' }],
                      combination_expression: '#1',
                    }),
                  },
                ],
              },
            },
          ],
        });
      }
      if (typeof url === 'string' && url.includes('/upload/drive/v3/files')) {
        return jsonResponse({ id: 'f', webViewLink: 'https://drive/x' });
      }
      return jsonResponse({});
    });
    const handle = startApp(doc, {
      getHash: () => '#/protocol',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash,
      runtime,
    });
    await flush(); // hydrate
    handle.store.setState((s) => ({ ...s })); // force re-render so view sees project
    const form = doc.querySelector('form')!;
    const inline = doc.querySelector<HTMLTextAreaElement>('textarea#inline')!;
    inline.value = '本文';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    await flush();
    await flush();
    expect(handle.store.getState().blocksDraft?.blocks[0]?.blockLabel).toBe('P');
    expect(setHash).toHaveBeenCalledWith('#/blocks');
    expect(data['LLM_LOG']).toBeUndefined(); // sanity: no unexpected key
  });

  test('blocks view 既定 onApprove が approveBlocks を呼ぶ', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime({
      currentProject: { projectId: 'p', spreadsheetId: 'SHEET-1', driveFolderId: 'D', title: 'T' },
    });
    const setHash = jest.fn();
    fetchMock.mockResolvedValue(jsonResponse({}));
    const handle = startApp(doc, {
      getHash: () => '#/blocks',
      onHashChange: jest.fn().mockReturnValue(() => undefined),
      setHash,
      runtime,
    });
    await flush();
    handle.store.setState((s) => ({
      ...s,
      protocolDraft: {
        frameworkType: 'pico',
        researchQuestion: 'RQ',
        inclusionCriteria: '',
        exclusionCriteria: '',
        studyDesign: 'RCT',
        sourceType: 'manual',
        sourceFilename: null,
        rawTextRef: null,
        rawTextPreview: 'p',
        rawTextInline: '本文',
      },
      blocksDraft: {
        blocks: [
          { blockLabel: 'P', description: '', aiGenerated: true, note: '' },
          { blockLabel: 'I', description: '', aiGenerated: true, note: '' },
        ],
        combinationExpression: '#1 AND #2',
      },
    }));
    const approveBtn = Array.from(doc.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.startsWith('承認して')
    )!;
    approveBtn.click();
    await flush();
    await flush();
    await flush();
    // approveBlocks は :append を呼ぶ
    const calls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(calls.some((u) => u.includes(':append'))).toBe(true);
    expect(setHash).toHaveBeenCalledWith('#/draft');
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
