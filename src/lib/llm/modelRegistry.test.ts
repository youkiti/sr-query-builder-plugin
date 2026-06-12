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

  test('BUILTIN_MODELS は 3 件', () => {
    expect(BUILTIN_MODELS).toHaveLength(3);
  });

  test('MAX_CUSTOM_MODELS は 20', () => {
    expect(MAX_CUSTOM_MODELS).toBe(20);
  });
});
