import * as mod from './index';

describe('features/conversion index 再エクスポート', () => {
  test('4 変換関数 + 一括関数がエクスポートされている', () => {
    expect(typeof mod.convertToCentral).toBe('function');
    expect(typeof mod.convertToDialog).toBe('function');
    expect(typeof mod.convertToClinicalTrials).toBe('function');
    expect(typeof mod.convertToIctrp).toBe('function');
    expect(typeof mod.convertToAllDatabases).toBe('function');
  });
});
