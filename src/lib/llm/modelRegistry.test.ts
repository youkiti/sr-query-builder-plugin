import {
  BUILTIN_MODELS,
  DEFAULT_MODEL,
  LEGACY_DEFAULT_MODEL,
  resolveEffectiveModel,
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
  test('DEFAULT_MODEL は claude-opus-5-5', () => {
    expect(DEFAULT_MODEL).toBe('claude-opus-5-5');
  });

  test('BUILTIN_MODELS には Gemini モデルと OpenRouter モデルが含まれる', () => {
    expect(BUILTIN_MODELS.some((m) => m.id === 'gemini-2.0-flash')).toBe(true);
    expect(BUILTIN_MODELS.some((m) => m.id === 'gemini-3.5-flash')).toBe(true);
    expect(BUILTIN_MODELS.some((m) => m.id === 'gemini-3.5-flash-lite')).toBe(true);
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

test.each([
  ['claude-opus-5-5', 'anthropic'], ['claude-sonnet-5-5', 'anthropic'],
  ['claude-haiku-5-5', 'anthropic'], ['claude-foo', 'anthropic'],
  ['claude-org/foo', 'openrouter'], ['a/b', 'openrouter'], ['gemini-x', 'gemini'],
])('モデル %s は %s に解決する', (model, provider) => {
  expect(resolveProviderId(model)).toBe(provider);
});

test('Anthropic の組み込みモデルの表示名', () => {
  expect(BUILTIN_MODELS.filter((m) => m.provider === 'anthropic').map((m) => m.label))
    .toEqual(['Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 5.5']);
});

describe('resolveEffectiveModel', () => {
  test.each([undefined, null, ''])('保存モデル %s は登録済みキーから解決する', (saved) => {
    expect(resolveEffectiveModel(saved, { anthropic: 'a', gemini: 'g' })).toBe(DEFAULT_MODEL);
    expect(resolveEffectiveModel(saved, { anthropic: 'a' })).toBe(DEFAULT_MODEL);
    expect(resolveEffectiveModel(saved, { gemini: 'g' })).toBe(LEGACY_DEFAULT_MODEL);
    expect(resolveEffectiveModel(saved, {})).toBe(DEFAULT_MODEL);
    expect(resolveEffectiveModel(saved, { anthropic: '  ', gemini: ' g ' })).toBe(LEGACY_DEFAULT_MODEL);
    expect(resolveEffectiveModel(saved, { anthropic: null, gemini: '  ' })).toBe(DEFAULT_MODEL);
  });

  test.each(['gemini-3.5-flash', 'claude-sonnet-5-5', 'org/custom', '  '])(
    '保存モデル %s はキーに関係なくそのまま返す', (saved) => {
      for (const keys of [{}, { anthropic: 'a' }, { gemini: 'g' }, { anthropic: 'a', gemini: 'g' }]) {
        expect(resolveEffectiveModel(saved, keys)).toBe(saved);
      }
    }
  );
});
