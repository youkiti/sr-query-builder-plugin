import {
  buildMethodsTexts,
  getExtensionVersion,
  MODEL_PLACEHOLDER_EN,
  MODEL_PLACEHOLDER_JA,
  VERSION_PLACEHOLDER,
} from './methodsText';

describe('buildMethodsTexts', () => {
  test('model / version が揃っていれば両方の文に埋め込む', () => {
    const texts = buildMethodsTexts({ model: 'gemini-3.5-flash', version: '0.1.0' });
    expect(texts.en).toContain('(gemini-3.5-flash)');
    expect(texts.en).toContain('version 0.1.0');
    expect(texts.en).toContain('sr-query-builder-plugin');
    expect(texts.en).toContain('[Describe how the authors checked and revised the AI-generated drafts.]');
    expect(texts.ja).toContain('gemini-3.5-flash');
    expect(texts.ja).toContain('バージョン 0.1.0');
    expect(texts.ja).toContain('sr-query-builder-plugin');
    expect(texts.ja).toContain('［著者が AI の下書きをどう確かめ、直したかを記入］');
  });

  test('model が null ならプレースホルダを残す', () => {
    const texts = buildMethodsTexts({ model: null, version: '0.1.0' });
    expect(texts.en).toContain(MODEL_PLACEHOLDER_EN);
    expect(texts.ja).toContain(MODEL_PLACEHOLDER_JA);
  });

  test('version が null ならプレースホルダを残す', () => {
    const texts = buildMethodsTexts({ model: 'gemini-3.5-flash', version: null });
    expect(texts.en).toContain(`version ${VERSION_PLACEHOLDER}`);
    expect(texts.ja).toContain(`バージョン ${VERSION_PLACEHOLDER}`);
  });
});

describe('getExtensionVersion', () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  test('chrome API が無い環境では null', () => {
    expect(getExtensionVersion()).toBeNull();
  });

  test('manifest の version を返す', () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { getManifest: () => ({ version: '0.1.0' }) },
    };
    expect(getExtensionVersion()).toBe('0.1.0');
  });

  test('version が空文字なら null', () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { getManifest: () => ({ version: '' }) },
    };
    expect(getExtensionVersion()).toBeNull();
  });

  test('getManifest が例外を投げても null', () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        getManifest: () => {
          throw new Error('not available');
        },
      },
    };
    expect(getExtensionVersion()).toBeNull();
  });
});

test('保存版の拡張バージョンを優先し、寄与したモデルを和文・英文に列挙する', () => {
  const texts = buildMethodsTexts({ model: 'legacy', version: '9.0.0', appVersion: '1.2.3', modelsUsed: 'model-a;model-b' });
  expect(texts.en).toContain('(model-a, model-b)');
  expect(texts.ja).toContain('（model-a、model-b）');
  expect(texts.en).toContain('version 1.2.3');
  expect(texts.ja).toContain('バージョン 1.2.3');
  expect(texts.en).not.toContain('9.0.0');
  expect(texts.en).toContain('[Describe how the authors checked and revised the AI-generated drafts.]');
});
