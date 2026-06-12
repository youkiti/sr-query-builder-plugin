import * as mod from './index';

describe('lib/llm index 再エクスポート', () => {
  test('主要 API が揃っている', () => {
    expect(typeof mod.GeminiProvider).toBe('function');
    expect(typeof mod.OpenRouterProvider).toBe('function');
    expect(typeof mod.LlmProviderError).toBe('function');
    expect(typeof mod.createProvider).toBe('function');
    expect(typeof mod.withLogging).toBe('function');
    expect(typeof mod.buildPromptSummary).toBe('function');
    expect(typeof mod.resolveProviderId).toBe('function');
    expect(Array.isArray(mod.BUILTIN_MODELS)).toBe(true);
    expect(typeof mod.DEFAULT_MODEL).toBe('string');
  });
});
