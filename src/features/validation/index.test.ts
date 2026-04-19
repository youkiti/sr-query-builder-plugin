import * as mod from './index';

describe('features/validation index 再エクスポート', () => {
  test('主要 API が揃っている', () => {
    expect(typeof mod.expandFormula).toBe('function');
    expect(typeof mod.checkSearchLines).toBe('function');
    expect(typeof mod.checkFinalQuery).toBe('function');
    expect(typeof mod.extractMeshForSeeds).toBe('function');
    expect(typeof mod.aggregateMeshFrequency).toBe('function');
    expect(typeof mod.appendValidationLog).toBe('function');
  });
});
