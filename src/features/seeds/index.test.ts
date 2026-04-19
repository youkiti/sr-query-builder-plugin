import * as mod from './index';

describe('features/seeds index 再エクスポート', () => {
  test('主要 API が揃っている', () => {
    expect(typeof mod.parseNbib).toBe('function');
    expect(typeof mod.parseRis).toBe('function');
    expect(typeof mod.resolveRisEntry).toBe('function');
    expect(typeof mod.verifyPmids).toBe('function');
    expect(typeof mod.verifySinglePmid).toBe('function');
    expect(typeof mod.appendSeedPaper).toBe('function');
    expect(typeof mod.listSeedPapers).toBe('function');
    expect(typeof mod.hasValidSeedPmid).toBe('function');
  });
});
