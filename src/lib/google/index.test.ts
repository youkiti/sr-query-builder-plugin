import * as mod from './index';

describe('lib/google index 再エクスポート', () => {
  test('主要 API が揃っている', () => {
    expect(typeof mod.googleFetch).toBe('function');
    expect(typeof mod.GoogleApiError).toBe('function');
    expect(typeof mod.createChromeAuthDeps).toBe('function');
    expect(typeof mod.getAccessToken).toBe('function');
    expect(typeof mod.refreshAccessToken).toBe('function');
    expect(typeof mod.createChromeProfileDeps).toBe('function');
    expect(typeof mod.getCurrentUserEmail).toBe('function');
    expect(typeof mod.createSpreadsheet).toBe('function');
    expect(typeof mod.writeHeaderRow).toBe('function');
    expect(typeof mod.appendRow).toBe('function');
    expect(typeof mod.getSheetValues).toBe('function');
    expect(typeof mod.createFolder).toBe('function');
    expect(typeof mod.ensureChildFolder).toBe('function');
    expect(typeof mod.uploadTextFile).toBe('function');
    expect(typeof mod.getFileText).toBe('function');
  });
});
