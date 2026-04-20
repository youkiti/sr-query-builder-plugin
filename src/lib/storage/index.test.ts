import * as mod from './index';

describe('lib/storage index 再エクスポート', () => {
  test('chromeStorage / secretsStore の主要 API が揃っている', () => {
    expect(typeof mod.createChromeStorageDeps).toBe('function');
    expect(typeof mod.readSecret).toBe('function');
    expect(typeof mod.writeSecret).toBe('function');
    expect(mod.SECRET_KEYS.gemini).toBe('apiKeys.gemini');
    expect(mod.SECRET_KEYS.ncbi).toBe('apiKeys.ncbi');
  });
});
