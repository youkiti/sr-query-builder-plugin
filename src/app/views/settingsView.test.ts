import { createSettingsView, type SettingsViewCallbacks } from './settingsView';
import type { ViewContext } from './types';
import type { AppState } from '../store';

describe('createSettingsView - Gemini プラン判定', () => {
  function buildCtx(): ViewContext {
    return {
      state: {} as AppState,
      navigate: jest.fn(),
    };
  }

  function buildDeps(
    store: Record<string, string>,
    detectGeminiTier?: jest.Mock
  ): SettingsViewCallbacks {
    return {
      readKey: jest.fn(async (key: string) => store[key]),
      writeKey: jest.fn(async (key: string, value: string) => {
        store[key] = value;
      }),
      removeKey: jest.fn(async (key: string) => {
        delete store[key];
      }),
      detectGeminiTier,
    };
  }

  async function flush(times = 3): Promise<void> {
    for (let i = 0; i < times; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  function render(deps: SettingsViewCallbacks): HTMLElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    createSettingsView(deps)(container, buildCtx());
    return container;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  test.each([
    ['a', '', 'claude-opus-5-5'],
    ['', 'g', 'gemini-3.5-flash-lite'],
    ['a', 'g', 'claude-opus-5-5'],
    ['', '', 'claude-opus-5-5'],
  ])('モデル未保存の初期表示: Anthropic=%s Gemini=%s → %s', async (anthropic, gemini, model) => {
    const store: Record<string, string> = { 'apiKeys.anthropic': anthropic, 'apiKeys.gemini': gemini };
    const deps = buildDeps(store, jest.fn(async () => 'paid' as const));
    const container = render(deps);
    await flush();
    expect((container.querySelector('#settings-llm-model') as HTMLSelectElement).value).toBe(model);
    expect(deps.writeKey).not.toHaveBeenCalledWith('llm.selectedModel', expect.anything());
  });

  test.each([
    ['gemini-3.5-flash', '', '', 'gemini-3.5-flash'],
    ['qwen/qwen3-235b-a22b-2507', 'a', 'g', 'qwen/qwen3-235b-a22b-2507'],
    [undefined, '', '', undefined],
    ['', '  ', '  ', undefined],
    [undefined, '', 'g', 'gemini-3.5-flash-lite'],
    [undefined, 'a', '', 'claude-opus-5-5'],
    [undefined, 'a', 'g', 'claude-opus-5-5'],
  ])('保存モデル=%s 入力 Anthropic=%s Gemini=%s → %s', async (saved, anthropic, gemini, model) => {
    const store: Record<string, string> = { 'apiKeys.openrouter': 'or' };
    if (saved !== undefined) store['llm.selectedModel'] = saved;
    const deps = buildDeps(store, jest.fn(async () => 'paid' as const));
    const container = render(deps);
    await flush();
    const select = container.querySelector('#settings-llm-model') as HTMLSelectElement;
    const initialModel = select.value;
    (container.querySelector('#settings-anthropic-key') as HTMLInputElement).value = anthropic;
    (container.querySelector('#settings-gemini-key') as HTMLInputElement).value = gemini;
    (container.querySelector('#settings-save') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (model === undefined) {
      expect(deps.writeKey).not.toHaveBeenCalledWith('llm.selectedModel', expect.anything());
      expect(select.value).toBe(initialModel);
    } else {
      expect(deps.writeKey).toHaveBeenCalledWith('llm.selectedModel', model);
      expect(select.value).toBe(model);
      const provider = model.includes('/') ? 'openrouter' : model.startsWith('claude-') ? 'anthropic' : 'gemini';
      expect(container.querySelector(`#settings-${provider}-card`)?.classList.contains('settings__provider-card--active')).toBe(true);
    }
  });

  test('使用モデルのラベルの外にベンチマークへのリンクがある', async () => {
    const container = render(buildDeps({}));
    await flush();
    const link = container.querySelector('.settings__help-link') as HTMLAnchorElement;
    expect(link.textContent).toBe('?');
    expect(link.href).toBe('https://github.com/youkiti/sr-query-builder-plugin#benchmark');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noreferrer');
    expect(link.getAttribute('aria-label')).toBe('モデルごとの成績（ベンチマーク）を GitHub の README で開く');
    expect(link.title).toBe(link.getAttribute('aria-label'));
    expect(link.closest('label')).toBeNull();
    const label = container.querySelector('label[for="settings-llm-model"]') as HTMLLabelElement;
    expect(label.control).toBe(container.querySelector('#settings-llm-model'));
  });

  test('保存済み tier があれば描画時にバッジへ復元され、再判定はしない', async () => {
    const detect = jest.fn(async () => 'free' as const);
    const container = render(
      buildDeps({ 'apiKeys.gemini': 'saved-key', 'gemini.detectedTier': 'paid' }, detect)
    );
    await flush();
    const badge = container.querySelector('#settings-gemini-tier-badge');
    expect(badge?.textContent).toBe('有料プラン');
    expect(badge?.classList.contains('settings__tier-badge--paid')).toBe(true);
    expect(detect).not.toHaveBeenCalled();
  });

  test('キー保存済みで tier 未保存なら描画時に自動判定してバッジ表示・永続化する', async () => {
    const store: Record<string, string> = { 'apiKeys.gemini': 'legacy-key' };
    const detect = jest.fn(async () => 'paid' as const);
    const container = render(buildDeps(store, detect));
    await flush();
    expect(detect).toHaveBeenCalledWith('legacy-key');
    const badge = container.querySelector('#settings-gemini-tier-badge');
    expect(badge?.textContent).toBe('有料プラン');
    expect(store['gemini.detectedTier']).toBe('paid');
  });

  test('描画時の自動判定が unknown ならバッジは空のままで永続化もしない', async () => {
    const store: Record<string, string> = { 'apiKeys.gemini': 'legacy-key' };
    const detect = jest.fn(async () => 'unknown' as const);
    const container = render(buildDeps(store, detect));
    await flush();
    const badge = container.querySelector('#settings-gemini-tier-badge');
    expect(badge?.textContent).toBe('');
    expect(store['gemini.detectedTier']).toBeUndefined();
  });

  test('キー未保存なら描画時の自動判定は走らない', async () => {
    const detect = jest.fn(async () => 'paid' as const);
    render(buildDeps({}, detect));
    await flush();
    expect(detect).not.toHaveBeenCalled();
  });

  test('無料プラン検出時: 保存でバッジが無料プランになりモデルが gemini-2.0-flash に切り替わる', async () => {
    const store: Record<string, string> = {};
    const detect = jest.fn(async () => 'free' as const);
    const container = render(buildDeps(store, detect));
    await flush();
    const input = container.querySelector('#settings-gemini-key') as HTMLInputElement;
    input.value = 'free-key';
    (container.querySelector('#settings-save') as HTMLButtonElement).click();
    await flush();
    expect(detect).toHaveBeenCalledWith('free-key');
    const badge = container.querySelector('#settings-gemini-tier-badge');
    expect(badge?.textContent).toBe('無料プラン');
    expect(store['llm.selectedModel']).toBe('gemini-2.0-flash');
    expect(store['gemini.detectedTier']).toBe('free');
    expect(
      (container.querySelector('#settings-llm-model') as HTMLSelectElement).value
    ).toBe('gemini-2.0-flash');
    const status = container.querySelector('.settings__status');
    expect(status?.textContent).toContain('Gemini 2.0 Flash');
  });

  test('有料プラン検出時: 保存でバッジが有料プランになりモデルは変わらない', async () => {
    const store: Record<string, string> = {};
    const detect = jest.fn(async () => 'paid' as const);
    const container = render(buildDeps(store, detect));
    await flush();
    const input = container.querySelector('#settings-gemini-key') as HTMLInputElement;
    input.value = 'paid-key';
    (container.querySelector('#settings-save') as HTMLButtonElement).click();
    await flush();
    const badge = container.querySelector('#settings-gemini-tier-badge');
    expect(badge?.textContent).toBe('有料プラン');
    expect(store['llm.selectedModel']).toBe('gemini-3.5-flash-lite');
    expect(store['gemini.detectedTier']).toBe('paid');
    expect(container.querySelector('.settings__status')?.textContent).toBe('保存しました。');
  });

  test('保存時に判定が unknown ならモデルを変えず判定不能をステータスに明示する', async () => {
    const store: Record<string, string> = {};
    const detect = jest.fn(async () => 'unknown' as const);
    const container = render(buildDeps(store, detect));
    await flush();
    const input = container.querySelector('#settings-gemini-key') as HTMLInputElement;
    input.value = 'some-key';
    (container.querySelector('#settings-save') as HTMLButtonElement).click();
    await flush();
    expect(store['llm.selectedModel']).toBe('gemini-3.5-flash-lite');
    expect(container.querySelector('.settings__status')?.textContent).toContain(
      'Gemini プランを自動判定できませんでした'
    );
  });

  test('保存時に判定が unavailable（混雑）ならモデルを変えず混雑中メッセージを出す', async () => {
    const store: Record<string, string> = {};
    const detect = jest.fn(async () => 'unavailable' as const);
    const container = render(buildDeps(store, detect));
    await flush();
    const input = container.querySelector('#settings-gemini-key') as HTMLInputElement;
    input.value = 'free-key';
    (container.querySelector('#settings-save') as HTMLButtonElement).click();
    await flush();
    expect(store['llm.selectedModel']).toBe('gemini-3.5-flash-lite');
    expect(store['gemini.detectedTier']).toBeUndefined();
    expect(container.querySelector('.settings__status')?.textContent).toContain('混雑中');
    expect(container.querySelector('#settings-gemini-tier-badge')?.textContent).toBe('');
  });

  test('キーを空にして保存すると tier がクリアされバッジが消える', async () => {
    const store: Record<string, string> = {
      'apiKeys.gemini': 'old-key',
      'gemini.detectedTier': 'paid',
    };
    const detect = jest.fn(async () => 'paid' as const);
    const container = render(buildDeps(store, detect));
    await flush();
    const input = container.querySelector('#settings-gemini-key') as HTMLInputElement;
    input.value = '';
    (container.querySelector('#settings-save') as HTMLButtonElement).click();
    await flush();
    expect(store['gemini.detectedTier']).toBeUndefined();
    const badge = container.querySelector('#settings-gemini-tier-badge');
    expect(badge?.textContent).toBe('');
  });

  test('OpenRouter モデル選択時は保存時のプラン確認が呼ばれない', async () => {
    const store: Record<string, string> = {
      'llm.selectedModel': 'qwen/qwen3-235b-a22b-2507',
    };
    const detect = jest.fn(async () => 'paid' as const);
    const container = render(buildDeps(store, detect));
    await flush();
    const input = container.querySelector('#settings-gemini-key') as HTMLInputElement;
    input.value = 'some-key';
    (container.querySelector('#settings-save') as HTMLButtonElement).click();
    await flush();
    expect(detect).not.toHaveBeenCalled();
  });

  test('モデルセレクトに gemini-2.0-flash が含まれている', async () => {
    const container = render(buildDeps({}));
    await flush();
    const select = container.querySelector('#settings-llm-model') as HTMLSelectElement;
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(values).toContain('gemini-2.0-flash');
  });

  test('モデルセレクトに gemini-3.5-flash-lite が含まれている', async () => {
    const container = render(buildDeps({}));
    await flush();
    const select = container.querySelector('#settings-llm-model') as HTMLSelectElement;
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(values).toContain('gemini-3.5-flash-lite');
  });

  test('モデル未保存なら既定で claude-opus-5-5 が選択される', async () => {
    const container = render(buildDeps({}));
    await flush();
    const select = container.querySelector('#settings-llm-model') as HTMLSelectElement;
    expect(select.value).toBe('claude-opus-5-5');
  });

  test('既存モデルとして gemini-3.5-flash が保存済みなら選択値は維持され、保存しても書き換わらない', async () => {
    const store: Record<string, string> = { 'llm.selectedModel': 'gemini-3.5-flash' };
    const container = render(buildDeps(store));
    await flush();
    const select = container.querySelector('#settings-llm-model') as HTMLSelectElement;
    expect(select.value).toBe('gemini-3.5-flash');
    (container.querySelector('#settings-save') as HTMLButtonElement).click();
    await flush();
    expect(store['llm.selectedModel']).toBe('gemini-3.5-flash');
  });
});

describe('設定画面の Anthropic 設定', () => {
  test.each(['', 'saved-key'])('キーの保存・復元と pending の解除: %s', async (key) => {
    const store: Record<string, string> = { 'llm.selectedModel': 'claude-opus-5-5',
      'apiKeys.anthropic': key, pendingOpenAppTab: '1' };
    const deps: SettingsViewCallbacks = {
      readKey: async (k) => store[k], writeKey: async (k, v) => { store[k] = v; },
      removeKey: async (k) => { delete store[k]; }, detectGeminiTier: jest.fn(),
    };
    const ctx: ViewContext = { state: {} as AppState, navigate: jest.fn() };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
    try {
      createSettingsView(deps)(container, ctx);
      await flush();
      const input = container.querySelector<HTMLInputElement>('#settings-anthropic-key')!;
      expect(input.value).toBe(key);
      expect(input.type).toBe('password');
      expect(input.autocomplete).toBe('off');
      expect(container.querySelector('.settings__status')?.textContent).toContain(`Anthropic: ${key ? '保存済み' : '未設定'}`);
      expect(container.querySelector('#settings-anthropic-card')?.classList.contains('settings__provider-card--active')).toBe(true);
      expect(container.querySelectorAll('optgroup[label="Anthropic"] option')).toHaveLength(3);
      container.querySelector<HTMLButtonElement>('#settings-save')!.click();
      await flush();
      expect(ctx.navigate).toHaveBeenCalledTimes(key ? 1 : 0);
      input.value = 'updated-key';
      container.querySelector<HTMLButtonElement>('#settings-save')!.click();
      await flush();
      expect(store['apiKeys.anthropic']).toBe('updated-key');
      container.querySelector<HTMLInputElement>('#settings-custom-model-id')!.value = 'claude-custom';
      container.querySelector<HTMLButtonElement>('.settings__custom-model-form button')!.click();
      await flush();
      expect(container.querySelector('optgroup[label="Anthropic"] option[value="claude-custom"]')).not.toBeNull();
      createSettingsView(deps)(container, ctx);
      await flush();
      expect(container.querySelector<HTMLInputElement>('#settings-anthropic-key')!.value).toBe('updated-key');
    } finally { container.remove(); }
  });
});

test.each([['claude-foo', 'Anthropic', 'anthropic'], ['a/b', 'OpenRouter', 'openrouter'],
  ['claude-org/foo', 'OpenRouter', 'openrouter'], ['gemini-x', 'Google AI Studio', 'gemini']])(
  '設定画面のカスタムモデル %s のグループとカードが一致する', async (id, group, provider) => {
    const store: Record<string, string> = { 'llm.customModels': JSON.stringify([{ id, label: 'custom' }]),
      'llm.selectedModel': id };
    const container = document.createElement('div');
    document.body.appendChild(container);
    try {
      createSettingsView({ readKey: async (k) => store[k], writeKey: jest.fn(),
        removeKey: jest.fn(), detectGeminiTier: jest.fn() })(container, { state: {} as AppState, navigate: jest.fn() });
      await new Promise((r) => setTimeout(r, 0));
      expect(container.querySelector<HTMLSelectElement>('select')!.value).toBe(id);
      expect(container.querySelector(`optgroup[label="${group}"] option[value="${id}"]`)).not.toBeNull();
      expect(container.querySelector(`#settings-${provider}-card`)?.classList.contains('settings__provider-card--active')).toBe(true);
    } finally { container.remove(); }
  }
);
