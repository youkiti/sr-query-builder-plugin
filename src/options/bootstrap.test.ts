import {
  STORAGE_KEY_GEMINI,
  STORAGE_KEY_NCBI,
  STORAGE_KEY_PENDING_APP_TAB,
  createChromeOptionsDeps,
  startOptions,
  type OptionsDeps,
} from './bootstrap';

describe('startOptions', () => {
  function buildDocument(): Document {
    const doc = document.implementation.createHTMLDocument('test');
    doc.body.innerHTML = `
      <p id="options-status"></p>
      <input id="gemini-api-key" />
      <input id="ncbi-api-key" />
      <button id="save-keys"></button>
    `;
    return doc;
  }

  function readStoredValues(calls: Record<string, string>): OptionsDeps {
    return {
      readKey: jest.fn(async (key) => calls[key]),
      writeKey: jest.fn(async () => undefined),
      removeKey: jest.fn(async () => undefined),
      openAppTab: jest.fn(),
    };
  }

  test('両方のキーが既存なら input を復元し、status に「保存済み」を両方並べる', async () => {
    const doc = buildDocument();
    const deps = readStoredValues({
      [STORAGE_KEY_GEMINI]: 'gemini-existing',
      [STORAGE_KEY_NCBI]: 'ncbi-existing',
    });
    await startOptions(doc, deps);
    expect((doc.getElementById('gemini-api-key') as HTMLInputElement).value).toBe(
      'gemini-existing'
    );
    expect((doc.getElementById('ncbi-api-key') as HTMLInputElement).value).toBe('ncbi-existing');
    expect(doc.getElementById('options-status')?.textContent).toBe(
      'Gemini: 保存済み / NCBI: 保存済み'
    );
  });

  test('どちらも未設定なら status に「未設定」と 3 req/s 注記が出る', async () => {
    const doc = buildDocument();
    const deps = readStoredValues({});
    await startOptions(doc, deps);
    const status = doc.getElementById('options-status')?.textContent ?? '';
    expect(status).toContain('Gemini: 未設定');
    expect(status).toContain('NCBI: 未設定（3 req/s 枠）');
  });

  test('Gemini だけ既存で NCBI 未設定の場合はそれぞれ別ラベルになる', async () => {
    const doc = buildDocument();
    const deps = readStoredValues({ [STORAGE_KEY_GEMINI]: 'g' });
    await startOptions(doc, deps);
    const status = doc.getElementById('options-status')?.textContent ?? '';
    expect(status).toContain('Gemini: 保存済み');
    expect(status).toContain('NCBI: 未設定');
  });

  test('「保存」ボタンで両キーが書き込まれ、ステータスが「保存しました」になる', async () => {
    const doc = buildDocument();
    const writeKey = jest.fn<Promise<void>, [string, string]>(async () => undefined);
    const deps: OptionsDeps = {
      readKey: jest.fn(async () => undefined),
      writeKey,
      removeKey: jest.fn(async () => undefined),
      openAppTab: jest.fn(),
    };
    await startOptions(doc, deps);
    (doc.getElementById('gemini-api-key') as HTMLInputElement).value = 'g-new';
    (doc.getElementById('ncbi-api-key') as HTMLInputElement).value = 'n-new';
    (doc.getElementById('save-keys') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeKey).toHaveBeenCalledWith(STORAGE_KEY_GEMINI, 'g-new');
    expect(writeKey).toHaveBeenCalledWith(STORAGE_KEY_NCBI, 'n-new');
    expect(doc.getElementById('options-status')?.textContent).toBe('保存しました。');
  });

  test('input が 1 つも無い DOM では空文字で write を呼ぶ（防御的フォールバック）', async () => {
    const doc = document.implementation.createHTMLDocument('empty');
    doc.body.innerHTML = '<button id="save-keys"></button>';
    const writeKey = jest.fn<Promise<void>, [string, string]>(async () => undefined);
    await startOptions(doc, {
      readKey: jest.fn(async () => undefined),
      writeKey,
      removeKey: jest.fn(async () => undefined),
      openAppTab: jest.fn(),
    });
    (doc.getElementById('save-keys') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeKey).toHaveBeenCalledWith(STORAGE_KEY_GEMINI, '');
    expect(writeKey).toHaveBeenCalledWith(STORAGE_KEY_NCBI, '');
  });

  test('DOM 要素が全く無くても例外にならない', async () => {
    const doc = document.implementation.createHTMLDocument('empty');
    const deps: OptionsDeps = {
      readKey: jest.fn(async () => 'x'),
      writeKey: jest.fn(async () => undefined),
      removeKey: jest.fn(async () => undefined),
      openAppTab: jest.fn(),
    };
    await expect(startOptions(doc, deps)).resolves.toBeUndefined();
  });

  test('pending フラグ立ち状態でも初期ステータスは通常表示（誘導文は出さない）', async () => {
    const doc = buildDocument();
    const deps: OptionsDeps = {
      readKey: jest.fn(async (key) =>
        key === STORAGE_KEY_PENDING_APP_TAB ? '1' : undefined
      ),
      writeKey: jest.fn(async () => undefined),
      removeKey: jest.fn(async () => undefined),
      openAppTab: jest.fn(),
    };
    await startOptions(doc, deps);
    const status = doc.getElementById('options-status')?.textContent ?? '';
    expect(status).toContain('Gemini: 未設定');
    expect(status).toContain('NCBI: 未設定');
  });

  test('pending フラグありで Gemini を保存するとフラグを畳みメインビューを開く', async () => {
    const doc = buildDocument();
    const readKey = jest.fn(async (key: string) =>
      key === STORAGE_KEY_PENDING_APP_TAB ? '1' : undefined
    );
    const removeKey = jest.fn<Promise<void>, [string]>(async () => undefined);
    const openAppTab = jest.fn();
    const deps: OptionsDeps = {
      readKey,
      writeKey: jest.fn(async () => undefined),
      removeKey,
      openAppTab,
    };
    await startOptions(doc, deps);
    (doc.getElementById('gemini-api-key') as HTMLInputElement).value = 'g-new';
    (doc.getElementById('save-keys') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removeKey).toHaveBeenCalledWith(STORAGE_KEY_PENDING_APP_TAB);
    expect(openAppTab).toHaveBeenCalledTimes(1);
    expect(doc.getElementById('options-status')?.textContent).toContain('戻ります');
  });

  test('pending フラグありでも Gemini が空のままなら保存のみでメインビューは開かない', async () => {
    const doc = buildDocument();
    const openAppTab = jest.fn();
    const removeKey = jest.fn<Promise<void>, [string]>(async () => undefined);
    const deps: OptionsDeps = {
      readKey: jest.fn(async (key) =>
        key === STORAGE_KEY_PENDING_APP_TAB ? '1' : undefined
      ),
      writeKey: jest.fn(async () => undefined),
      removeKey,
      openAppTab,
    };
    await startOptions(doc, deps);
    // gemini-api-key は空のまま保存
    (doc.getElementById('save-keys') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openAppTab).not.toHaveBeenCalled();
    expect(removeKey).not.toHaveBeenCalled();
    expect(doc.getElementById('options-status')?.textContent).toBe('保存しました。');
  });
});

describe('createChromeOptionsDeps', () => {
  function setChrome(storage: {
    get: (k: string) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
    remove?: (k: string) => Promise<void>;
  }): {
    tabsCreate: jest.Mock;
    getURL: jest.Mock;
  } {
    const tabsCreate = jest.fn();
    const getURL = jest.fn((p: string) => `chrome-extension://x/${p}`);
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      storage: { local: { remove: jest.fn().mockResolvedValue(undefined), ...storage } },
      tabs: { create: tabsCreate },
      runtime: { getURL },
    } as unknown as typeof chrome;
    return { tabsCreate, getURL };
  }

  test('readKey は storage.local.get の結果から文字列値を返す', async () => {
    setChrome({
      get: jest.fn().mockResolvedValue({ [STORAGE_KEY_GEMINI]: 'abc' }),
      set: jest.fn().mockResolvedValue(undefined),
    });
    const deps = createChromeOptionsDeps();
    await expect(deps.readKey(STORAGE_KEY_GEMINI)).resolves.toBe('abc');
  });

  test('readKey は文字列以外 (number 等) のとき undefined を返す', async () => {
    setChrome({
      get: jest.fn().mockResolvedValue({ [STORAGE_KEY_GEMINI]: 123 }),
      set: jest.fn().mockResolvedValue(undefined),
    });
    const deps = createChromeOptionsDeps();
    await expect(deps.readKey(STORAGE_KEY_GEMINI)).resolves.toBeUndefined();
  });

  test('writeKey は storage.local.set を正しいペイロードで呼ぶ', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    setChrome({
      get: jest.fn().mockResolvedValue({}),
      set,
    });
    const deps = createChromeOptionsDeps();
    await deps.writeKey(STORAGE_KEY_NCBI, 'xyz');
    expect(set).toHaveBeenCalledWith({ [STORAGE_KEY_NCBI]: 'xyz' });
  });

  test('removeKey は storage.local.remove を呼ぶ', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    setChrome({
      get: jest.fn().mockResolvedValue({}),
      set: jest.fn().mockResolvedValue(undefined),
      remove,
    });
    const deps = createChromeOptionsDeps();
    await deps.removeKey(STORAGE_KEY_PENDING_APP_TAB);
    expect(remove).toHaveBeenCalledWith(STORAGE_KEY_PENDING_APP_TAB);
  });

  test('openAppTab は app/app.html を tabs.create で開く', () => {
    const { tabsCreate, getURL } = setChrome({
      get: jest.fn().mockResolvedValue({}),
      set: jest.fn().mockResolvedValue(undefined),
    });
    const deps = createChromeOptionsDeps();
    deps.openAppTab();
    expect(getURL).toHaveBeenCalledWith('app/app.html');
    expect(tabsCreate).toHaveBeenCalledWith({ url: 'chrome-extension://x/app/app.html' });
  });
});
