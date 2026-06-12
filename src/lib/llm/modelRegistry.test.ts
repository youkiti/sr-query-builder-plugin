import {
  BUILTIN_MODELS,
  DEFAULT_MODEL,
  MAX_CUSTOM_MODELS,
  resolveProviderId,
} from './modelRegistry';

describe('resolveProviderId', () => {
  test('組み込みの Gemini モデルは gemini', () => {
    expect(resolveProviderId('gemini-3.5-flash')).toBe('gemini');
  });

  test('組み込みの OpenRouter モデルは openrouter', () => {
    expect(resolveProviderId('qwen/qwen3-235b-a22b-2507')).toBe('openrouter');
  });

  test('カスタム（/ を含む）モデルは openrouter', () => {
    expect(resolveProviderId('meta-llama/llama-3.3-70b')).toBe('openrouter');
  });

  test('未知（/ を含まない）モデルは gemini', () => {
    expect(resolveProviderId('some-unknown-model')).toBe('gemini');
  });
});

describe('modelRegistry の定数', () => {
  test('DEFAULT_MODEL は gemini-3.5-flash', () => {
    expect(DEFAULT_MODEL).toBe('gemini-3.5-flash');
  });

  test('BUILTIN_MODELS には Gemini モデルと OpenRouter モデルが含まれる', () => {
    expect(BUILTIN_MODELS.some((m) => m.id === 'gemini-2.0-flash')).toBe(true);
    expect(BUILTIN_MODELS.some((m) => m.id === 'gemini-3.5-flash')).toBe(true);
    expect(BUILTIN_MODELS.some((m) => m.provider === 'openrouter')).toBe(true);
  });

  test('gemini-2.0-flash は freeTier フラグが true', () => {
    const model = BUILTIN_MODELS.find((m) => m.id === 'gemini-2.0-flash');
    expect(model?.freeTier).toBe(true);
  });

  test('MAX_CUSTOM_MODELS は 20', () => {
    expect(MAX_CUSTOM_MODELS).toBe(20);
  });
});
