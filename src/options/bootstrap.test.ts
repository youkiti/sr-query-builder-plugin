import { createChromeOptionsDeps, startOptions, type OptionsDeps } from './bootstrap';

describe('startOptions', () => {
  function buildDocument(): Document {
    const doc = document.implementation.createHTMLDocument('test');
    doc.body.innerHTML = `
      <p id="options-status"></p>
      <input id="gemini-api-key" />
      <button id="save-keys"></button>
    `;
    return doc;
  }

  test('既存キーがあれば input に復元し、ステータスを「保存済み」にする', async () => {
    const doc = buildDocument();
    const deps: OptionsDeps = {
      readKey: jest.fn().mockResolvedValue('existing-key'),
      writeKey: jest.fn().mockResolvedValue(undefined),
    };
    await startOptions(doc, deps);
    expect((doc.getElementById('gemini-api-key') as HTMLInputElement).value).toBe('existing-key');
    expect(doc.getElementById('options-status')?.textContent).toContain('保存済み');
  });

  test('既存キーがないときはステータスを「未設定」にする', async () => {
    const doc = buildDocument();
    const deps: OptionsDeps = {
      readKey: jest.fn().mockResolvedValue(undefined),
      writeKey: jest.fn().mockResolvedValue(undefined),
    };
    await startOptions(doc, deps);
    expect(doc.getElementById('options-status')?.textContent).toContain('未設定');
  });

  test('「保存」ボタンクリックで writeKey が呼ばれ、ステータスが更新される', async () => {
    const doc = buildDocument();
    const writeKey = jest.fn().mockResolvedValue(undefined);
    const deps: OptionsDeps = {
      readKey: jest.fn().mockResolvedValue(undefined),
      writeKey,
    };
    await startOptions(doc, deps);
    (doc.getElementById('gemini-api-key') as HTMLInputElement).value = 'new-key';
    (doc.getElementById('save-keys') as HTMLButtonElement).click();
    // writeKey は非同期なので 1 tick 待つ
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeKey).toHaveBeenCalledWith('apiKeys.gemini', 'new-key');
    expect(doc.getElementById('options-status')?.textContent).toContain('保存しました');
  });

  test('input が null でも writeKey は空文字で呼ばれる', async () => {
    const doc = document.implementation.createHTMLDocument('empty');
    doc.body.innerHTML = '<button id="save-keys"></button>';
    const writeKey = jest.fn().mockResolvedValue(undefined);
    await startOptions(doc, {
      readKey: jest.fn().mockResolvedValue(undefined),
      writeKey,
    });
    (doc.getElementById('save-keys') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeKey).toHaveBeenCalledWith('apiKeys.gemini', '');
  });

  test('DOM 要素が全く無くても例外にならない', async () => {
    const doc = document.implementation.createHTMLDocument('empty');
    const deps: OptionsDeps = {
      readKey: jest.fn().mockResolvedValue('x'),
      writeKey: jest.fn().mockResolvedValue(undefined),
    };
    await expect(startOptions(doc, deps)).resolves.toBeUndefined();
  });
});

describe('createChromeOptionsDeps', () => {
  function setChrome(storage: {
    get: (k: string) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
  }): void {
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      storage: { local: storage },
    } as unknown as typeof chrome;
  }

  test('readKey は storage.local.get の結果から値を返す', async () => {
    setChrome({
      get: jest.fn().mockResolvedValue({ 'apiKeys.gemini': 'abc' }),
      set: jest.fn().mockResolvedValue(undefined),
    });
    const deps = createChromeOptionsDeps();
    await expect(deps.readKey('apiKeys.gemini')).resolves.toBe('abc');
  });

  test('readKey は値が文字列でない場合 undefined を返す', async () => {
    setChrome({
      get: jest.fn().mockResolvedValue({ 'apiKeys.gemini': 123 }),
      set: jest.fn().mockResolvedValue(undefined),
    });
    const deps = createChromeOptionsDeps();
    await expect(deps.readKey('apiKeys.gemini')).resolves.toBeUndefined();
  });

  test('writeKey は storage.local.set を正しいペイロードで呼ぶ', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    setChrome({
      get: jest.fn().mockResolvedValue({}),
      set,
    });
    const deps = createChromeOptionsDeps();
    await deps.writeKey('apiKeys.gemini', 'xyz');
    expect(set).toHaveBeenCalledWith({ 'apiKeys.gemini': 'xyz' });
  });
});
