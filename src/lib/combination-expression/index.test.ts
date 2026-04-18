import * as mod from './index';

describe('lib/combination-expression index 再エクスポート', () => {
  test('主要 API が揃っている', () => {
    expect(typeof mod.tokenizeCombination).toBe('function');
    expect(typeof mod.validateParens).toBe('function');
    expect(typeof mod.validateGrammar).toBe('function');
    expect(typeof mod.validateReferences).toBe('function');
    expect(typeof mod.validateCombinationExpression).toBe('function');
    expect(typeof mod.normalizeCombinationExpression).toBe('function');
  });
});
