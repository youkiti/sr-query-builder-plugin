import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { createChromePopupDeps, startPopup, type PopupDeps } from './bootstrap';

function buildDocument(): Document {
  const doc = document.implementation.createHTMLDocument('test');
  doc.body.innerHTML = `
    <p id="popup-status"></p>
    <p id="popup-current-name"></p>
    <button id="open-app"></button>
    <form id="popup-create-form"><input id="popup-create-title" /></form>
    <p id="popup-create-error"></p>
    <form id="popup-open-form"><input id="popup-open-id" /></form>
    <p id="popup-open-error"></p>
    <section id="popup-recent-section" hidden><ul id="popup-recent"></ul></section>
    <button id="open-options"></button>
  `;
  return doc;
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function makeRuntime(initialStore: Record<string, unknown> = {}): {
  runtime: PopupDeps['runtime'];
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

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('startPopup', () => {
  test('現在プロジェクト未選択ならステータスに案内文、open-app は disabled', async () => {
    const doc = buildDocument();
    const { runtime } = makeRuntime();
    const deps: PopupDeps = {
      openAppTab: jest.fn(),
      openOptions: jest.fn(),
      runtime,
    };
    await startPopup(doc, deps);
    expect((doc.getElementById('open-app') as HTMLButtonElement).disabled).toBe(true);
    expect(doc.getElementById('popup-status')?.textContent).toContain('プロジェクトを作成');
  });

  test('現在プロジェクトがあれば名前を表示し open-app が有効', async () => {
    const doc = buildDocument();
    const { runtime } = makeRuntime({
      currentProject: {
        projectId: '12345678-aaaa-bbbb-cccc-dddddddddddd',
        spreadsheetId: 's',
        driveFolderId: 'd',
        title: 'My SR',
      },
    });
    const deps: PopupDeps = {
      openAppTab: jest.fn(),
      openOptions: jest.fn(),
      runtime,
    };
    await startPopup(doc, deps);
    expect(doc.getElementById('popup-current-name')?.textContent).toContain('My SR');
    expect(doc.getElementById('popup-current-name')?.textContent).toContain('12345678');
    expect((doc.getElementById('open-app') as HTMLButtonElement).disabled).toBe(false);
    (doc.getElementById('open-app') as HTMLButtonElement).click();
    expect(deps.openAppTab).toHaveBeenCalledTimes(1);
  });

  test('disabled 状態の open-app クリックは openAppTab を呼ばない', async () => {
    const doc = buildDocument();
    const { runtime } = makeRuntime();
    const deps: PopupDeps = {
      openAppTab: jest.fn(),
      openOptions: jest.fn(),
      runtime,
    };
    await startPopup(doc, deps);
    (doc.getElementById('open-app') as HTMLButtonElement).click();
    expect(deps.openAppTab).not.toHaveBeenCalled();
  });

  test('open-options をクリックすると openOptions が呼ばれる', async () => {
    const doc = buildDocument();
    const { runtime } = makeRuntime();
    const deps: PopupDeps = {
      openAppTab: jest.fn(),
      openOptions: jest.fn(),
      runtime,
    };
    await startPopup(doc, deps);
    (doc.getElementById('open-options') as HTMLButtonElement).click();
    expect(deps.openOptions).toHaveBeenCalledTimes(1);
  });

  test('新規プロジェクトフォーム送信で createNewProject が呼ばれ、storage が更新される', async () => {
    const doc = buildDocument();
    const { runtime, data, fetchMock } = makeRuntime();
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.startsWith('https://www.googleapis.com/drive/v3/files') && init.method === 'POST') {
        const body = JSON.parse(init.body as string) as { name: string };
        return jsonResponse({ id: `F-${body.name}`, webViewLink: '' });
      }
      if (url === 'https://sheets.googleapis.com/v4/spreadsheets') {
        return jsonResponse({ spreadsheetId: 'SHEET-1', spreadsheetUrl: '' });
      }
      return jsonResponse({});
    });
    const deps: PopupDeps = {
      openAppTab: jest.fn(),
      openOptions: jest.fn(),
      runtime,
    };
    await startPopup(doc, deps);
    const titleInput = doc.getElementById('popup-create-title') as HTMLInputElement;
    titleInput.value = 'New Project';
    const form = doc.getElementById('popup-create-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flushAsync();
    await flushAsync();
    expect((data['currentProject'] as { title?: string } | undefined)?.title).toBe('New Project');
    expect(titleInput.value).toBe('');
  });

  test('新規作成のエラーは popup-create-error に表示される', async () => {
    const doc = buildDocument();
    const { runtime } = makeRuntime();
    const deps: PopupDeps = { openAppTab: jest.fn(), openOptions: jest.fn(), runtime };
    await startPopup(doc, deps);
    const form = doc.getElementById('popup-create-form') as HTMLFormElement;
    // 空タイトルで送信 → projectService が「必須」エラー
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flushAsync();
    expect(doc.getElementById('popup-create-error')?.textContent).toContain('必須');
  });

  test('Error 以外の例外も String 化されて表示される', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime();
    fetchMock.mockRejectedValue('rare-non-error');
    const deps: PopupDeps = { openAppTab: jest.fn(), openOptions: jest.fn(), runtime };
    await startPopup(doc, deps);
    const idInput = doc.getElementById('popup-open-id') as HTMLInputElement;
    idInput.value = 'sid';
    const form = doc.getElementById('popup-open-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flushAsync();
    await flushAsync();
    expect(doc.getElementById('popup-open-error')?.textContent).toContain('rare-non-error');
  });

  test('既存を開くフォームで loadExistingProject が呼ばれる', async () => {
    const doc = buildDocument();
    const { runtime, data, fetchMock } = makeRuntime();
    fetchMock.mockResolvedValue(
      jsonResponse({
        values: [
          [...SHEET_HEADERS.Meta],
          ['pid', 'タイトル', 'sid', 'did', '1.0', '2026-04-19T00:00:00.000Z', 'me@x'],
        ],
      })
    );
    const deps: PopupDeps = { openAppTab: jest.fn(), openOptions: jest.fn(), runtime };
    await startPopup(doc, deps);
    const idInput = doc.getElementById('popup-open-id') as HTMLInputElement;
    idInput.value = 'sid';
    const form = doc.getElementById('popup-open-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flushAsync();
    await flushAsync();
    expect((data['currentProject'] as { spreadsheetId?: string } | undefined)?.spreadsheetId).toBe('sid');
    expect(idInput.value).toBe('');
  });

  test('既存読み込みのエラーは popup-open-error に表示される', async () => {
    const doc = buildDocument();
    const { runtime, fetchMock } = makeRuntime();
    fetchMock.mockResolvedValue(jsonResponse({ values: [] }));
    const deps: PopupDeps = { openAppTab: jest.fn(), openOptions: jest.fn(), runtime };
    await startPopup(doc, deps);
    const idInput = doc.getElementById('popup-open-id') as HTMLInputElement;
    idInput.value = 'sid';
    const form = doc.getElementById('popup-open-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flushAsync();
    await flushAsync();
    expect(doc.getElementById('popup-open-error')?.textContent).toContain('Meta');
  });

  test('recent project があるとリストを表示し、クリックで currentProject が切り替わる', async () => {
    const doc = buildDocument();
    const { runtime, data } = makeRuntime({
      recentProjects: [
        { projectId: 'p-aaa', spreadsheetId: 's-aaa', driveFolderId: 'd', title: 'A' },
        { projectId: 'p-bbb', spreadsheetId: 's-bbb', driveFolderId: 'd', title: 'B' },
      ],
    });
    const deps: PopupDeps = { openAppTab: jest.fn(), openOptions: jest.fn(), runtime };
    await startPopup(doc, deps);
    const section = doc.getElementById('popup-recent-section') as HTMLElement;
    expect(section.hidden).toBe(false);
    const buttons = doc.querySelectorAll<HTMLButtonElement>('#popup-recent button');
    expect(buttons.length).toBe(2);
    buttons[1]!.click();
    await flushAsync();
    await flushAsync();
    expect((data['currentProject'] as { projectId?: string } | undefined)?.projectId).toBe('p-bbb');
  });

  test('recent project が無いと section は hidden のまま', async () => {
    const doc = buildDocument();
    const { runtime } = makeRuntime();
    const deps: PopupDeps = { openAppTab: jest.fn(), openOptions: jest.fn(), runtime };
    await startPopup(doc, deps);
    const section = doc.getElementById('popup-recent-section') as HTMLElement;
    expect(section.hidden).toBe(true);
  });

  test('DOM 要素が一部欠けていても例外にならない（フォームのみ欠落）', async () => {
    const doc = document.implementation.createHTMLDocument('empty');
    doc.body.innerHTML = '<p id="popup-status"></p>';
    const { runtime } = makeRuntime();
    const deps: PopupDeps = { openAppTab: jest.fn(), openOptions: jest.fn(), runtime };
    await expect(startPopup(doc, deps)).resolves.toBeUndefined();
  });

  test('フォームはあるがエラー表示用の要素が無くても例外にならない', async () => {
    const doc = document.implementation.createHTMLDocument('partial');
    doc.body.innerHTML = `
      <p id="popup-status"></p>
      <p id="popup-current-name"></p>
      <button id="open-app"></button>
      <form id="popup-create-form"><input id="popup-create-title" /></form>
      <form id="popup-open-form"><input id="popup-open-id" /></form>
    `;
    const { runtime } = makeRuntime();
    const deps: PopupDeps = { openAppTab: jest.fn(), openOptions: jest.fn(), runtime };
    await startPopup(doc, deps);
    const createForm = doc.getElementById('popup-create-form') as HTMLFormElement;
    expect(() =>
      createForm.dispatchEvent(new Event('submit', { cancelable: true }))
    ).not.toThrow();
    await flushAsync();
  });
});

describe('createChromePopupDeps', () => {
  test('chrome API ラッパとして openAppTab / openOptions / runtime を返す', () => {
    const tabsCreate = jest.fn();
    const getURL = jest.fn((p: string) => `chrome-extension://x/${p}`);
    const openOptionsPage = jest.fn();
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      tabs: { create: tabsCreate },
      runtime: { getURL, openOptionsPage },
      identity: {
        getAuthToken: (_o: unknown, cb: (t: string) => void) => cb('TOK'),
        removeCachedAuthToken: (_o: unknown, cb: () => void) => cb(),
        getProfileUserInfo: (_o: unknown, cb: (i: { email: string; id: string }) => void) =>
          cb({ email: 'me@x', id: 'u' }),
      },
      storage: {
        local: { get: jest.fn().mockResolvedValue({}), set: jest.fn().mockResolvedValue(undefined) },
      },
    } as unknown as typeof chrome;
    const deps = createChromePopupDeps();
    deps.openAppTab();
    expect(getURL).toHaveBeenCalledWith('app/app.html');
    expect(tabsCreate).toHaveBeenCalled();
    deps.openOptions();
    expect(openOptionsPage).toHaveBeenCalled();
    expect(typeof deps.runtime.google.getAccessToken).toBe('function');
  });
});
