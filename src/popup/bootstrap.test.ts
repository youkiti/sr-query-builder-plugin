import { SHEET_HEADERS } from '@/domain/sheetsSchema';
import { STORAGE_KEY_GEMINI } from '@/app/services';
import {
  STORAGE_KEY_PENDING_APP_TAB,
  createChromePopupDeps,
  startPopup,
  type PopupDeps,
} from './bootstrap';

function buildDocument(): Document {
  const doc = document.implementation.createHTMLDocument('test');
  doc.body.innerHTML = `
    <p id="popup-status"></p>
    <section id="popup-auth" hidden>
      <button id="login-button"></button>
      <p id="login-error"></p>
    </section>
    <div id="popup-projects" hidden>
      <section id="popup-account">
        <span id="popup-email">—</span>
        <button id="logout-button"></button>
      </section>
      <section id="popup-recent-section" hidden><ul id="popup-recent"></ul></section>
      <form id="popup-create-form"><input id="popup-create-title" /></form>
      <p id="popup-create-error"></p>
      <form id="popup-open-form"><input id="popup-open-id" /></form>
      <p id="popup-open-error"></p>
    </div>
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

interface TestPopupDeps extends PopupDeps {
  isAuthenticated: jest.Mock<Promise<boolean>, []>;
  signIn: jest.Mock<Promise<boolean>, []>;
  signOut: jest.Mock<Promise<void>, []>;
  openAppTab: jest.Mock<void, []>;
  openOptions: jest.Mock<void, []>;
}

function makeDeps(
  initialStore: Record<string, unknown> = {},
  opts: { authed?: boolean } = {}
): { deps: TestPopupDeps; data: Record<string, unknown>; fetchMock: jest.Mock } {
  // 既存テストは API キー未設定による Options 誘導を意識していないため、
  // 既定では Gemini キー設定済み扱いにして openAppTab が呼ばれる流れをそのまま検証する。
  const data: Record<string, unknown> = { [STORAGE_KEY_GEMINI]: 'g-key', ...initialStore };
  const fetchMock = jest.fn();
  const deps: TestPopupDeps = {
    openAppTab: jest.fn(),
    openOptions: jest.fn(),
    isAuthenticated: jest.fn().mockResolvedValue(opts.authed ?? true),
    signIn: jest.fn().mockResolvedValue(true),
    signOut: jest.fn().mockResolvedValue(undefined),
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
  return { deps, data, fetchMock };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('startPopup / 未ログイン', () => {
  test('未ログイン時はログイン画面を表示し、プロジェクト選択は隠す', async () => {
    const doc = buildDocument();
    const { deps } = makeDeps({}, { authed: false });
    await startPopup(doc, deps);
    expect((doc.getElementById('popup-auth') as HTMLElement).hidden).toBe(false);
    expect((doc.getElementById('popup-projects') as HTMLElement).hidden).toBe(true);
    expect(doc.getElementById('popup-status')?.textContent).toContain('ログイン');
  });

  test('ログインボタンを押すと signIn が呼ばれ、成功時はプロジェクト画面に切り替わる', async () => {
    const doc = buildDocument();
    const { deps } = makeDeps({}, { authed: false });
    await startPopup(doc, deps);
    // signIn 成功後の 2 回目 isAuthenticated は true
    deps.isAuthenticated.mockResolvedValue(true);
    (doc.getElementById('login-button') as HTMLButtonElement).click();
    await flushAsync();
    await flushAsync();
    expect(deps.signIn).toHaveBeenCalledTimes(1);
    expect((doc.getElementById('popup-auth') as HTMLElement).hidden).toBe(true);
    expect((doc.getElementById('popup-projects') as HTMLElement).hidden).toBe(false);
  });

  test('signIn が失敗すればエラー文を表示してボタンは再び押せる', async () => {
    const doc = buildDocument();
    const { deps } = makeDeps({}, { authed: false });
    deps.signIn.mockResolvedValue(false);
    await startPopup(doc, deps);
    const btn = doc.getElementById('login-button') as HTMLButtonElement;
    btn.click();
    await flushAsync();
    await flushAsync();
    expect(doc.getElementById('login-error')?.textContent).toContain('失敗');
    expect(btn.disabled).toBe(false);
  });
});

describe('startPopup / ログイン済', () => {
  test('履歴が無ければ recent セクションは hidden のまま、案内文は新規作成を促す', async () => {
    const doc = buildDocument();
    const { deps } = makeDeps();
    await startPopup(doc, deps);
    expect((doc.getElementById('popup-recent-section') as HTMLElement).hidden).toBe(true);
    expect(doc.getElementById('popup-status')?.textContent).toContain('作成');
  });

  test('履歴があればリストを表示し、クリックで currentProject 更新 + メインビュータブを開く', async () => {
    const doc = buildDocument();
    const { deps, data } = makeDeps({
      recentProjects: [
        { projectId: 'p-aaa', spreadsheetId: 's-aaa', driveFolderId: 'd', title: 'A' },
        { projectId: 'p-bbb', spreadsheetId: 's-bbb', driveFolderId: 'd', title: 'B' },
      ],
    });
    await startPopup(doc, deps);
    const section = doc.getElementById('popup-recent-section') as HTMLElement;
    expect(section.hidden).toBe(false);
    const buttons = doc.querySelectorAll<HTMLButtonElement>('#popup-recent button');
    expect(buttons.length).toBe(2);
    buttons[1]!.click();
    await flushAsync();
    await flushAsync();
    expect((data['currentProject'] as { projectId?: string } | undefined)?.projectId).toBe(
      'p-bbb'
    );
    expect(deps.openAppTab).toHaveBeenCalledTimes(1);
  });

  test('新規作成成功後は自動でメインビューを開く', async () => {
    const doc = buildDocument();
    const { deps, fetchMock, data } = makeDeps();
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
    await startPopup(doc, deps);
    const titleInput = doc.getElementById('popup-create-title') as HTMLInputElement;
    titleInput.value = 'New Project';
    (doc.getElementById('popup-create-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true })
    );
    await flushAsync();
    await flushAsync();
    expect((data['currentProject'] as { title?: string } | undefined)?.title).toBe('New Project');
    expect(deps.openAppTab).toHaveBeenCalledTimes(1);
    expect(titleInput.value).toBe('');
  });

  test('新規作成のエラーは popup-create-error に表示され、メインビューは開かない', async () => {
    const doc = buildDocument();
    const { deps } = makeDeps();
    await startPopup(doc, deps);
    (doc.getElementById('popup-create-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true })
    );
    await flushAsync();
    expect(doc.getElementById('popup-create-error')?.textContent).toContain('必須');
    expect(deps.openAppTab).not.toHaveBeenCalled();
  });

  test('Error 以外の例外も String 化されて表示される', async () => {
    const doc = buildDocument();
    const { deps, fetchMock } = makeDeps();
    fetchMock.mockRejectedValue('rare-non-error');
    await startPopup(doc, deps);
    const idInput = doc.getElementById('popup-open-id') as HTMLInputElement;
    idInput.value = 'sid';
    (doc.getElementById('popup-open-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true })
    );
    await flushAsync();
    await flushAsync();
    expect(doc.getElementById('popup-open-error')?.textContent).toContain('rare-non-error');
    expect(deps.openAppTab).not.toHaveBeenCalled();
  });

  test('既存を開くフォームで loadExistingProject が呼ばれ、自動でメインビューを開く', async () => {
    const doc = buildDocument();
    const { deps, data, fetchMock } = makeDeps();
    fetchMock.mockResolvedValue(
      jsonResponse({
        values: [
          [...SHEET_HEADERS.Meta],
          ['pid', 'タイトル', 'sid', 'did', '1.0', '2026-04-19T00:00:00.000Z', 'me@x'],
        ],
      })
    );
    await startPopup(doc, deps);
    const idInput = doc.getElementById('popup-open-id') as HTMLInputElement;
    idInput.value = 'sid';
    (doc.getElementById('popup-open-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true })
    );
    await flushAsync();
    await flushAsync();
    expect((data['currentProject'] as { spreadsheetId?: string } | undefined)?.spreadsheetId).toBe(
      'sid'
    );
    expect(deps.openAppTab).toHaveBeenCalledTimes(1);
    expect(idInput.value).toBe('');
  });

  test('既存読み込みのエラーは popup-open-error に表示される', async () => {
    const doc = buildDocument();
    const { deps, fetchMock } = makeDeps();
    fetchMock.mockResolvedValue(jsonResponse({ values: [] }));
    await startPopup(doc, deps);
    const idInput = doc.getElementById('popup-open-id') as HTMLInputElement;
    idInput.value = 'sid';
    (doc.getElementById('popup-open-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true })
    );
    await flushAsync();
    await flushAsync();
    expect(doc.getElementById('popup-open-error')?.textContent).toContain('Meta');
    expect(deps.openAppTab).not.toHaveBeenCalled();
  });

  test('open-options をクリックすると openOptions が呼ばれる', async () => {
    const doc = buildDocument();
    const { deps } = makeDeps();
    await startPopup(doc, deps);
    (doc.getElementById('open-options') as HTMLButtonElement).click();
    expect(deps.openOptions).toHaveBeenCalledTimes(1);
  });

  test('ログイン中のメールを popup-email に表示する', async () => {
    const doc = buildDocument();
    const { deps } = makeDeps();
    await startPopup(doc, deps);
    expect(doc.getElementById('popup-email')?.textContent).toBe('me@x');
  });

  test('プロフィール取得に失敗しても email 欄は (不明) に置き換わるだけ', async () => {
    const doc = buildDocument();
    const { deps } = makeDeps();
    (deps.runtime.profile.getProfileUserInfo as jest.Mock).mockRejectedValue(
      new Error('boom')
    );
    await startPopup(doc, deps);
    expect(doc.getElementById('popup-email')?.textContent).toBe('(不明)');
  });

  test('ログアウトボタンで signOut → 未ログイン画面に切り替わる', async () => {
    const doc = buildDocument();
    const { deps } = makeDeps();
    await startPopup(doc, deps);
    // signOut 後の 2 回目 isAuthenticated は false
    deps.isAuthenticated.mockResolvedValue(false);
    (doc.getElementById('logout-button') as HTMLButtonElement).click();
    await flushAsync();
    await flushAsync();
    expect(deps.signOut).toHaveBeenCalledTimes(1);
    expect((doc.getElementById('popup-auth') as HTMLElement).hidden).toBe(false);
    expect((doc.getElementById('popup-projects') as HTMLElement).hidden).toBe(true);
  });

  test('signOut が throw してもボタンは再び押せる', async () => {
    const doc = buildDocument();
    const { deps } = makeDeps();
    deps.signOut.mockRejectedValue(new Error('boom'));
    await startPopup(doc, deps);
    const btn = doc.getElementById('logout-button') as HTMLButtonElement;
    btn.click();
    await flushAsync();
    await flushAsync();
    expect(btn.disabled).toBe(false);
  });

  test('Gemini キー未設定で recent を開くと Options へ誘導し、pending フラグを立てる', async () => {
    const doc = buildDocument();
    const { deps, data } = makeDeps({
      [STORAGE_KEY_GEMINI]: '',
      recentProjects: [
        { projectId: 'p-aaa', spreadsheetId: 's-aaa', driveFolderId: 'd', title: 'A' },
      ],
    });
    await startPopup(doc, deps);
    const btn = doc.querySelector<HTMLButtonElement>('#popup-recent button');
    btn!.click();
    await flushAsync();
    await flushAsync();
    expect(deps.openAppTab).not.toHaveBeenCalled();
    expect(deps.openOptions).toHaveBeenCalledTimes(1);
    expect(data[STORAGE_KEY_PENDING_APP_TAB]).toBe('1');
    expect(doc.getElementById('popup-status')?.textContent).toContain('APIキー');
  });

  test('Gemini キー未設定で新規作成すると Options に誘導し、pending フラグを立てる', async () => {
    const doc = buildDocument();
    const { deps, fetchMock, data } = makeDeps({ [STORAGE_KEY_GEMINI]: '' });
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
    await startPopup(doc, deps);
    (doc.getElementById('popup-create-title') as HTMLInputElement).value = 'T';
    (doc.getElementById('popup-create-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true })
    );
    await flushAsync();
    await flushAsync();
    expect(deps.openAppTab).not.toHaveBeenCalled();
    expect(deps.openOptions).toHaveBeenCalledTimes(1);
    expect(data[STORAGE_KEY_PENDING_APP_TAB]).toBe('1');
  });

  test('Gemini キー未設定で既存スプレッドシートを開くと Options に誘導する', async () => {
    const doc = buildDocument();
    const { deps, data, fetchMock } = makeDeps({ [STORAGE_KEY_GEMINI]: '' });
    fetchMock.mockResolvedValue(
      jsonResponse({
        values: [
          [...SHEET_HEADERS.Meta],
          ['pid', 'タイトル', 'sid', 'did', '1.0', '2026-04-19T00:00:00.000Z', 'me@x'],
        ],
      })
    );
    await startPopup(doc, deps);
    (doc.getElementById('popup-open-id') as HTMLInputElement).value = 'sid';
    (doc.getElementById('popup-open-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true })
    );
    await flushAsync();
    await flushAsync();
    expect(deps.openAppTab).not.toHaveBeenCalled();
    expect(deps.openOptions).toHaveBeenCalledTimes(1);
    expect(data[STORAGE_KEY_PENDING_APP_TAB]).toBe('1');
  });

  test('DOM 要素が一部欠けていても例外にならない', async () => {
    const doc = document.implementation.createHTMLDocument('empty');
    doc.body.innerHTML = '<p id="popup-status"></p>';
    const { deps } = makeDeps();
    await expect(startPopup(doc, deps)).resolves.toBeUndefined();
  });

  test('フォームはあるがエラー表示要素が無くても例外にならない', async () => {
    const doc = document.implementation.createHTMLDocument('partial');
    doc.body.innerHTML = `
      <p id="popup-status"></p>
      <section id="popup-auth" hidden></section>
      <div id="popup-projects">
        <form id="popup-create-form"><input id="popup-create-title" /></form>
        <form id="popup-open-form"><input id="popup-open-id" /></form>
      </div>
    `;
    const { deps } = makeDeps();
    await startPopup(doc, deps);
    const createForm = doc.getElementById('popup-create-form') as HTMLFormElement;
    expect(() =>
      createForm.dispatchEvent(new Event('submit', { cancelable: true }))
    ).not.toThrow();
    await flushAsync();
  });
});

describe('createChromePopupDeps', () => {
  test('chrome API ラッパとして各機能を返す', async () => {
    const tabsCreate = jest.fn();
    const getURL = jest.fn((p: string) => `chrome-extension://x/${p}`);
    const openOptionsPage = jest.fn();
    const getAuthToken = jest.fn(
      (_o: { interactive: boolean }, cb: (t: string | undefined) => void) => cb('TOK')
    );
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      tabs: { create: tabsCreate },
      runtime: { getURL, openOptionsPage, lastError: undefined },
      identity: {
        getAuthToken,
        removeCachedAuthToken: (_o: unknown, cb: () => void) => cb(),
        getProfileUserInfo: (_o: unknown, cb: (i: { email: string; id: string }) => void) =>
          cb({ email: 'me@x', id: 'u' }),
      },
      storage: {
        local: {
          get: jest.fn().mockResolvedValue({}),
          set: jest.fn().mockResolvedValue(undefined),
          remove: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as typeof chrome;
    const deps = createChromePopupDeps();
    deps.openAppTab();
    expect(getURL).toHaveBeenCalledWith('app/app.html');
    expect(tabsCreate).toHaveBeenCalled();
    deps.openOptions();
    expect(openOptionsPage).toHaveBeenCalled();
    expect(await deps.isAuthenticated()).toBe(true);
    expect(getAuthToken).toHaveBeenLastCalledWith({ interactive: false }, expect.any(Function));
    expect(await deps.signIn()).toBe(true);
    expect(getAuthToken).toHaveBeenLastCalledWith({ interactive: true }, expect.any(Function));
  });

  test('signOut はキャッシュトークンを除去し、storage.local から currentProject / recentProjects を削除する', async () => {
    const removeCached = jest.fn((_o: unknown, cb: () => void) => cb());
    const storageRemove = jest.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      tabs: { create: jest.fn() },
      runtime: { getURL: (p: string) => p, openOptionsPage: jest.fn(), lastError: undefined },
      identity: {
        getAuthToken: (_o: unknown, cb: (t: string) => void) => cb('TOK'),
        removeCachedAuthToken: removeCached,
        getProfileUserInfo: (_o: unknown, cb: (i: { email: string; id: string }) => void) =>
          cb({ email: '', id: '' }),
      },
      storage: {
        local: {
          get: jest.fn().mockResolvedValue({}),
          set: jest.fn().mockResolvedValue(undefined),
          remove: storageRemove,
        },
      },
    } as unknown as typeof chrome;
    const deps = createChromePopupDeps();
    await deps.signOut();
    expect(removeCached).toHaveBeenCalledWith({ token: 'TOK' }, expect.any(Function));
    expect(storageRemove).toHaveBeenCalledWith(['currentProject', 'recentProjects']);
  });

  test('signOut は既にトークンが無くても storage クリアだけは実行する', async () => {
    const storageRemove = jest.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      tabs: { create: jest.fn() },
      runtime: { getURL: (p: string) => p, openOptionsPage: jest.fn(), lastError: undefined },
      identity: {
        getAuthToken: (_o: unknown, cb: (t: string | undefined) => void) => cb(undefined),
        removeCachedAuthToken: (_o: unknown, cb: () => void) => cb(),
        getProfileUserInfo: (_o: unknown, cb: (i: { email: string; id: string }) => void) =>
          cb({ email: '', id: '' }),
      },
      storage: {
        local: {
          get: jest.fn().mockResolvedValue({}),
          set: jest.fn().mockResolvedValue(undefined),
          remove: storageRemove,
        },
      },
    } as unknown as typeof chrome;
    const deps = createChromePopupDeps();
    await deps.signOut();
    expect(storageRemove).toHaveBeenCalledWith(['currentProject', 'recentProjects']);
  });

  test('getAuthToken がエラーを返せば isAuthenticated / signIn は false', async () => {
    const getAuthToken = jest.fn(
      (_o: { interactive: boolean }, cb: (t: string | undefined) => void) => cb(undefined)
    );
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      tabs: { create: jest.fn() },
      runtime: { getURL: (p: string) => p, openOptionsPage: jest.fn(), lastError: undefined },
      identity: {
        getAuthToken,
        removeCachedAuthToken: (_o: unknown, cb: () => void) => cb(),
        getProfileUserInfo: (_o: unknown, cb: (i: { email: string; id: string }) => void) =>
          cb({ email: '', id: '' }),
      },
      storage: {
        local: {
          get: jest.fn().mockResolvedValue({}),
          set: jest.fn().mockResolvedValue(undefined),
          remove: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as typeof chrome;
    const deps = createChromePopupDeps();
    await expect(deps.isAuthenticated()).resolves.toBe(false);
    await expect(deps.signIn()).resolves.toBe(false);
  });
});
