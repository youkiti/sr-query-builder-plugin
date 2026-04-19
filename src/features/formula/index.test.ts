import * as mod from './index';

describe('features/formula index 再エクスポート', () => {
  test('assemble / repository の API が揃っている', () => {
    expect(typeof mod.assembleFormulaMd).toBe('function');
    expect(typeof mod.AssembleFormulaError).toBe('function');
    expect(typeof mod.appendFormulaVersion).toBe('function');
    expect(typeof mod.getLatestFormulaVersion).toBe('function');
  });
});
