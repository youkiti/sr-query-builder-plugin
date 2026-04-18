import { GeminiProvider } from './GeminiProvider';
import { createProvider } from './providerFactory';

describe('createProvider', () => {
  test('gemini を選ぶと GeminiProvider が返る', () => {
    const provider = createProvider({ provider: 'gemini', apiKey: 'k' });
    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(provider.providerId).toBe('gemini');
  });

  test('model / fetch オプションを渡せる', () => {
    const fetchMock = jest.fn() as unknown as typeof fetch;
    const provider = createProvider({
      provider: 'gemini',
      apiKey: 'k',
      model: 'gemini-2.5-flash',
      fetch: fetchMock,
    });
    expect(provider.model).toBe('gemini-2.5-flash');
  });
});
