import { AnthropicProvider } from './AnthropicProvider';
import { GeminiProvider } from './GeminiProvider';
import { OpenRouterProvider } from './OpenRouterProvider';
import { createProvider } from './providerFactory';

describe('createProvider', () => {
  test('provider: gemini を明示すると GeminiProvider が返る（後方互換）', () => {
    const provider = createProvider({ provider: 'gemini', apiKey: 'k' });
    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(provider.providerId).toBe('gemini');
  });

  test('provider: openrouter を明示すると OpenRouterProvider が返る', () => {
    const provider = createProvider({
      provider: 'openrouter',
      apiKey: 'k',
      model: 'qwen/qwen3-235b-a22b-2507',
    });
    expect(provider).toBeInstanceOf(OpenRouterProvider);
    expect(provider.providerId).toBe('openrouter');
    expect(provider.model).toBe('qwen/qwen3-235b-a22b-2507');
  });

  test('provider 省略時は model から openrouter を自動解決する', () => {
    const provider = createProvider({ apiKey: 'k', model: 'qwen/qwen3-235b-a22b-2507' });
    expect(provider).toBeInstanceOf(OpenRouterProvider);
    expect(provider.providerId).toBe('openrouter');
  });

  test('provider 省略時は model から gemini を自動解決する', () => {
    const provider = createProvider({ apiKey: 'k', model: 'gemini-3.5-flash' });
    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(provider.providerId).toBe('gemini');
  });

  test('model も provider も省略すると DEFAULT_MODEL の AnthropicProvider が返る', () => {
    const provider = createProvider({ apiKey: 'k' });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.providerId).toBe('anthropic');
    expect(provider.model).toBe('claude-opus-5-5');
  });

  test('model / fetch オプションを渡せる', () => {
    const fetchMock = jest.fn() as unknown as typeof fetch;
    const provider = createProvider({
      provider: 'gemini',
      apiKey: 'k',
      model: 'gemini-3.5-flash',
      fetch: fetchMock,
    });
    expect(provider.model).toBe('gemini-3.5-flash');
  });

  test('明示した model 文字列はそのまま GeminiProvider へ渡る（pass-through）', () => {
    const provider = createProvider({
      provider: 'gemini',
      apiKey: 'k',
      model: 'gemini-2.5-flash',
    });
    expect(provider.model).toBe('gemini-2.5-flash');
  });
});

test.each([undefined, 'anthropic'] as const)('Anthropic の解決と effort の引き渡し: %s', async (provider) => {
  const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  const result = createProvider({ provider, apiKey: 'test-key', model: 'claude-opus-5-5', fetch, effort: 'max' });
  expect(result).toBeInstanceOf(AnthropicProvider);
  await result.chat([]);
  expect(JSON.parse(fetch.mock.calls[0][1].body).output_config).toEqual({ effort: 'max' });
});
