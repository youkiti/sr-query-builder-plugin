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
    expect(store['llm.selectedModel']).toBe('gemini-3.5-flash');
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
    expect(store['llm.selectedModel']).toBe('gemini-3.5-flash');
    expect(container.querySelector('.settings__status')?.textContent).toContain(
      'Gemini プランを自動判定できませんでした'
    );
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
});
