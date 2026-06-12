import {
  STORAGE_KEY_GEMINI,
  STORAGE_KEY_OPENROUTER,
  STORAGE_KEY_LLM_MODEL,
  STORAGE_KEY_CUSTOM_MODELS,
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
      <div id="gemini-card"></div>
      <input id="gemini-api-key" />
      <div id="openrouter-card"></div>
      <input id="openrouter-api-key" />
      <input id="custom-model-id" />
      <input id="custom-model-label" />
      <button id="add-custom-model"></button>
      <div id="custom-models-list"></div>
      <select id="llm-model-select"></select>
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

  test('全キーが既存なら input を復元し、status に「保存済み」を並べる', async () => {
    const doc = buildDocument();
    const deps = readStoredValues({
      [STORAGE_KEY_GEMINI]: 'gemini-existing',
      [STORAGE_KEY_OPENROUTER]: 'openrouter-existing',
      [STORAGE_KEY_NCBI]: 'ncbi-existing',
    });
    await startOptions(doc, deps);
    expect((doc.getElementById('gemini-api-key') as HTMLInputElement).value).toBe(
      'gemini-existing'
    );
    expect((doc.getElementById('openrouter-api-key') as HTMLInputElement).value).toBe(
      'openrouter-existing'
    );
    expect((doc.getElementById('ncbi-api-key') as HTMLInputElement).value).toBe('ncbi-existing');
    expect(doc.getElementById('options-status')?.textContent).toBe(
      'Gemini: 保存済み / OpenRouter: 保存済み / NCBI: 保存済み'
    );
  });

  test('どれも未設定なら status に Gemini / OpenRouter / NCBI の「未設定」が出る', async () => {
    const doc = buildDocument();
    const deps = readStoredValues({});
    await startOptions(doc, deps);
    const status = doc.getElementById('options-status')?.textContent ?? '';
    expect(status).toContain('Gemini: 未設定');
    expect(status).toContain('OpenRouter: 未設定');
    expect(status).toContain('NCBI: 未設定（3 req/s 枠）');
  });

  test('Gemini だけ既存で他が未設定の場合はそれぞれ別ラベルになる', async () => {
    const doc = buildDocument();
    const deps = readStoredValues({ [STORAGE_KEY_GEMINI]: 'g' });
    await startOptions(doc, deps);
    const status = doc.getElementById('options-status')?.textContent ?? '';
    expect(status).toContain('Gemini: 保存済み');
    expect(status).toContain('OpenRouter: 未設定');
    expect(status).toContain('NCBI: 未設定');
  });

  test('モデルセレクトにはビルトインモデルが optgroup で並ぶ', async () => {
    const doc = buildDocument();
    const deps = readStoredValues({});
    await startOptions(doc, deps);
    const select = doc.getElementById('llm-model-select') as HTMLSelectElement;
    const optionValues = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(optionValues).toContain('gemini-3.5-flash');
    expect(optionValues).toContain('qwen/qwen3-235b-a22b-2507');
    expect(optionValues).toContain('deepseek/deepseek-v4-flash');
    const groups = Array.from(select.querySelectorAll('optgroup')).map((g) => g.label);
    expect(groups).toContain('Gemini');
    expect(groups).toContain('OpenRouter');
  });

  test('既定のモデル（Gemini）が選択されていると Gemini カードが active', async () => {
    const doc = buildDocument();
    const deps = readStoredValues({});
    await startOptions(doc, deps);
    expect(
      doc.getElementById('gemini-card')?.classList.contains('options__provider-card--active')
    ).toBe(true);
    expect(
      doc.getElementById('openrouter-card')?.classList.contains('options__provider-card--active')
    ).toBe(false);
  });

  test('OpenRouter モデルが選択保存済みなら OpenRouter カードが active', async () => {
    const doc = buildDocument();
    const deps = readStoredValues({
      [STORAGE_KEY_LLM_MODEL]: 'qwen/qwen3-235b-a22b-2507',
    });
    await startOptions(doc, deps);
    expect(
      doc.getElementById('openrouter-card')?.classList.contains('options__provider-card--active')
    ).toBe(true);
    expect(
      doc.getElementById('gemini-card')?.classList.contains('options__provider-card--active')
    ).toBe(false);
  });

  test('モデルセレクト変更で選択モデルが保存されカードが切り替わる', async () => {
    const doc = buildDocument();
    const writeKey = jest.fn<Promise<void>, [string, string]>(async () => undefined);
    const deps: OptionsDeps = {
      readKey: jest.fn(async () => undefined),
      writeKey,
      removeKey: jest.fn(async () => undefined),
      openAppTab: jest.fn(),
    };
    await startOptions(doc, deps);
    const select = doc.getElementById('llm-model-select') as HTMLSelectElement;
    select.value = 'qwen/qwen3-235b-a22b-2507';
    select.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeKey).toHaveBeenCalledWith(STORAGE_KEY_LLM_MODEL, 'qwen/qwen3-235b-a22b-2507');
    expect(
      doc.getElementById('openrouter-card')?.classList.contains('options__provider-card--active')
    ).toBe(true);
  });

  test('「保存」ボタンで全キーとモデルが書き込まれ、ステータスが「保存しました」になる', async () => {
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
    (doc.getElementById('openrouter-api-key') as HTMLInputElement).value = 'or-new';
    (doc.getElementById('ncbi-api-key') as HTMLInputElement).value = 'n-new';
    (doc.getElementById('save-keys') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeKey).toHaveBeenCalledWith(STORAGE_KEY_GEMINI, 'g-new');
    expect(writeKey).toHaveBeenCalledWith(STORAGE_KEY_OPENROUTER, 'or-new');
    expect(writeKey).toHaveBeenCalledWith(STORAGE_KEY_NCBI, 'n-new');
    expect(writeKey).toHaveBeenCalledWith(STORAGE_KEY_LLM_MODEL, 'gemini-3.5-flash');
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
    expect(writeKey).toHaveBeenCalledWith(STORAGE_KEY_OPENROUTER, '');
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
      readKey: jest.fn(async (key) => (key === STORAGE_KEY_PENDING_APP_TAB ? '1' : undefined)),
      writeKey: jest.fn(async () => undefined),
      removeKey: jest.fn(async () => undefined),
      openAppTab: jest.fn(),
    };
    await startOptions(doc, deps);
    const status = doc.getElementById('options-status')?.textContent ?? '';
    expect(status).toContain('Gemini: 未設定');
    expect(status).toContain('OpenRouter: 未設定');
    expect(status).toContain('NCBI: 未設定');
  });

  test('pending フラグありで Gemini モデル選択時に Gemini キーを保存するとメインビューを開く', async () => {
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
    // デフォルトモデルは Gemini
    (doc.getElementById('gemini-api-key') as HTMLInputElement).value = 'g-new';
    (doc.getElementById('save-keys') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removeKey).toHaveBeenCalledWith(STORAGE_KEY_PENDING_APP_TAB);
    expect(openAppTab).toHaveBeenCalledTimes(1);
    expect(doc.getElementById('options-status')?.textContent).toContain('戻ります');
  });

  test('pending フラグありで OpenRouter モデル選択時に OpenRouter キーを保存するとメインビューを開く', async () => {
    const doc = buildDocument();
    const readKey = jest.fn(async (key: string) => {
      if (key === STORAGE_KEY_PENDING_APP_TAB) return '1';
      if (key === STORAGE_KEY_LLM_MODEL) return 'qwen/qwen3-235b-a22b-2507';
      return undefined;
    });
    const removeKey = jest.fn<Promise<void>, [string]>(async () => undefined);
    const openAppTab = jest.fn();
    const deps: OptionsDeps = {
      readKey,
      writeKey: jest.fn(async () => undefined),
      removeKey,
      openAppTab,
    };
    await startOptions(doc, deps);
    (doc.getElementById('openrouter-api-key') as HTMLInputElement).value = 'or-new';
    (doc.getElementById('save-keys') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removeKey).toHaveBeenCalledWith(STORAGE_KEY_PENDING_APP_TAB);
    expect(openAppTab).toHaveBeenCalledTimes(1);
  });

  test('pending フラグありでも選択プロバイダのキーが空ならメインビューは開かない', async () => {
    const doc = buildDocument();
    const openAppTab = jest.fn();
    const removeKey = jest.fn<Promise<void>, [string]>(async () => undefined);
    const deps: OptionsDeps = {
      readKey: jest.fn(async (key) => (key === STORAGE_KEY_PENDING_APP_TAB ? '1' : undefined)),
      writeKey: jest.fn(async () => undefined),
      removeKey,
      openAppTab,
    };
    await startOptions(doc, deps);
    // gemini-api-key は空のまま保存（デフォルトは Gemini モデル）
    (doc.getElementById('save-keys') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openAppTab).not.toHaveBeenCalled();
    expect(removeKey).not.toHaveBeenCalled();
    expect(doc.getElementById('options-status')?.textContent).toBe('保存しました。');
  });

  test('カスタムモデル ID に "/" が無いとエラー表示され追加されない', async () => {
    const doc = buildDocument();
    const writeKey = jest.fn<Promise<void>, [string, string]>(async () => undefined);
    const deps: OptionsDeps = {
      readKey: jest.fn(async () => undefined),
      writeKey,
      removeKey: jest.fn(async () => undefined),
      openAppTab: jest.fn(),
    };
    await startOptions(doc, deps);
    (doc.getElementById('custom-model-id') as HTMLInputElement).value = 'invalidmodel';
    (doc.getElementById('add-custom-model') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeKey).not.toHaveBeenCalledWith(STORAGE_KEY_CUSTOM_MODELS, expect.anything());
    expect(doc.getElementById('options-status')?.textContent).toContain('provider/model-name');
  });

  test('有効なカスタムモデルを追加するとリストとセレクトに現れる', async () => {
    const doc = buildDocument();
    const store: Record<string, string> = {};
    const deps: OptionsDeps = {
      readKey: jest.fn(async (key) => store[key]),
      writeKey: jest.fn(async (key, value) => {
        store[key] = value;
      }),
      removeKey: jest.fn(async () => undefined),
      openAppTab: jest.fn(),
    };
    await startOptions(doc, deps);
    (doc.getElementById('custom-model-id') as HTMLInputElement).value = 'meta-llama/llama-3.3-70b';
    (doc.getElementById('custom-model-label') as HTMLInputElement).value = 'Llama 3.3';
    (doc.getElementById('add-custom-model') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store[STORAGE_KEY_CUSTOM_MODELS]).toBeDefined();
    expect(JSON.parse(store[STORAGE_KEY_CUSTOM_MODELS] ?? '[]')).toEqual([
      { id: 'meta-llama/llama-3.3-70b', label: 'Llama 3.3' },
    ]);
    const listText = doc.getElementById('custom-models-list')?.textContent ?? '';
    expect(listText).toContain('meta-llama/llama-3.3-70b');
    const select = doc.getElementById('llm-model-select') as HTMLSelectElement;
    const optionValues = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(optionValues).toContain('meta-llama/llama-3.3-70b');
  });

  test('カスタムモデルを削除するとリストとセレクトから消える', async () => {
    const doc = buildDocument();
    const store: Record<string, string> = {
      [STORAGE_KEY_CUSTOM_MODELS]: JSON.stringify([{ id: 'meta-llama/llama-3.3-70b' }]),
    };
    const deps: OptionsDeps = {
      readKey: jest.fn(async (key) => store[key]),
      writeKey: jest.fn(async (key, value) => {
        store[key] = value;
      }),
      removeKey: jest.fn(async () => undefined),
      openAppTab: jest.fn(),
    };
    await startOptions(doc, deps);
    let listText = doc.getElementById('custom-models-list')?.textContent ?? '';
    expect(listText).toContain('meta-llama/llama-3.3-70b');
    const removeBtn = doc
      .getElementById('custom-models-list')
      ?.querySelector('button') as HTMLButtonElement;
    removeBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(store[STORAGE_KEY_CUSTOM_MODELS] ?? '[]')).toEqual([]);
    listText = doc.getElementById('custom-models-list')?.textContent ?? '';
    expect(listText).not.toContain('meta-llama/llama-3.3-70b');
    const select = doc.getElementById('llm-model-select') as HTMLSelectElement;
    const optionValues = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(optionValues).not.toContain('meta-llama/llama-3.3-70b');
  });

  test('ストレージキー定数がエクスポートされている', () => {
    expect(STORAGE_KEY_OPENROUTER).toBe('apiKeys.openrouter');
    expect(STORAGE_KEY_LLM_MODEL).toBe('llm.selectedModel');
    expect(STORAGE_KEY_CUSTOM_MODELS).toBe('llm.customModels');
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
